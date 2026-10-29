/**
 * Unit tests for the in-memory aggregation store (`src/stats.ts`, compiled to
 * `lib/stats.js`).
 *
 * Contract: docs/DESIGN.md §10. All records are injected with fixed
 * timestamps and durations so every aggregate below is deterministic.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StatsStore } from '../lib/stats.js'

/** Fixed base timestamp so `lastAt` assertions are stable. */
const T0 = Date.parse('2026-01-02T03:04:05.000Z')

/** Build one valid CallRecord; see docs/DESIGN.md §6. */
function makeRecord(seq, overrides = {}) {
  const record = {
    v: 1,
    seq,
    at: new Date(T0 + seq * 1000).toISOString(),
    tool: 'bash',
    durationMs: 100,
    status: 'ok',
    paramsTruncated: false,
    redacted: false,
    explanation: { summary: `解释 ${seq}` },
    ...overrides,
  }
  return record
}

/** Find one per-tool aggregate by name (tool order is not part of the contract). */
function toolEntry(snapshot, name) {
  return snapshot.tools.find(tool => tool.name === name)
}

/** Query used by most tests; flags off so payloads stay small. */
function allQuery(overrides = {}) {
  return {
    scope: 'all',
    limit: 100,
    includeParams: false,
    includeExplanations: false,
    ...overrides,
  }
}

test('per-tool count/error/total/min/max/avg aggregates are computed from records', () => {
  const store = new StatsStore({ recentLimit: 50 })
  store.record(makeRecord(1, { tool: 'bash', durationMs: 100, sessionId: 's1' }))
  store.record(makeRecord(2, { tool: 'bash', durationMs: 300, sessionId: 's1' }))
  store.record(makeRecord(3, { tool: 'bash', durationMs: 50, status: 'error', sessionId: 's2' }))
  store.record(makeRecord(4, { tool: 'read', durationMs: 20, sessionId: 's1' }))

  const snapshot = store.snapshot(allQuery())
  assert.equal(snapshot.scope.kind, 'all')
  assert.equal(snapshot.totals.calls, 4)
  assert.equal(snapshot.totals.errors, 1)
  assert.equal(snapshot.totals.totalMs, 470)
  assert.equal(snapshot.totals.avgMs, 117.5)
  assert.equal(snapshot.totals.maxMs, 300)
  assert.equal(snapshot.totals.sessionCount, 2)
  assert.equal(typeof snapshot.generatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)))

  const bash = toolEntry(snapshot, 'bash')
  assert.ok(bash, 'bash aggregate must exist')
  assert.equal(bash.calls, 3)
  assert.equal(bash.errors, 1)
  assert.equal(bash.totalMs, 450)
  assert.equal(bash.avgMs, 150)
  assert.equal(bash.minMs, 50)
  assert.equal(bash.maxMs, 300)
  assert.equal(bash.lastMs, 50, 'lastMs is the newest call duration')
  assert.equal(bash.lastAt, makeRecord(3).at, 'lastAt is the newest call timestamp')
  assert.equal(bash.errorRate, 0.3333, 'errorRate is rounded to four decimals')

  const read = toolEntry(snapshot, 'read')
  assert.equal(read.calls, 1)
  assert.equal(read.errors, 0)
  assert.equal(read.errorRate, 0)
  assert.equal(read.minMs, 20)
  assert.equal(read.maxMs, 20)
})

test('per-session scope only aggregates the requested session', () => {
  const store = new StatsStore({ recentLimit: 50 })
  store.record(makeRecord(1, { tool: 'bash', sessionId: 's1' }))
  store.record(makeRecord(2, { tool: 'read', status: 'error', sessionId: 's1' }))
  store.record(makeRecord(3, { tool: 'bash', sessionId: 's2' }))
  store.record(makeRecord(4, { tool: 'grep', sessionId: undefined }))

  const sessionOne = store.snapshot(allQuery({ scope: 'current', sessionId: 's1' }))
  assert.equal(sessionOne.scope.kind, 'session')
  assert.equal(sessionOne.scope.sessionId, 's1')
  assert.equal(sessionOne.totals.calls, 2)
  assert.equal(sessionOne.totals.errors, 1)
  assert.equal(toolEntry(sessionOne, 'grep'), undefined)
  assert.deepEqual(sessionOne.tools.map(tool => tool.name).sort(), ['bash', 'read'])
  assert.equal(sessionOne.totals.sessionCount, 1)

  const unscoped = store.snapshot(allQuery({ scope: 'current' }))
  assert.equal(unscoped.totals.calls, 1, 'current scope without a session id matches unscoped calls')
  assert.equal(unscoped.tools[0].name, 'grep')

  const global = store.snapshot(allQuery())
  assert.equal(global.totals.calls, 4)
  assert.equal(global.totals.sessionCount, 2, 'unscoped calls do not add a session')
})

test('recent calls are newest-first and honour the query limit', () => {
  const store = new StatsStore({ recentLimit: 50 })
  for (let seq = 1; seq <= 5; seq += 1) store.record(makeRecord(seq))

  const limited = store.snapshot(allQuery({ limit: 3 }))
  assert.deepEqual(limited.recent.map(call => call.seq), [5, 4, 3])
  assert.equal(limited.recent[0].tool, 'bash')
  assert.equal(typeof limited.recent[0].durationMs, 'number')
  assert.equal(typeof limited.recent[0].status, 'string')

  const everything = store.snapshot(allQuery({ limit: 100 }))
  assert.deepEqual(everything.recent.map(call => call.seq), [5, 4, 3, 2, 1])
})

test('the recent ring buffer caps retained calls at recentLimit', () => {
  const store = new StatsStore({ recentLimit: 2 })
  for (let seq = 1; seq <= 4; seq += 1) store.record(makeRecord(seq))
  const snapshot = store.snapshot(allQuery({ limit: 100 }))
  assert.deepEqual(snapshot.recent.map(call => call.seq), [4, 3])
  assert.equal(snapshot.totals.calls, 4, 'aggregates still count every call')
})

test('params and explanations are included only when requested', () => {
  const store = new StatsStore({ recentLimit: 10 })
  store.record(makeRecord(1, {
    tool: 'bash',
    params: { command: 'echo hi' },
    explanation: { summary: '执行 Shell 命令：echo hi', details: ['line'] },
  }))

  const without = store.snapshot(allQuery())
  assert.equal(without.recent[0].params, undefined)
  assert.equal(without.recent[0].explanation, undefined)

  const withPayload = store.snapshot(allQuery({ includeParams: true, includeExplanations: true }))
  assert.deepEqual(withPayload.recent[0].params, { command: 'echo hi' })
  assert.equal(typeof withPayload.recent[0].explanation.summary, 'string')
  assert.ok(withPayload.recent[0].explanation.summary.includes('echo hi'))
})

test('statusCounts classify all four statuses per tool', () => {
  const store = new StatsStore({ recentLimit: 20 })
  store.record(makeRecord(1, { tool: 'bash', status: 'ok' }))
  store.record(makeRecord(2, { tool: 'bash', status: 'ok' }))
  store.record(makeRecord(3, { tool: 'bash', status: 'error' }))
  store.record(makeRecord(4, { tool: 'web_fetch', status: 'aborted' }))
  store.record(makeRecord(5, { tool: 'web_fetch', status: 'threw' }))

  const snapshot = store.snapshot(allQuery())
  const persisted = store.toJSON()
  const bashCounts = persisted.byTool.bash.statusCounts
  assert.equal(bashCounts.ok, 2)
  assert.equal(bashCounts.error, 1)
  assert.equal(bashCounts.aborted, 0)
  assert.equal(bashCounts.threw, 0)

  const fetchCounts = persisted.byTool.web_fetch.statusCounts
  assert.equal(fetchCounts.aborted, 1)
  assert.equal(fetchCounts.threw, 1)
  // `errors` counts real failures: status=error and status=threw. Aborted calls
  // are tracked in statusCounts but are not failures (the caller cancelled them).
  assert.equal(snapshot.totals.errors, 2, 'status=error and status=threw are failures')
  assert.equal(persisted.totals.statusCounts.aborted, 1)
  assert.equal(persisted.totals.statusCounts.error, 1)
  assert.equal(persisted.totals.statusCounts.threw, 1)
})

test('slowThresholdMs marks slow calls in aggregates and recent rows', () => {
  const store = new StatsStore({ recentLimit: 10, slowThresholdMs: 100 })
  store.record(makeRecord(1, { durationMs: 50 }))
  store.record(makeRecord(2, { durationMs: 150 }))

  const snapshot = store.snapshot(allQuery())
  assert.equal(snapshot.totals.slowCalls, 1)
  assert.equal(toolEntry(snapshot, 'bash').slowCalls, 1)
  assert.deepEqual(snapshot.recent.map(call => call.slow), [true, false])
  assert.equal(store.toJSON().totals.slowCalls, 1)
})

test('milliseconds are rounded to one decimal and avg divides by call count', () => {
  const store = new StatsStore({ recentLimit: 10 })
  store.record(makeRecord(1, { durationMs: 1.234 }))
  store.record(makeRecord(2, { durationMs: 2.345 }))

  const snapshot = store.snapshot(allQuery())
  assert.equal(snapshot.totals.totalMs, 3.6)
  assert.equal(snapshot.totals.avgMs, 1.8)
  assert.equal(snapshot.totals.maxMs, 2.3)
  const bash = toolEntry(snapshot, 'bash')
  assert.equal(bash.minMs, 1.2)
  assert.equal(bash.maxMs, 2.3)
  assert.equal(bash.avgMs, 1.8)
})

test('toJSON -> restore preserves aggregates, sessions and sessionCount', () => {
  const original = new StatsStore({ recentLimit: 10 })
  original.record(makeRecord(1, { tool: 'bash', durationMs: 100, sessionId: 's1' }))
  original.record(makeRecord(2, { tool: 'read', durationMs: 40, status: 'error', sessionId: 's1' }))
  original.record(makeRecord(3, { tool: 'bash', durationMs: 300, sessionId: 's2' }))

  const persisted = original.toJSON()
  assert.equal(persisted.v, 1)
  assert.equal(typeof persisted.updatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(persisted.updatedAt)))
  assert.equal(typeof persisted.totals, 'object')
  assert.equal(typeof persisted.byTool, 'object')
  assert.equal(typeof persisted.bySession, 'object')
  assert.equal(persisted.sessionCount, 2)

  const restored = new StatsStore({ recentLimit: 10 })
  assert.doesNotThrow(() => restored.restore(persisted))
  const before = original.snapshot(allQuery())
  const after = restored.snapshot(allQuery())
  assert.deepEqual(after.totals, before.totals)
  assert.deepEqual(
    after.tools.map(tool => tool.name).sort(),
    before.tools.map(tool => tool.name).sort(),
  )
  for (const name of after.tools.map(tool => tool.name)) {
    const a = toolEntry(after, name)
    const b = toolEntry(before, name)
    assert.equal(a.calls, b.calls)
    assert.equal(a.errors, b.errors)
    assert.equal(a.totalMs, b.totalMs)
    assert.equal(a.avgMs, b.avgMs)
    assert.equal(a.minMs, b.minMs)
    assert.equal(a.maxMs, b.maxMs)
    assert.equal(a.lastMs, b.lastMs)
    assert.equal(a.lastAt, b.lastAt)
  }
  assert.deepEqual(after.recent, [], 'recent calls are not persisted; the JSONL is their source')

  // Session attribution survives the round-trip.
  const sessionRestored = restored.snapshot(allQuery({ scope: 'current', sessionId: 's2' }))
  assert.equal(sessionRestored.totals.calls, 1)
  assert.equal(sessionRestored.totals.totalMs, 300)
})

test('reset() clears all aggregates and recent calls', () => {
  const store = new StatsStore({ recentLimit: 10 })
  store.record(makeRecord(1, { sessionId: 's1' }))
  store.record(makeRecord(2, { sessionId: 's2' }))
  store.reset()

  const snapshot = store.snapshot(allQuery())
  assert.equal(snapshot.totals.calls, 0)
  assert.deepEqual(snapshot.tools, [])
  assert.deepEqual(snapshot.recent, [])
  assert.equal(store.toJSON().totals.calls, 0)
})

test('reset({ sessionId }) clears only that session', () => {
  const store = new StatsStore({ recentLimit: 10 })
  store.record(makeRecord(1, { tool: 'bash', sessionId: 's1' }))
  store.record(makeRecord(2, { tool: 'read', sessionId: 's1' }))
  store.record(makeRecord(3, { tool: 'grep', sessionId: 's2' }))

  store.reset({ sessionId: 's1' })
  const global = store.snapshot(allQuery())
  assert.equal(global.totals.calls, 1)
  assert.deepEqual(global.tools.map(tool => tool.name), ['grep'])
  assert.deepEqual(global.recent.map(call => call.seq), [3])

  const sessionOne = store.snapshot(allQuery({ scope: 'current', sessionId: 's1' }))
  assert.equal(sessionOne.totals.calls, 0)
})

test('restore ignores malformed persisted shapes without throwing', () => {
  const malformed = [
    null,
    undefined,
    42,
    'not stats',
    [],
    {},
    { v: 2, totals: { calls: 5 }, byTool: {}, bySession: {}, sessionCount: 1 },
    { v: 1, totals: { calls: 'many' }, byTool: {}, bySession: {}, sessionCount: 0 },
    { v: 1, totals: {}, byTool: [], bySession: {}, sessionCount: 0 },
    { v: 1, totals: {}, byTool: { bash: 'nope' }, bySession: {}, sessionCount: 0 },
  ]

  for (const payload of malformed) {
    const store = new StatsStore({ recentLimit: 10 })
    assert.doesNotThrow(() => store.restore(payload), `restore must tolerate ${JSON.stringify(payload)}`)
    const snapshot = store.snapshot(allQuery())
    assert.equal(snapshot.totals.calls, 0)
    assert.deepEqual(snapshot.tools, [])
  }
})

test('a malformed restore does not corrupt an already-restored store', () => {
  const source = new StatsStore({ recentLimit: 10 })
  source.record(makeRecord(1, { tool: 'bash', sessionId: 's1' }))
  const persisted = source.toJSON()

  const store = new StatsStore({ recentLimit: 10 })
  store.restore(persisted)
  store.restore('garbage')
  const snapshot = store.snapshot(allQuery())
  assert.equal(snapshot.totals.calls, 1)
  assert.equal(toolEntry(snapshot, 'bash').calls, 1)
})

test('empty store snapshots are well-formed zero values', () => {
  const store = new StatsStore({ recentLimit: 10 })
  const snapshot = store.snapshot(allQuery())
  assert.equal(snapshot.totals.calls, 0)
  assert.equal(snapshot.totals.errors, 0)
  assert.equal(snapshot.totals.totalMs, 0)
  assert.equal(snapshot.totals.avgMs, 0)
  assert.deepEqual(snapshot.tools, [])
  assert.deepEqual(snapshot.recent, [])
})

test('restore merges persisted aggregates into a live store and keeps the recent ring', () => {
  const persistedStore = new StatsStore({ recentLimit: 10 })
  persistedStore.record(makeRecord(1, { tool: 'bash', durationMs: 100, sessionId: 's1' }))
  persistedStore.record(makeRecord(2, { tool: 'read', durationMs: 50, status: 'error', sessionId: 's1' }))
  persistedStore.record(makeRecord(3, { tool: 'bash', durationMs: 200, sessionId: 's2' }))
  const persisted = persistedStore.toJSON()

  // Simulate the startup race: a live call is recorded while the snapshot read is
  // still in flight, then restore resolves and merges into the live store.
  const live = new StatsStore({ recentLimit: 10 })
  live.record(makeRecord(10, { tool: 'grep', durationMs: 30, sessionId: 's1' }))
  live.restore(persisted)

  const snapshot = live.snapshot(allQuery({ includeExplanations: true }))
  assert.equal(snapshot.totals.calls, 4, 'restored + live calls are additive')
  assert.equal(snapshot.totals.errors, 1)
  assert.equal(snapshot.totals.totalMs, 380)
  assert.equal(snapshot.totals.sessionCount, 2)
  assert.deepEqual(snapshot.recent.map(call => call.seq), [10], 'the live ring must survive the merge')
  assert.deepEqual(snapshot.tools.map(tool => tool.name).sort(), ['bash', 'grep', 'read'])

  const bash = toolEntry(snapshot, 'bash')
  assert.equal(bash.calls, 2)
  assert.equal(bash.totalMs, 300)
  assert.equal(bash.minMs, 100)
  assert.equal(bash.maxMs, 200)

  const sessionOne = live.snapshot(allQuery({ scope: 'current', sessionId: 's1' }))
  assert.equal(sessionOne.totals.calls, 3, 'restored session rows merge with live session rows')
  const sessionTwo = live.snapshot(allQuery({ scope: 'current', sessionId: 's2' }))
  assert.equal(sessionTwo.totals.calls, 1)
})

test('tools with equal call counts are ordered by code point, not locale', () => {
  const store = new StatsStore({ recentLimit: 10 })
  const names = ['b', 'a', 'B', 'Ａ']
  names.forEach((tool, index) => store.record(makeRecord(index + 1, { tool })))
  const ordered = store.snapshot(allQuery()).tools.map(tool => tool.name)
  assert.deepEqual(ordered, ['B', 'a', 'b', 'Ａ'])
})
