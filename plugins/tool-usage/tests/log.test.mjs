/**
 * Unit tests for the JSONL call log + atomic stats snapshot (`src/log.ts`,
 * compiled to `lib/log.js`).
 *
 * Contract: docs/DESIGN.md §11. Every test writes into a fresh mkdtemp
 * directory under os.tmpdir(); nothing is ever written inside the repository.
 */
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonlCallLog } from '../lib/log.js'

let sequence = 0

/** Build one valid CallRecord (docs/DESIGN.md §6). */
function makeRecord(overrides = {}) {
  sequence += 1
  return {
    v: 1,
    seq: sequence,
    at: new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + sequence * 1000).toISOString(),
    tool: 'bash',
    durationMs: 25,
    status: 'ok',
    params: { command: 'echo hi' },
    paramsTruncated: false,
    redacted: false,
    explanation: { summary: '执行 Shell 命令：echo hi' },
    ...overrides,
  }
}

/** Build a PersistedStats snapshot; the log treats it as opaque JSON. */
function makePersistedStats(calls = 1) {
  return {
    v: 1,
    updatedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString(),
    totals: { calls, errors: 0, totalMs: 25 * calls, avgMs: 25, maxMs: 25, slowCalls: 0, sessionCount: 1 },
    byTool: { bash: { calls, errors: 0, totalMs: 25 * calls, avgMs: 25, minMs: 25, maxMs: 25, lastMs: 25, lastAt: null } },
    bySession: { s1: { calls } },
    sessionCount: 1,
  }
}

/** Create a disposable temp directory outside the workspace. */
async function makeTempDir(t, prefix = 'tool-usage-log-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}) })
  return root
}

/** Logger-shaped spy accepted by LoggerLike. */
function makeLogger() {
  const messages = []
  const record = (...args) => { messages.push(args) }
  const logger = Object.assign(record, {
    info: record,
    warn: record,
    debug: record,
    error: record,
    messages,
  })
  return logger
}

/** All calls-YYYY-MM-DD.jsonl files currently present in a directory. */
async function listCallFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

/** Parse every JSONL record stored in a directory, in file/line order. */
async function readCallRecords(directory) {
  const files = await listCallFiles(directory)
  const records = []
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) records.push(JSON.parse(line))
    }
  }
  return records
}

/** Create a log with persistence enabled and a short debounce. */
function makeLog(directory, overrides = {}) {
  return new JsonlCallLog({
    directory,
    persistCalls: true,
    persistStats: true,
    debounceMs: 10,
    logger: makeLogger(),
    ...overrides,
  })
}

/** Small delay used only where the contract makes a write fire-and-forget. */
function sleep(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

test('append writes one JSON line per call, in order, and creates missing directories', async (t) => {
  const root = await makeTempDir(t)
  const directory = join(root, 'nested', 'calls')
  const log = makeLog(directory)

  log.append(makeRecord({ seq: 1, tool: 'bash' }))
  log.append(makeRecord({ seq: 2, tool: 'read' }))
  log.append(makeRecord({ seq: 3, tool: 'grep' }))
  await log.flush()

  const files = await listCallFiles(directory)
  assert.equal(files.length, 1, 'one daily JSONL file should be created')
  assert.match(files[0], /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/u)

  const records = await readCallRecords(directory)
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3])
  assert.deepEqual(records.map(record => record.tool), ['bash', 'read', 'grep'])
  assert.deepEqual(records[0].params, { command: 'echo hi' })
  assert.equal(records[1].explanation.summary.includes('echo hi'), true)
})

test('flush waits for fire-and-forget appends that were already queued', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root)
  for (let index = 0; index < 25; index += 1) {
    log.append(makeRecord({
      seq: index + 1,
      tool: index % 2 === 0 ? 'bash' : 'read',
    }))
  }
  await log.flush()
  const records = await readCallRecords(root)
  assert.equal(records.length, 25)
  assert.deepEqual(records.map(record => record.seq), Array.from({ length: 25 }, (_, index) => index + 1))
  assert.deepEqual(records.map(record => record.tool), Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 'bash' : 'read')))
})

test('scheduleStats + flush writes an atomic, parseable stats.json', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root)
  const persisted = makePersistedStats(3)
  log.scheduleStats(persisted)
  await log.flush()

  const statsRaw = await readFile(join(root, 'stats.json'), 'utf8')
  assert.deepEqual(JSON.parse(statsRaw), persisted)
  const files = await readdir(root)
  assert.deepEqual(
    files.filter(name => name.endsWith('.tmp')),
    [],
    'the temporary file must be renamed away, whatever its unique name',
  )
})

test('a debounced stats write coalesces to the most recent snapshot on flush', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root, { debounceMs: 60 })
  log.scheduleStats(makePersistedStats(1))
  log.scheduleStats(makePersistedStats(2))
  await log.flush()
  const parsed = JSON.parse(await readFile(join(root, 'stats.json'), 'utf8'))
  assert.equal(parsed.totals.calls, 2, 'flush must persist the latest scheduled snapshot immediately')
})

test('restoreStats round-trips the persisted snapshot and tolerates a missing file', async (t) => {
  const root = await makeTempDir(t)
  const expected = makePersistedStats(4)
  const first = makeLog(root)
  first.scheduleStats(expected)
  await first.flush()

  const second = makeLog(root)
  const restored = await second.restoreStats()
  assert.deepEqual(restored, expected)

  const emptyRoot = await makeTempDir(t)
  const emptyLog = makeLog(emptyRoot)
  assert.equal(await emptyLog.restoreStats(), undefined, 'ENOENT must yield undefined')
})

test('restoreStats ignores corrupt stats.json content', async (t) => {
  const root = await makeTempDir(t)
  await writeFile(join(root, 'stats.json'), '{ not valid json', 'utf8')
  const log = makeLog(root)
  assert.equal(await log.restoreStats(), undefined)
})

test('a directory that cannot be created never throws from append or flush', async (t) => {
  const root = await makeTempDir(t)
  const filePath = join(root, 'not-a-directory')
  await writeFile(filePath, 'sentinel', 'utf8')

  const logger = makeLogger()
  let log
  assert.doesNotThrow(() => {
    log = new JsonlCallLog({ directory: filePath, persistCalls: true, persistStats: true, debounceMs: 5, logger })
  }, 'construction must not throw when persistence is impossible')

  assert.doesNotThrow(() => log.append(makeRecord()))
  assert.doesNotThrow(() => log.scheduleStats(makePersistedStats()))
  await assert.doesNotReject(() => log.flush(), 'flush must swallow persistence failures')
  assert.equal(await readFile(filePath, 'utf8'), 'sentinel', 'the conflicting file must stay untouched')
  assert.ok(logger.messages.length >= 1, 'the failure must be reported through the logger')
})

test('a record that cannot be serialized does not break the append queue', async (t) => {
  const root = await makeTempDir(t)
  const logger = makeLogger()
  const log = makeLog(root, { logger })
  const circular = makeRecord({ seq: 900 })
  circular.self = circular

  assert.doesNotThrow(() => log.append(circular))
  assert.doesNotThrow(() => log.append(makeRecord({ seq: 901 })))
  await log.flush()

  const records = await readCallRecords(root)
  assert.deepEqual(records.map(record => record.seq), [901], 'the following valid append must still be written')
  assert.ok(logger.messages.length >= 1, 'serialization failure must be logged, not thrown')
})

test('persistCalls=false suppresses JSONL files but keeps the in-memory contract', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root, { persistCalls: false })
  log.append(makeRecord())
  await log.flush()
  assert.deepEqual(await listCallFiles(root), [])
})

test('persistStats=false suppresses stats.json', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root, { persistStats: false, persistCalls: false })
  log.scheduleStats(makePersistedStats())
  await log.flush()
  const files = await readdir(root).catch(() => [])
  assert.ok(!files.includes('stats.json'))
  assert.equal(await log.restoreStats(), undefined)
})

test('dispose flushes pending writes and drops appends that arrive afterwards', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root)

  log.append(makeRecord({ seq: 1, tool: 'before-dispose' }))
  log.scheduleStats(makePersistedStats(1))
  await log.dispose()

  let records = await readCallRecords(root)
  assert.deepEqual(records.map(record => record.tool), ['before-dispose'])
  const stats = JSON.parse(await readFile(join(root, 'stats.json'), 'utf8'))
  assert.equal(stats.totals.calls, 1, 'dispose writes the final stats snapshot')

  log.append(makeRecord({ seq: 2, tool: 'after-dispose' }))
  await log.flush().catch(() => {})
  await sleep(50)
  records = await readCallRecords(root)
  assert.deepEqual(records.map(record => record.tool), ['before-dispose'], 'later appends must be dropped')
})

test('dispose flushes pending appends without an explicit flush', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root)
  for (let index = 1; index <= 5; index += 1) log.append(makeRecord({ seq: index }))
  await log.dispose()
  const records = await readCallRecords(root)
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3, 4, 5])
})

test('new directories are 0700 and new log files are 0600', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file modes are not meaningful on Windows')
    return
  }
  const root = await makeTempDir(t)
  const directory = join(root, 'mode-check')
  const log = makeLog(directory)
  log.append(makeRecord({ seq: 1 }))
  log.scheduleStats(makePersistedStats(1))
  await log.flush()

  assert.equal((await stat(directory)).mode & 0o777, 0o700, 'the data directory is created 0700')
  const [file] = await listCallFiles(directory)
  assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600, 'the call log is created 0600')
  assert.equal((await stat(join(directory, 'stats.json'))).mode & 0o777, 0o600, 'the stats snapshot is 0600')
})

test('a pre-existing 0644 call log is tightened to 0600 on the next append', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file modes are not meaningful on Windows')
    return
  }
  const root = await makeTempDir(t)
  const seed = makeLog(root)
  seed.append(makeRecord({ seq: 1 }))
  await seed.flush()

  const [file] = await listCallFiles(root)
  const filePath = join(root, file)
  await chmod(filePath, 0o644)
  assert.equal((await stat(filePath)).mode & 0o777, 0o644)

  // A fresh writer (like a plugin restart) must re-tighten the existing file.
  const next = makeLog(root)
  next.append(makeRecord({ seq: 2 }))
  await next.flush()

  assert.equal((await stat(filePath)).mode & 0o777, 0o600)
  assert.deepEqual((await readCallRecords(root)).map(record => record.seq), [1, 2])
})

test('stats.json is written through a unique temporary file with no leftovers', async (t) => {
  const root = await makeTempDir(t)
  const log = makeLog(root)
  log.scheduleStats(makePersistedStats(2))
  await log.flush()

  const files = await readdir(root)
  assert.ok(files.includes('stats.json'))
  assert.deepEqual(files.filter(name => /^stats\.json\..*\.tmp$/u.test(name)), [])
  const parsed = JSON.parse(await readFile(join(root, 'stats.json'), 'utf8'))
  assert.equal(parsed.totals.calls, 2)
})

test('two writers racing on stats.json leave a complete snapshot and no temp files', async (t) => {
  const root = await makeTempDir(t)
  const first = makeLog(root)
  const second = makeLog(root)
  first.scheduleStats(makePersistedStats(1))
  second.scheduleStats(makePersistedStats(2))
  await Promise.all([first.flush(), second.flush()])

  const files = await readdir(root)
  assert.deepEqual(files.filter(name => name.endsWith('.tmp')), [])
  const parsed = JSON.parse(await readFile(join(root, 'stats.json'), 'utf8'))
  assert.ok([1, 2].includes(parsed.totals.calls), 'a complete last-writer snapshot must win')
})

test('a transient directory-creation failure is retried on a later append', async (t) => {
  const root = await makeTempDir(t)
  const blocked = join(root, 'blocked')
  await writeFile(blocked, 'sentinel', 'utf8')

  const logger = makeLogger()
  const log = makeLog(blocked, { logger })
  log.append(makeRecord({ seq: 1 }))
  await log.flush()
  assert.equal(await readFile(blocked, 'utf8'), 'sentinel', 'the obstruction must be left alone')
  assert.ok(logger.messages.length >= 1, 'the failed directory creation is reported once')

  // Clear the obstruction; the next append must retry mkdir and persist.
  await rm(blocked, { force: true })
  log.append(makeRecord({ seq: 2 }))
  await log.flush()
  const records = await readCallRecords(blocked)
  assert.deepEqual(records.map(record => record.seq), [2], 'persistence must recover after a transient failure')
})
