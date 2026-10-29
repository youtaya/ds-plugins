#!/usr/bin/env node
/**
 * Build the tool-usage plugin (committed `lib/` output).
 *
 * TypeScript compiler resolution order:
 * 1. `node_modules/typescript` — the portable path: run `npm install` in this
 *    package (devDependencies) and the pinned compiler is used.
 * 2. `DSH_CHECKOUT` — a DSH source checkout with its own installed TypeScript
 *    (`<checkout>/node_modules/typescript`). No npm install is needed in that
 *    mode; the dev-only `node_modules` symlinks the type checker needs
 *    (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
 *    `@deepseek-ai/dsh-commands`, `@types/node`) are (re)created from the
 *    checkout, idempotently. Broken links are recreated, real installs are
 *    left untouched.
 * 3. Otherwise fail with an actionable message.
 *
 * Then: remove `lib/` (deterministic clean build), run `tsc -p tsconfig.json`
 * (no emit on failure), verify the package entry points were emitted, and
 * print a one-line success summary with the emitted line count.
 *
 * `node_modules/` is dev-only and gitignored; `lib/` is committed.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_TSC = path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** Dev-only symlinks: module specifier path inside node_modules → checkout package directory. */
const DEV_LINKS = [
  ['@deepseek-ai/cordis', path.join('vendor', 'cordis')],
  ['@deepseek-ai/dsh-tools', path.join('packages', 'core', 'tools')],
  ['@deepseek-ai/dsh-commands', path.join('packages', 'interaction', 'commands')],
  ['@types/node', path.join('node_modules', '@types', 'node')],
]

function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Locate the TypeScript compiler.
 * @returns {{tscPath: string, checkout: string}} the compiler plus the DSH
 *   checkout root when the compiler came from a checkout ('' for node_modules).
 */
function resolveCompiler() {
  if (fs.existsSync(LOCAL_TSC)) {
    return { tscPath: LOCAL_TSC, checkout: '' }
  }

  const fromEnv = typeof process.env.DSH_CHECKOUT === 'string' ? process.env.DSH_CHECKOUT.trim() : ''
  if (fromEnv.length === 0) {
    fail(
      'TypeScript compiler not found.\n'
      + `  - local path: ${LOCAL_TSC}\n`
      + '  - fix (portable): run `npm install` in this package, then retry `node scripts/build.mjs`\n'
      + '  - fix (DSH source checkout): set DSH_CHECKOUT to the checkout root and retry',
    )
  }
  const checkout = path.resolve(fromEnv)
  if (!isDirectory(checkout)) {
    fail(`DSH_CHECKOUT points at "${checkout}", which is not a directory`)
  }
  const tscPath = path.join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!fs.existsSync(tscPath)) {
    fail(
      `TypeScript not found in DSH_CHECKOUT (${checkout}): ${tscPath}\n`
      + "  - install the checkout's dependencies first (pnpm install), or\n"
      + '  - run `npm install` in this package and retry without DSH_CHECKOUT',
    )
  }
  return { tscPath, checkout }
}

/**
 * Point `node_modules/<specifier>` at the checkout directory `target`.
 * A real (non-symlink) entry is left untouched: it can only come from an
 * explicit package manager install and already satisfies resolution.
 */
function ensureDevLink(checkout, specifier, relativeTarget) {
  const target = path.join(checkout, relativeTarget)
  if (!isDirectory(target)) {
    fail(`required dev dependency source is missing: ${target}`)
  }
  const resolvedTarget = fs.realpathSync(target)
  const linkPath = path.join(PACKAGE_ROOT, 'node_modules', ...specifier.split('/'))
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })

  let existing
  try {
    existing = fs.lstatSync(linkPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return
    const current = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))
    let currentReal = current
    try {
      currentReal = fs.realpathSync(current)
    } catch {
      // Broken link: fall through and recreate it.
    }
    if (currentReal === resolvedTarget) return
    fs.unlinkSync(linkPath)
  }

  fs.symlinkSync(resolvedTarget, linkPath, 'dir')
}

function countEmittedLines(directory) {
  let lines = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      lines += countEmittedLines(fullPath)
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
      lines += fs.readFileSync(fullPath, 'utf8').split('\n').length
    }
  }
  return lines
}

const { tscPath, checkout } = resolveCompiler()

// Checkout mode only: keep the dev-only type-checking links pointed at the
// checkout. With an npm-installed tree the real packages are used as-is.
if (checkout !== '') {
  for (const [specifier, relativeTarget] of DEV_LINKS) {
    ensureDevLink(checkout, specifier, relativeTarget)
  }
}

const libDirectory = path.join(PACKAGE_ROOT, 'lib')
// Build from a clean lib/ so removed modules never leave stale committed output.
fs.rmSync(libDirectory, { recursive: true, force: true })
console.log(`build: compiling with ${tscPath}`)
try {
  execFileSync(process.execPath, [tscPath, '-p', path.join(PACKAGE_ROOT, 'tsconfig.json')], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
  })
} catch (error) {
  const status = typeof error.status === 'number' ? ` (exit code ${error.status})` : ''
  fail(`TypeScript compilation failed${status}`)
}

if (!fs.existsSync(path.join(libDirectory, 'index.js'))) {
  fail('TypeScript reported success but lib/index.js was not emitted')
}
if (!fs.existsSync(path.join(libDirectory, 'types', 'index.d.ts'))) {
  fail('TypeScript reported success but lib/types/index.d.ts was not emitted')
}

console.log(`built ${countEmittedLines(libDirectory)} line(s) to lib/`)
