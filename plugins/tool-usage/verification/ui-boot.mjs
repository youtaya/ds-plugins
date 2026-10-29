#!/usr/bin/env node
/**
 * Web UI integration check for `dsh-plugin-tool-usage` (DESIGN.md §5.4, §16).
 *
 * What it proves, in an isolated DSH home (never `~/.dsh`):
 *   1. the package installs into a fresh `web` profile and the composed profile
 *      contains the `tool-usage` row (`--dump-config`);
 *   2. the running Web server's boot graph advertises the package's browser half
 *      (`dsh.client`) with its `./client` bundle URL, `immediately: true`, and
 *      the declared inject edges;
 *   3. the served bundle is the package's `client.js` (it contains the module
 *      id and the three slot registrations).
 *
 * Requirements: `DSH_CHECKOUT` pointing at a DSH source checkout with its
 * dependencies installed (the same checkout the e2e harness uses), and `pnpm`
 * on PATH. No model credentials are needed: no task is run.
 *
 * Usage:
 *   DSH_CHECKOUT=/path/to/deepseek-harness node plugins/tool-usage/verification/ui-boot.mjs
 *   DSH_CHECKOUT=... node plugins/tool-usage/verification/ui-boot.mjs --keep
 *
 * Environment:
 *   UI_BOOT_HOME   isolated DSH_HOME (default `<workspace>/.tmp/ui-boot-home`)
 *   UI_BOOT_TIMEOUT_MS  server startup timeout (default 180000)
 *
 * Exit code: 0 only when every assertion passed.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(PLUGIN_DIR, '..', '..')
const PACKAGE_NAME = 'dsh-plugin-tool-usage'
const KEEP = process.argv.includes('--keep')

/** Assertion tally. */
let passed = 0
let failed = 0

/** Report one assertion. */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS ${label}`)
    return
  }
  failed += 1
  console.error(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Spawn one command and resolve with its exit status and captured output. */
function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolvePromise({ code, output }))
  })
}

/** Parse the first `globalThis["__DSH_BOOT__"] = {…}` object in an HTML page. */
function parseBootGraph(html) {
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  if (start < 0) return undefined
  let index = start + marker.length
  let depth = 0
  let inString = false
  let escaped = false
  for (; index < html.length; index += 1) {
    const char = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(html.slice(start + marker.length, index + 1))
    }
  }
  return undefined
}

/** Fetch the authorized page: follow the token redirect while keeping its cookie. */
async function fetchAuthorized(url) {
  const first = await fetch(url, { redirect: 'manual' })
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location')
    const cookie = first.headers.get('set-cookie')
    if (location === null) throw new Error(`redirect ${String(first.status)} without a location`)
    return fetch(new URL(location, url), {
      redirect: 'manual',
      headers: cookie === null ? {} : { cookie: cookie.split(';')[0] },
    })
  }
  return first
}

/** Bound server startup: resolve with the URL printed by the Web app. */
function waitForUrl(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`server did not print a URL within ${timeoutMs}ms\n${output}`)), timeoutMs)
    const onData = (chunk) => {
      output += chunk
      const match = /dsh web: (http:\/\/\S+)/.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolvePromise(match[1])
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
}

/** Stop the server: SIGTERM, then SIGKILL after a grace period. */
async function stopServer(child) {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise(resolvePromise => child.once('exit', resolvePromise))
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  await exited
  clearTimeout(timer)
}

const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined || checkout.trim().length === 0) {
  console.error('ui-boot: DSH_CHECKOUT must point at a DSH source checkout')
  process.exit(2)
}
const checkoutDir = resolve(checkout.trim())
if (!existsSync(join(checkoutDir, 'apps', 'cli', 'src', 'bin.ts'))) {
  console.error(`ui-boot: "${checkoutDir}" does not look like a DSH source checkout`)
  process.exit(2)
}

const home = resolve(process.env.UI_BOOT_HOME ?? join(WORKSPACE, '.tmp', 'ui-boot-home'))
const storeDir = join(WORKSPACE, '.tmp', 'ui-boot-store')
const cacheDir = join(WORKSPACE, '.tmp', 'ui-boot-cache')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
mkdirSync(storeDir, { recursive: true })
mkdirSync(cacheDir, { recursive: true })

const env = {
  ...process.env,
  DSH_HOME: home,
  npm_config_store_dir: storeDir,
  npm_config_cache: cacheDir,
  CI: '1',
}
const timeoutMs = Number(process.env.UI_BOOT_TIMEOUT_MS ?? 180_000)
let server
try {
  console.log(`ui-boot: isolated DSH_HOME ${home}`)
  console.log(`ui-boot: checkout ${checkoutDir}`)

  // 1. Initialize the web profile from the shipped template, then install this bundle.
  const dump = await run('pnpm', ['dsh', '--profile', 'web', '--dump-config'], { cwd: checkoutDir, env })
  check('fresh web profile composes', dump.code === 0, dump.output.slice(-2000))
  const install = await run('pnpm', ['dsh', 'plugin', '--profile', 'web', 'add', PLUGIN_DIR], { cwd: checkoutDir, env })
  check('bundle installs into the isolated web profile', install.code === 0, install.output.slice(-2000))
  const composed = await run('pnpm', ['dsh', '--profile', 'web', '--dump-config'], { cwd: checkoutDir, env })
  if (composed.code !== 0) check('composed profile dumps', false, composed.output.slice(-2000))
  else {
    check('composed profile contains the tool-usage row', composed.output.includes('# == dsh-plugin-tool-usage') && composed.output.includes('name: dsh-plugin-tool-usage'))
  }

  // 2. Boot the Web server and read the boot graph it serves.
  server = spawn('pnpm', ['dsh', '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: checkoutDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = await waitForUrl(server, timeoutMs)
  console.log(`ui-boot: server ${url}`)
  const page = await fetchAuthorized(url)
  const html = await page.text()
  check('authorized page is served', page.status === 200, `status ${String(page.status)}`)
  const graph = parseBootGraph(html)
  check('page carries a parseable client boot graph', graph !== undefined)
  const entry = Array.isArray(graph?.entries)
    ? graph.entries.find(candidate => candidate?.id === PACKAGE_NAME)
    : undefined
  check('boot graph lists the package client half', entry !== undefined)
  if (entry !== undefined) {
    check('client bundle URL points at the package ./client', typeof entry.url === 'string' && entry.url.includes(`${PACKAGE_NAME}/client.js`), String(entry.url))
    check('client half is prefetched immediately', entry.immediately === true)
    check('client half declares its activation edges', Array.isArray(entry.inject)
      && entry.inject.includes('@deepseek-ai/dsh-client-locale')
      && entry.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))

    // 3. Fetch the served module and prove it is the package's client half.
    const bundleUrl = new URL(entry.url, url)
    const cookie = page.headers.get('set-cookie')
    const bundleResponse = await fetch(bundleUrl, {
      headers: cookie === null ? {} : { cookie: cookie.split(';')[0] },
    })
    const bundle = await bundleResponse.text()
    check('served client bundle responds 200', bundleResponse.status === 200, `status ${String(bundleResponse.status)}`)
    check('served bundle carries the module-loader id', bundle.includes(`id: '${PACKAGE_NAME}'`))
    for (const slot of [
      'conversation.input.dock',
      'conversation.chat.turnTail',
      'conversation.view',
      'sidebar.right.pane.tab',
      'conversation.session.header.actions',
    ]) {
      check(`served bundle registers ${slot}`, bundle.includes(`'${slot}'`))
    }
    check('served bundle declares the right-Sidebar stream tab type', bundle.includes("'tool-usage-stream'") && bundle.includes("'dsh-plugin-tool-usage-stream'"))
    check('served bundle recommends the right-Sidebar activation edge', entry.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
    check('served bundle requires only React from the module table', !bundle.includes("require('@deepseek-ai/"))
  }
} catch (error) {
  check('ui-boot run completed without an unexpected error', false, error instanceof Error ? error.message : String(error))
} finally {
  await stopServer(server)
  if (!KEEP) {
    rmSync(home, { recursive: true, force: true })
    rmSync(storeDir, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

console.log(`\nui-boot: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
