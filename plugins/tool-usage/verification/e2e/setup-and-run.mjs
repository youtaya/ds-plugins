#!/usr/bin/env node
/**
 * End-to-end verification harness for `dsh-plugin-tool-usage` (DESIGN.md §10).
 *
 * What it does, in order:
 *   1. resolves the workspace, the DSH checkout, and the built plugin bundle;
 *   2. recreates an isolated DSH home at `<workspace>/.e2e-home` (never the live
 *      `~/.dsh`) plus a scratch workspace directory inside it;
 *   3. initializes the shipped `headless` profile there
 *      (`pnpm dsh --profile headless --help`);
 *   4. installs the built bundle into that profile
 *      (`pnpm dsh plugin --profile headless add <abs plugin path>`);
 *   5. proves the profile layer with `--dump-config`
 *      (`# == dsh-plugin-tool-usage` + `id: tool-usage`);
 *   6. runs ONE headless task that asks the model to call `bash`
 *      (`echo hello-tool-usage`) and then `tool_usage` with `view: "summary"`;
 *   7. runs ONE headless task that forces a `read` of a nonexistent path (a real
 *      `isError` tool result → `status: "error"` record) plus a failing `bash`
 *      (`exit 3`, a non-zero exit: DSH reports those as normal results, so the
 *      genuine error record comes from `read`; both are asserted);
 *   8. asserts every DESIGN §10 / task-5 acceptance point and prints PASS/FAIL.
 *
 * Credentials: `DEEPSEEK_API_KEY` is read in-process from
 * `~/.dsh/.credentials.yaml` and handed to child processes ONLY through the
 * environment. It is never printed and never written to any file (all output
 * that leaves this script goes through `redact()`).
 *
 * LLM budget: exactly two headless runs (main + failure case). Never more.
 *
 * Permission mode: the e2e headless tasks run with
 * DSH_PERMISSION_MODE=danger-full-access by default (override with
 * E2E_PERMISSION_MODE, e.g. workspace-write). Reason: when this harness itself
 * runs inside a sandboxed DSH agent session, the nested OS sandbox backend is
 * unavailable ("sandbox-exec: sandbox_apply: Operation not permitted"), so a
 * workspace-write bash call fails closed with SANDBOX_UNAVAILABLE and can never
 * record a successful call. The e2e commands are fixed and side-effect-free
 * (`echo hello-tool-usage`, `exit 3`, a read of a nonexistent path) and the DSH
 * home is isolated, so running them unconfined is acceptable for verification;
 * `danger-full-access` needs no approval channel.
 *
 * Usage:
 *   node plugins/tool-usage/verification/e2e/setup-and-run.mjs
 *   node plugins/tool-usage/verification/e2e/setup-and-run.mjs --skip-error
 *   node plugins/tool-usage/verification/e2e/setup-and-run.mjs --no-llm      # setup + dump proof only
 *   node plugins/tool-usage/verification/e2e/setup-and-run.mjs --error-only  # re-run failure case only
 *   node plugins/tool-usage/verification/e2e/setup-and-run.mjs --dry-run     # resolve everything, print the plan
 *   node plugins/tool-usage/verification/e2e/run-error-case.mjs              # wrapper for --error-only
 *
 * Environment: DSH_CHECKOUT (required — the DSH source checkout used to run the
 * headless tasks), E2E_WORKSPACE, E2E_HOME.
 * Exit code: 0 only when every executed assertion passed.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME_BASENAME = '.e2e-home'
const PLUGIN_PACKAGE = 'dsh-plugin-tool-usage'

/** Absolute path of this file (used to derive the workspace). */
const SELF = fileURLToPath(import.meta.url)

/* ------------------------------------------------------------------------- */
/* output / redaction                                                        */
/* ------------------------------------------------------------------------- */

/** Secrets that must never reach stdout, stderr, or an artifact file. */
const SECRETS = []

/** Replace every registered secret in `text`. */
function redact(text) {
  let out = String(text)
  for (const secret of SECRETS) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]')
  }
  return out
}

/** Console line, redacted. */
function say(line = '') {
  process.stdout.write(redact(line) + '\n')
}

/* ------------------------------------------------------------------------- */
/* assertions                                                               */
/* ------------------------------------------------------------------------- */

/** Collected PASS/FAIL results. */
const RESULTS = []

/**
 * Record one assertion.
 * @param {string} id stable short id.
 * @param {string} title human-readable acceptance criterion.
 * @param {boolean} pass result.
 * @param {string} [detail] evidence shown next to the line.
 */
function check(id, title, pass, detail = '') {
  const entry = { id, title, pass, detail: redact(detail) }
  RESULTS.push(entry)
  say(`${pass ? 'PASS' : 'FAIL'}  [${id}] ${title}${detail ? `\n        ${redact(detail)}` : ''}`)
  return pass
}

/* ------------------------------------------------------------------------- */
/* environment resolution                                                    */
/* ------------------------------------------------------------------------- */

/** Fail with a clear message (thrown, caught by the entrypoint). */
function fail(message) {
  throw new Error(message)
}

/** Assert `child` lives inside `parent` (prefix-safe). */
function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve workspace, checkout, isolated home, built bundle, and tooling paths.
 * @returns resolved environment descriptor.
 */
export function resolveEnvironment() {
  const here = dirname(SELF)
  const workspace = resolve(process.env.E2E_WORKSPACE?.trim() || join(here, '..', '..', '..', '..'))
  if (!existsSync(join(workspace, 'docs', 'DESIGN.md'))) {
    fail(`workspace does not look like the ds-plugins checkout: ${workspace} (docs/DESIGN.md missing)`)
  }

  // The DSH source checkout is required: it provides the CLI (`apps/cli/src/bin.ts`),
  // `tsx`, and the installed `node_modules` the headless tasks run from. There is no
  // machine-specific default; point DSH_CHECKOUT at the checkout root.
  const checkoutSetting = process.env.DSH_CHECKOUT?.trim()
  if (checkoutSetting === undefined || checkoutSetting === '') {
    fail(
      'DSH_CHECKOUT is required: set it to the DSH source checkout root.\n'
      + '        expected <checkout>/package.json (name "@deepseek-ai/dsh-root") and <checkout>/apps/cli/src/bin.ts\n'
      + `        example: DSH_CHECKOUT=<dsh-checkout> node ${relative(process.cwd(), SELF) || SELF}`,
    )
  }
  const checkout = resolve(checkoutSetting)
  const checkoutPkgJson = join(checkout, 'package.json')
  const binTs = join(checkout, 'apps', 'cli', 'src', 'bin.ts')
  if (!existsSync(checkoutPkgJson) || !existsSync(binTs)) {
    fail(
      `DSH checkout not found or incomplete: ${checkout}\n`
      + '        expected package.json and apps/cli/src/bin.ts; set DSH_CHECKOUT to the checkout root',
    )
  }
  let checkoutPkg
  try {
    checkoutPkg = JSON.parse(readFileSync(checkoutPkgJson, 'utf8'))
  } catch (error) {
    fail(`cannot read ${checkoutPkgJson}: ${error.message}`)
  }
  if (checkoutPkg?.name !== '@deepseek-ai/dsh-root') {
    fail(`unexpected checkout package at ${checkout}: name is ${JSON.stringify(checkoutPkg?.name)}`)
  }

  const pluginDir = join(workspace, 'plugins', 'tool-usage')
  const pluginEntry = join(pluginDir, 'lib', 'index.js')
  const pluginPkgJson = join(pluginDir, 'package.json')

  const e2eHome = resolve(process.env.E2E_HOME?.trim() || join(workspace, HOME_BASENAME))
  if (e2eHome === resolve(join(homedir(), '.dsh')) || e2eHome === resolve(homedir())) {
    fail(`refusing to use the live DSH home as E2E_HOME: ${e2eHome}`)
  }
  if (!isInside(workspace, e2eHome)) {
    fail(`E2E_HOME must live inside the workspace (${workspace}), got: ${e2eHome}`)
  }
  if (!/^\.e2e[-.]/.test(basename(e2eHome)) && process.env.E2E_ALLOW_ANY_HOME !== '1') {
    fail(
      `refusing to recreate an unfamiliar directory as the isolated home: ${e2eHome}\n`
      + '        use a basename starting with ".e2e" (default: .e2e-home) or set E2E_ALLOW_ANY_HOME=1',
    )
  }

  const scratchDir = join(e2eHome, 'workspace')
  const artifactsDir = join(workspace, 'plugins', 'tool-usage', 'verification', 'e2e', 'artifacts')
  const profileDir = join(e2eHome, 'profiles', 'headless')
  const callsDir = join(e2eHome, 'tool-usage')
  const pnpmStore = join(workspace, '.pnpm-store')
  const tsconfigPath = join(checkout, 'tsconfig.json')

  let tsxEsm
  try {
    tsxEsm = createRequire(checkoutPkgJson).resolve('tsx/esm')
  } catch (error) {
    fail(`cannot resolve tsx from the DSH checkout (${checkout}): ${error.message}`)
  }

  return {
    workspace,
    pluginDir,
    pluginEntry,
    pluginPkgJson,
    profileDir,
    callsDir,
    checkout,
    binTs,
    tsxEsm,
    tsconfigPath,
    e2eHome,
    scratchDir,
    artifactsDir,
    pnpmStore,
    nodeExec: process.execPath,
  }
}

/* ------------------------------------------------------------------------- */
/* credentials                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Read the DeepSeek API key without ever exposing it.
 * Prefers the in-process credentials file (`~/.dsh/.credentials.yaml`), falls
 * back to an already-exported DEEPSEEK_API_KEY. Registers the value for
 * redaction before returning it.
 * @returns {string} the key.
 */
export function readApiKey() {
  const credentialsPath = join(homedir(), '.dsh', '.credentials.yaml')
  let key
  if (existsSync(credentialsPath)) {
    const text = readFileSync(credentialsPath, 'utf8')
    key = parseCredentialRef(text, 'DEEPSEEK_API_KEY')
  }
  if (key === undefined) {
    const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
    if (fromEnv) key = fromEnv
  }
  if (key === undefined || key.trim() === '') {
    fail(
      `DEEPSEEK_API_KEY not found in ${credentialsPath} (refs.DEEPSEEK_API_KEY) or the environment.\n`
      + '        Do not fake this run: the e2e test is BLOCKED until a real key is available; '
      + 'setup + --dump-config evidence is still produced by --no-llm.',
    )
  }
  key = key.trim().replace(/^['"]|['"]$/g, '')
  if (key.length < 8) fail('DEEPSEEK_API_KEY looks too short; refusing to use it')
  SECRETS.push(key)
  return key
}

/**
 * Parse `DEEPSEEK_API_KEY` out of the credentials YAML without a YAML parser
 * dependency. The shipped file shape is `refs:` → `  KEY: value`.
 * @param {string} text credentials file content.
 * @param {string} name credential ref name.
 * @returns {string | undefined} the value.
 */
function parseCredentialRef(text, name) {
  // The shipped file shape is a flat `refs:` mapping, so a small scanner beats
  // adding a YAML dependency to the harness.
  let inRefs = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\S/.test(rawLine)) {
      inRefs = /^refs:\s*$/.test(rawLine)
      continue
    }
    if (!inRefs) continue
    const match = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`).exec(rawLine)
    if (match !== null) {
      const value = match[1]
      // Skip YAML mappings/aliases that are not plain scalar values.
      if (!value.startsWith('{') && !value.startsWith('&') && !value.startsWith('*')) {
        return value
      }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------------- */
/* child processes                                                           */
/* ------------------------------------------------------------------------- */

/** Every command, in order, for the report/human rerun. */
const COMMANDS = []

/** Artifacts directory of the current run (set by main). */
let ARTIFACTS = undefined

/** Append `text` to an artifact file (redacted). */
function writeArtifact(name, text) {
  if (ARTIFACTS === undefined) return
  mkdirSync(ARTIFACTS, { recursive: true, mode: 0o700 })
  writeFileSync(join(ARTIFACTS, name), redact(String(text)), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Spawn one command, capture stdout/stderr, enforce a timeout.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {{cwd: string, env: Record<string, string|undefined>, timeoutMs?: number, label: string}} options spawn options.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, durationMs: number, commandLine: string}>}
 */
export function spawnCapture(command, args, options) {
  const { cwd, env, timeoutMs = 240_000, label } = options
  const commandLine = [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ')
  COMMANDS.push({ label, commandLine: `(cwd: ${cwd}) ${redact(commandLine)}` })
  if (ARTIFACTS !== undefined) {
    mkdirSync(ARTIFACTS, { recursive: true, mode: 0o700 })
    writeFileSync(join(ARTIFACTS, 'commands.log'), redact(COMMANDS.map(e => `${e.label}  ${e.commandLine}`).join('\n')) + '\n', { encoding: 'utf8', mode: 0o600 })
  }

  return new Promise((resolvePromise) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer

    const finish = (code, extraError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (extraError !== undefined) stderr += `\n${extraError}`
      resolvePromise({ code, stdout, stderr, timedOut, durationMs: Date.now() - started, commandLine })
    }

    let child
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish(null, `spawn error: ${error.message}`)
      return
    }

    const limit = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    }, timeoutMs)
    const timer = limit

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish(null, `spawn error: ${error.message}`))
    child.on('close', code => finish(code))
  })
}

/** Environment shared by every child process (no secret unless caller adds one). */
function baseChildEnv(environment) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    env[key] = value
  }
  // Never leak a key that happened to be exported into unrelated child commands.
  delete env.DEEPSEEK_API_KEY
  env.DSH_HOME = environment.e2eHome
  env.NO_COLOR = '1'
  env.CI = '1'
  // Keep pnpm's store/cache inside the workspace: nothing may be written to the
  // live home and the workspace root stays clean (gitignored).
  env.npm_config_store_dir = environment.pnpmStore
  env.npm_config_cache = join(environment.e2eHome, '.pnpm-cache')
  return env
}

/** Run `pnpm dsh ...` from the DSH checkout with the isolated DSH_HOME. */
export function runDsh(environment, dshArgs, options = {}) {
  return spawnCapture('pnpm', ['dsh', ...dshArgs], {
    cwd: environment.checkout,
    env: { ...baseChildEnv(environment), ...options.env },
    timeoutMs: options.timeoutMs ?? 240_000,
    label: options.label ?? `dsh ${dshArgs.join(' ').slice(0, 80)}`,
  })
}

/**
 * Run one headless task. Executes the CLI directly (same command as the
 * checkout's `pnpm dsh` script) from the scratch workspace inside the isolated
 * home, so the agent workspace never is the DSH checkout or the user's repo.
 */
export function runHeadlessTask(environment, apiKey, taskText, label) {
  const args = [
    '--import',
    environment.tsxEsm,
    environment.binTs,
    '--profile',
    'headless',
    taskText,
  ]
  return spawnCapture(environment.nodeExec, args, {
    cwd: environment.scratchDir,
    env: {
      ...baseChildEnv(environment),
      TSX_TSCONFIG_PATH: environment.tsconfigPath,
      DEEPSEEK_API_KEY: apiKey,
      // Fixed e2e commands only; see the module header for why the nested
      // workspace-write sandbox cannot be used from inside an agent session.
      DSH_PERMISSION_MODE: permissionMode(),
    },
    timeoutMs: 300_000,
    label,
  })
}

/** Permission preset used for the e2e headless tasks. */
export function permissionMode() {
  const override = process.env.E2E_PERMISSION_MODE?.trim()
  return override !== undefined && override !== '' ? override : 'danger-full-access'
}

/* ------------------------------------------------------------------------- */
/* JSONL call log / stats helpers                                            */
/* ------------------------------------------------------------------------- */

/** List `calls-*.jsonl` files in the plugin output dir (sorted by name). */
export function listCallLogs(environment) {
  if (!existsSync(environment.callsDir)) return []
  return readdirSync(environment.callsDir)
    .filter(name => /^calls-.+\.jsonl$/.test(name))
    .sort()
    .map(name => join(environment.callsDir, name))
}

/**
 * Read every call record, tolerating malformed lines (reported, never fatal).
 * @returns {{records: object[], files: string[], malformed: number}}
 */
export function readCallRecords(environment) {
  const records = []
  const files = listCallLogs(environment)
  let malformed = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        malformed += 1
      }
    }
  }
  return { records, files, malformed }
}

/** Per-file line counts, used to isolate the records a later run appended. */
export function baselineLineCounts(environment) {
  const counts = new Map()
  for (const file of listCallLogs(environment)) {
    const text = readFileSync(file, 'utf8')
    counts.set(file, text.split('\n').filter(line => line.trim() !== '').length)
  }
  return counts
}

/** Records appended since `baseline`. */
export function recordsSince(environment, baseline) {
  const appended = []
  const files = listCallLogs(environment)
  for (const file of files) {
    const start = baseline.get(file) ?? 0
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(line => line.trim() !== '')
    for (const line of lines.slice(start)) {
      try {
        appended.push(JSON.parse(line))
      } catch {
        /* tolerate: malformed lines are counted by readCallRecords */
      }
    }
  }
  return appended
}

/** Read and parse `stats.json` (undefined when it does not exist yet). */
export function readStats(environment) {
  const statsPath = join(environment.callsDir, 'stats.json')
  if (!existsSync(statsPath)) return undefined
  try {
    return JSON.parse(readFileSync(statsPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The most recently appended record matching `predicate`. Records are read in
 * append order, so a retried run's later record wins over an earlier attempt.
 */
export function latestRecord(records, predicate) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (predicate(record)) return record
  }
  return undefined
}

/** Short sanitized rendering of a call record for evidence lines. */
function describeRecord(record) {
  const command = record?.params?.command
  return [
    `tool=${record?.tool}`,
    `status=${record?.status}`,
    `durationMs=${record?.durationMs}`,
    typeof command === 'string' ? `command=${JSON.stringify(command.slice(0, 80))}` : '',
    typeof record?.explanation?.summary === 'string' ? `summary=${JSON.stringify(record.explanation.summary.slice(0, 120))}` : '',
  ].filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------------- */
/* stages                                                                    */
/* ------------------------------------------------------------------------- */

/** Delete and recreate the isolated home + scratch workspace. */
export function recreateHome(environment) {
  say(`\n== reset isolated home\n   ${environment.e2eHome}`)
  rmSync(environment.e2eHome, { recursive: true, force: true, maxRetries: 3 })
  mkdirSync(environment.scratchDir, { recursive: true, mode: 0o700 })
  mkdirSync(environment.artifactsDir, { recursive: true, mode: 0o700 })
  writeArtifact('commands.log', '')
  check(
    'HOME-1',
    'isolated DSH home recreated inside the workspace (live ~/.dsh untouched)',
    existsSync(environment.e2eHome) && existsSync(environment.scratchDir),
    environment.e2eHome,
  )
}

/** Initialize the shipped headless profile (`--help` auto-inits it). */
export async function initProfile(environment) {
  say('\n== initialize shipped headless profile')
  const result = await runDsh(environment, ['--profile', 'headless', '--help'], { label: 'init-headless-profile' })
  writeArtifact('init-profile.stdout.txt', result.stdout)
  writeArtifact('init-profile.stderr.txt', result.stderr)
  const pkgPath = join(environment.profileDir, 'package.json')
  let bundles = []
  if (existsSync(pkgPath)) {
    try {
      bundles = JSON.parse(readFileSync(pkgPath, 'utf8'))?.dsh?.profile?.bundles ?? []
    } catch { /* checked by the assertion below */ }
  }
  check(
    'PROFILE-1',
    'headless profile initialized from the shipped template (exit 0)',
    result.code === 0 && existsSync(pkgPath),
    `exit=${result.code} profile=${pkgPath}`,
  )
  check(
    'PROFILE-2',
    'shipped headless bundles present before installing the plugin',
    bundles.includes('@deepseek-ai/dsh-base') && bundles.includes('@deepseek-ai/dsh-headless'),
    `bundles=${JSON.stringify(bundles)}`,
  )
  return result
}

/** Install the built bundle into the isolated profile. */
export async function installBundle(environment) {
  say('\n== install built bundle into isolated headless profile')
  const result = await runDsh(
    environment,
    ['plugin', '--profile', 'headless', 'add', environment.pluginDir],
    { label: 'plugin-add-tool-usage', timeoutMs: 300_000 },
  )
  writeArtifact('plugin-add.stdout.txt', result.stdout)
  writeArtifact('plugin-add.stderr.txt', result.stderr)
  const pkgPath = join(environment.profileDir, 'package.json')
  let bundles = []
  let dependencies = {}
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      bundles = pkg?.dsh?.profile?.bundles ?? []
      dependencies = pkg?.dependencies ?? {}
    } catch { /* asserted below */ }
  }
  check(
    'INSTALL-1',
    `plugin add exits 0 and ${PLUGIN_PACKAGE} becomes a profile dependency`,
    result.code === 0 && Object.keys({ ...dependencies }).some(name => name === PLUGIN_PACKAGE),
    `exit=${result.code} dependencies=${JSON.stringify(dependencies)}`,
  )
  check(
    'INSTALL-2',
    `profile bundles list includes ${PLUGIN_PACKAGE} (patch layer activated)`,
    bundles.includes(PLUGIN_PACKAGE),
    `bundles=${JSON.stringify(bundles)}`,
  )
  return result
}

/** Prove the loaded layer with `--dump-config`. */
export async function dumpConfig(environment) {
  say('\n== prove the bundle patch layer with --dump-config')
  const result = await runDsh(environment, ['--profile', 'headless', '--dump-config'], {
    label: 'dump-config',
  })
  writeArtifact('dump-config.stdout.txt', result.stdout)
  writeArtifact('dump-config.stderr.txt', result.stderr)

  const lines = result.stdout.split(/\r?\n/)
  const layerStart = lines.findIndex(line => line.trim() === `# == ${PLUGIN_PACKAGE}`)
  let layerLines = []
  if (layerStart >= 0) {
    layerLines = []
    for (let index = layerStart + 1; index < lines.length; index += 1) {
      if (/^# == /.test(lines[index])) break
      layerLines.push(lines[index])
    }
  }
  const layerText = layerLines.join('\n')
  const rowId = /^-\s+id:\s*tool-usage\s*$/m.test(layerText)
  const rowName = /^\s+name:\s*['"]?dsh-plugin-tool-usage['"]?\s*$/m.test(layerText)

  check(
    'DUMP-1',
    `--dump-config shows the "# == ${PLUGIN_PACKAGE}" layer`,
    layerStart >= 0,
    layerStart >= 0 ? `line ${layerStart + 1}` : 'layer header not found',
  )
  check(
    'DUMP-2',
    `layer contributes row "id: tool-usage" (name ${PLUGIN_PACKAGE})`,
    rowId && rowName,
    layerText.split('\n').slice(0, 6).join(' | '),
  )
  return result
}

/** Scan stderr for plugin load / import / activation failures. */
export function findPluginLoadErrors(stderr) {
  const patterns = [
    /Cannot find module ['"][^'"]*tool-usage/i,
    /Cannot find package ['"][^'"]*tool-usage/i,
    /does not provide an export named/i,
    /ERR_MODULE_NOT_FOUND/i,
    /bundle activation rejected/i,
    /failed to (?:load|activate|import|resolve) (?:plugin|bundle)/i,
    /(?:plugin|bundle)\s+[\w@/.-]+\s+failed/i,
    /dsh: .*(?:plugin|bundle).*(?:failed|error|rejected|invalid)/i,
    /Error while loading plugin/i,
    /plugin load (?:error|failure)/i,
  ]
  return stderr
    .split(/\r?\n/)
    .filter(line => patterns.some(pattern => pattern.test(line)))
}

/** Statistics-evidence check on the model's final answer. */
function hasStatisticsEvidence(stdout) {
  const text = stdout
  const mentionsStats = /工具调用统计|总计|总共|总调用|调用统计|total (?:tool )?calls?|calls? total/i.test(text)
  const mentionsTool = /bash/i.test(text)
  return mentionsStats && mentionsTool
}

/** Run the main headless acceptance task and assert every result point. */
export async function mainRun(environment, apiKey) {
  say('\n== run 1/2 headless task: bash + tool_usage summary')
  const task = [
    'Use the bash tool to run exactly this command: echo hello-tool-usage',
    '',
    'Then call the tool_usage tool with {"view": "summary", "scope": "session"} to read the recorded tool statistics.',
    '',
    'Do not call any other tools, and do not run any other bash commands.',
    'In your final answer, report the statistics you received: the total number of calls and the per-tool call counts.',
  ].join('\n')
  const result = await runHeadlessTask(environment, apiKey, task, 'headless-main-run')
  writeArtifact('main.stdout.txt', result.stdout)
  writeArtifact('main.stderr.txt', result.stderr)

  const { records, files, malformed } = readCallRecords(environment)
  const stats = readStats(environment)

  check(
    'RUN-1',
    'main headless task exits 0',
    result.code === 0,
    `exit=${result.code} durationMs=${result.durationMs} timedOut=${result.timedOut}`,
  )

  const bashRecord = latestRecord(
    records,
    record => record?.tool === 'bash'
      && typeof record?.params?.command === 'string'
      && record.params.command.includes('hello-tool-usage'),
  )
  check(
    'LOG-1',
    'calls-*.jsonl contains a bash record for "echo hello-tool-usage"',
    files.length > 0 && bashRecord !== undefined,
    bashRecord === undefined
      ? `jsonl files=${JSON.stringify(files.map(file => basename(file)))} records=${records.length} malformed=${malformed}`
      : describeRecord(bashRecord),
  )
  const bashDetail = bashRecord === undefined ? 'no matching record' : describeRecord(bashRecord)
  check('LOG-2', 'that bash record has status "ok"', bashRecord?.status === 'ok', bashDetail)
  check(
    'LOG-3',
    'that bash record has a numeric durationMs >= 0',
    typeof bashRecord?.durationMs === 'number' && Number.isFinite(bashRecord.durationMs) && bashRecord.durationMs >= 0,
    bashDetail,
  )
  const summary = bashRecord?.explanation?.summary
  check(
    'LOG-4',
    'that bash record carries a non-empty human-readable explanation.summary',
    typeof summary === 'string' && summary.trim() !== '',
    bashDetail,
  )
  check(
    'LOG-5',
    'explanation.summary is human-readable Chinese (language default "zh")',
    typeof summary === 'string' && /[\u4e00-\u9fff]/.test(summary),
    bashDetail,
  )
  const toolUsageRecord = latestRecord(records, record => record?.tool === 'tool_usage')
  check(
    'LOG-6',
    'the tool_usage tool call itself is recorded too (tool ran in-process)',
    toolUsageRecord !== undefined && toolUsageRecord?.status === 'ok',
    toolUsageRecord === undefined ? 'no tool_usage record found' : describeRecord(toolUsageRecord),
  )

  const totalCalls = stats?.totals?.calls
  check(
    'STATS-1',
    'stats.json exists and totals.calls >= 1',
    stats !== undefined && typeof totalCalls === 'number' && totalCalls >= 1,
    stats === undefined ? 'stats.json missing/unparseable' : `totals.calls=${totalCalls} tools=${JSON.stringify((stats.tools ?? []).map(tool => `${tool.name}:${tool.calls}`))}`,
  )

  writeArtifact('main-call-records.jsonl', records.map(record => JSON.stringify(record)).join('\n') + '\n')
  writeArtifact('stats-after-main.json', JSON.stringify(stats, null, 2))
  check(
    'OUT-1',
    'model final answer (stdout) shows the statistics/tool result',
    hasStatisticsEvidence(result.stdout),
    excerpt(result.stdout, 320),
  )

  const loadErrors = findPluginLoadErrors(result.stderr)
  check(
    'LOAD-1',
    'stderr has no plugin load/import/activation error',
    loadErrors.length === 0,
    loadErrors.length === 0 ? `stderr lines=${result.stderr.split('\n').length} (reasoning stream tolerated)` : loadErrors.slice(0, 5).join(' | '),
  )
  return { result, records, stats }
}

/** Run the deliberate-failure headless task and assert the error record. */
export async function errorRun(environment, apiKey, options = {}) {
  say('\n== run 2/2 headless task: forced failing tool call')
  const baseline = baselineLineCounts(environment)
  // A non-zero bash exit is a normal result in DSH ("non-zero exits are reported,
  // not errored"), so the deliberate *error-status* record is forced with a `read`
  // of a path that cannot exist (the fs provider throws → isError → status "error").
  const task = [
    'Use the read tool to read this exact absolute path: /nonexistent-e2e-error-case/file.txt',
    'The file does not exist and must not be created; call the tool anyway so its error result is recorded.',
    '',
    'Then use the bash tool to run exactly this command: exit 3',
    '',
    'Do not retry either call, do not change the arguments, and do not call any other tools.',
    'In your final answer, report both tool results: the read error and the bash exit status.',
  ].join('\n')
  const result = await runHeadlessTask(environment, apiKey, task, 'headless-error-run')
  writeArtifact('error.stdout.txt', result.stdout)
  writeArtifact('error.stderr.txt', result.stderr)

  const appended = recordsSince(environment, baseline)
  writeArtifact('error-call-records.jsonl', appended.map(record => JSON.stringify(record)).join('\n') + '\n')
  const stats = readStats(environment)
  writeArtifact('stats-after-error.json', JSON.stringify(stats, null, 2))

  check(
    'RUN-2',
    'failure-case headless task exits 0 (the agent run completes)',
    result.code === 0,
    `exit=${result.code} durationMs=${result.durationMs} timedOut=${result.timedOut}`,
  )
  check(
    'ERR-1',
    'at least one new call record was appended by the failure case',
    appended.length > 0,
    `new records=${appended.length} tools=${JSON.stringify(appended.map(record => `${record?.tool}:${record?.status}`))}`,
  )
  const errorRecord = appended.find(record => record?.status === 'error')
  check(
    'ERR-2',
    'the deliberate tool error is recorded with status "error" in calls-*.jsonl',
    errorRecord !== undefined,
    errorRecord === undefined
      ? `new records=${JSON.stringify(appended.map(record => `${record?.tool}:${record?.status}`))}`
      : describeRecord(errorRecord),
  )
  const failingBash = appended.find(record =>
    record?.tool === 'bash'
    && typeof record?.params?.command === 'string'
    && /exit\s+3/.test(record.params.command))
  check(
    'ERR-3',
    'the deliberate failing bash call (`exit 3`) is recorded',
    failingBash !== undefined,
    failingBash === undefined
      ? 'no bash record with command "exit 3" appended'
      : `${describeRecord(failingBash)} (DSH reports a non-zero exit as a normal tool result, so this record's status is "${failingBash.status}"; the genuine isError record is asserted above via the read failure)`,
  )
  const errorsTotal = stats?.totals?.errors
  check(
    'ERR-4',
    'stats.json reflects the failure (totals.errors >= 1) and survived the run',
    typeof errorsTotal === 'number' && errorsTotal >= 1,
    stats === undefined ? 'stats.json missing/unparseable' : `totals.calls=${stats.totals?.calls} totals.errors=${errorsTotal}`,
  )

  const loadErrors = findPluginLoadErrors(result.stderr)
  check(
    'ERR-5',
    'failure-case stderr has no plugin load/import/activation error',
    loadErrors.length === 0,
    loadErrors.length === 0 ? 'clean' : loadErrors.slice(0, 5).join(' | '),
  )
  if (options.verbose !== false) {
    say(`\n--- failure-case stdout excerpt ---\n${excerpt(result.stdout, 500)}`)
  }
  return { result, appended, stats }
}

/** Trim a text blob to a compact evidence excerpt. */
function excerpt(text, maxChars) {
  const compact = String(text ?? '').trim()
  if (compact === '') return '(empty)'
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}… (${compact.length} chars)`
}

/* ------------------------------------------------------------------------- */
/* entrypoint                                                                */
/* ------------------------------------------------------------------------- */

/** Parse CLI flags. */
export function parseArgs(argv) {
  const flags = {
    dryRun: false,
    keepHome: false,
    skipError: false,
    errorOnly: false,
    noLlm: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--keep-home') flags.keepHome = true
    else if (arg === '--skip-error') flags.skipError = true
    else if (arg === '--error-only') flags.errorOnly = true
    else if (arg === '--no-llm') flags.noLlm = true
    else if (arg === '--help' || arg === '-h') flags.help = true
    else fail(`unknown argument: ${arg} (see --help)`)
  }
  if (flags.errorOnly) {
    flags.skipError = false
    flags.noLlm = false
  }
  return flags
}

/** Persist non-secret environment facts used by the run (for the e2e report). */
function writeEnvironmentFacts(environment) {
  let pluginEntryMtime = null
  try {
    pluginEntryMtime = statSync(environment.pluginEntry).mtime.toISOString()
  } catch { /* a missing build is reported before any run starts */ }
  writeArtifact('environment.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    workspace: environment.workspace,
    checkout: environment.checkout,
    e2eHome: environment.e2eHome,
    taskPermissionMode: permissionMode(),
    pluginEntry: environment.pluginEntry,
    pluginEntryMtime,
  }, null, 2) + '\n')
}

/** Print usage. */
function printHelp() {
  say(`Usage: node ${relative(process.cwd(), SELF) || SELF} [options]

Run the DESIGN §10 end-to-end verification of ${PLUGIN_PACKAGE} in an isolated
DSH home. Two LLM runs by default (main + failure case).

Options:
  --dry-run      resolve paths and print the plan, run nothing
  --no-llm       isolated home + profile + plugin install + --dump-config only
  --skip-error   setup + dump proof + main headless task only
  --error-only   only the failure case (host must already be set up)
  --keep-home    do not delete the isolated home before installing
  -h, --help     show this help

Environment: DSH_CHECKOUT (required), E2E_WORKSPACE, E2E_HOME.`)
}

/** Entrypoint; returns the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  if (flags.help) {
    printHelp()
    return 0
  }
  const environment = resolveEnvironment()
  ARTIFACTS = environment.artifactsDir

  say('== dsh-plugin-tool-usage E2E (DESIGN §10)')
  say(`   workspace : ${environment.workspace}`)
  say(`   checkout  : ${environment.checkout}`)
  say(`   DSH_HOME  : ${environment.e2eHome}`)
  say(`   plugin    : ${environment.pluginDir}`)
  say(`   task perm : ${permissionMode()} (E2E_PERMISSION_MODE override; see module header)`)
  const stages = flags.errorOnly
    ? ['error']
    : [
        'prepare',
        'init',
        'install',
        ...(flags.noLlm ? [] : ['dump', 'main']),
        ...(flags.noLlm || flags.skipError ? [] : ['error']),
      ]
  // Dump proof is cheap and always valuable, even with --no-llm.
  if (flags.noLlm && !stages.includes('dump')) stages.push('dump')
  if (flags.keepHome && stages[0] === 'prepare') stages[0] = 'reuse'

  // Fail fast, before touching the isolated home: a missing build must be loud.
  if (!existsSync(environment.pluginEntry)) {
    fail(
      `built bundle entry missing: ${environment.pluginEntry}\n`
      + `        build the plugin first: node ${join(environment.pluginDir, 'scripts', 'build.mjs')}`,
    )
  }
  try {
    JSON.parse(readFileSync(environment.pluginPkgJson, 'utf8'))
  } catch (error) {
    fail(`cannot read ${environment.pluginPkgJson}: ${error.message}`)
  }

  say(`   stages    : ${stages.join(', ')}`)
  if (flags.dryRun) {
    say('\nDRY RUN: paths resolved and built bundle found; nothing was executed.')
    return 0
  }

  mkdirSync(environment.artifactsDir, { recursive: true, mode: 0o700 })
  writeEnvironmentFacts(environment)

  let apiKey
  const needsLlm = stages.includes('main') || stages.includes('error')
  if (needsLlm) {
    try {
      apiKey = readApiKey()
      say('   credentials: DEEPSEEK_API_KEY loaded from the credentials store (value never printed)')
    } catch (error) {
      say(`\nBLOCKED: ${error.message}`)
      say('Continuing with the loadability proof only; no LLM run is executed.')
    }
  }

  if (!stages.includes('prepare')) {
    const profilePkgPath = join(environment.profileDir, 'package.json')
    if (!existsSync(profilePkgPath)) {
      fail(`no initialized profile at ${environment.profileDir}; run setup-and-run.mjs first (full run)`)
    }
    let reusedBundles = []
    try {
      reusedBundles = JSON.parse(readFileSync(profilePkgPath, 'utf8'))?.dsh?.profile?.bundles ?? []
    } catch { /* reported below */ }
    if (!reusedBundles.includes(PLUGIN_PACKAGE)) {
      fail(`${PLUGIN_PACKAGE} is not installed in ${environment.profileDir}; run setup-and-run.mjs first (full run)`)
    }
    say(`\n== reuse isolated home\n   ${environment.e2eHome}`)
  } else {
    recreateHome(environment)
  }
  if (stages.includes('init')) await initProfile(environment)
  if (stages.includes('install')) await installBundle(environment)
  if (stages.includes('dump')) await dumpConfig(environment)
  if (stages.includes('main')) {
    if (apiKey === undefined) {
      check('RUN-1', 'main headless task exits 0', false, 'BLOCKED: no credentials; run not executed')
    } else {
      await mainRun(environment, apiKey)
    }
  }
  if (stages.includes('error')) {
    if (apiKey === undefined) {
      check('RUN-2', 'failure-case headless task exits 0', false, 'BLOCKED: no credentials; run not executed')
    } else {
      await errorRun(environment, apiKey)
    }
  }

  return finalize(environment)
}

/** Print/record the PASS/FAIL summary and compute the exit code. */
function finalize(environment) {
  const passed = RESULTS.filter(entry => entry.pass).length
  const failed = RESULTS.length - passed
  const lines = RESULTS.map(entry => `${entry.pass ? 'PASS' : 'FAIL'}  [${entry.id}] ${entry.title}${entry.detail ? ` — ${entry.detail}` : ''}`)
  lines.push('', `SUMMARY: ${passed} passed, ${failed} failed, ${RESULTS.length} assertions`)
  say(`\n== summary`)
  for (const line of lines) say(line)
  writeArtifact('assertions.log', lines.join('\n') + '\n')
  if (ARTIFACTS !== undefined) {
    say(`\nartifacts: ${ARTIFACTS}`)
    for (const name of ['commands.log', 'dump-config.stdout.txt', 'main.stdout.txt', 'main.stderr.txt', 'main-call-records.jsonl', 'stats-after-main.json', 'error.stdout.txt', 'error.stderr.txt', 'error-call-records.jsonl', 'stats-after-error.json', 'assertions.log']) {
      if (existsSync(join(ARTIFACTS, name))) say(`  - ${name}`)
    }
  }
  const rerun = `node ${relative(process.cwd(), SELF) || SELF}`
  say(`\nrerun: ${rerun}`)
  return failed === 0 && RESULTS.length > 0 ? 0 : 1
}

/* Run when executed directly (not when imported by run-error-case.mjs). */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SELF)) {
  main().then(
    code => process.exit(code),
    (error) => {
      say(`\nFAIL  [harness] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    },
  )
}
