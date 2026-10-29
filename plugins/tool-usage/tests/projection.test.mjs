/**
 * Unit tests for the `toolUsage` session projection (`src/projection.ts`,
 * compiled to `lib/projection.js`).
 *
 * Contract: `.tmp/ui-contract.md` (wire view) and the design contract section on
 * the Client projection. The fold must be pure (same state reference for
 * unrelated events), JSON-serializable, bounded, and privacy-bounded: the wire
 * view carries explanations and shell commands but never raw arguments.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import {
  TOOL_USAGE_PROJECTION_KEY,
  TOOL_USAGE_PROJECTION_STATE_VERSION,
  createToolUsageProjectionDefinition,
} from '../lib/projection.js'

/** Resolved config with persistence disabled, so tests touch no filesystem. */
function makeConfig(overrides = {}) {
  return resolveConfig({ outputDir: '', ...overrides })
}

/** One definition plus reset state for a test case. */
function makeProjection(overrides) {
  const config = makeConfig(overrides)
  const definition = createToolUsageProjectionDefinition(config)
  return { config, definition, state: definition.init({}, 0) }
}

/** Fold a list of synthetic Session events. */
function fold(definition, state, events) {
  let next = state
  for (const event of events) next = definition.apply(next, event)
  return next
}

const turnStart = (turn, time) => ({ type: 'turn/start', time, data: { turn } })

const toolCall = (turn, step, callId, name, args, time) => ({
  type: 'tool/call',
  time,
  data: { turn, step, callId, name, arguments: JSON.stringify(args) },
})

const toolResult = (turn, step, callId, time, { isError = false, content = [], code } = {}) => ({
  type: 'tool/result',
  time,
  data: {
    turn,
    step,
    message: { source: { callId }, isError, content },
    ...(code === undefined ? {} : { error: { name: 'ToolError', code, reason: 'aborted by caller' } }),
  },
})

const turnEnd = (turn, time, kind = 'completed') => ({
  type: 'turn/end',
  time,
  data: { turn, reason: { kind } },
})

test('exposes the documented projection key and state version', () => {
  assert.equal(TOOL_USAGE_PROJECTION_KEY, 'toolUsage')
  assert.equal(TOOL_USAGE_PROJECTION_STATE_VERSION, 1)
  const { definition } = makeProjection()
  assert.equal(definition.key, 'toolUsage')
  assert.equal(definition.stateVersion, 1)
  assert.equal(definition.wire.summary, false)
  assert.equal(definition.stateSchema.parse({ ok: true }).ok, true)
  assert.equal(definition.wire.viewSchema.parse({ ok: true }).ok, true)
})

test('a running bash call is visible with its command and explanation', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'pnpm test', cwd: '/repo' }, 1_100),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.totals.calls, 1)
  assert.equal(view.totals.running, 1)
  assert.equal(view.totals.settled, 0)
  assert.deepEqual(view.running, [{
    callId: 'c1',
    tool: 'bash',
    summary: '执行 Shell 命令：pnpm test（目录 /repo）',
    command: 'pnpm test',
    turn: 1,
    step: 1,
    startTime: 1_100,
  }])
  assert.equal(view.calls.length, 0)
  assert.equal(view.turns.length, 1)
  assert.equal(view.turns[0].outcome, 'open')
  assert.equal(view.turns[0].endTime, null)
  assert.equal(view.generatedAt, 1_100)
})

test('a settled call records duration, status and whole-session totals', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'pnpm test' }, 1_100),
    toolResult(1, 1, 'c1', 1_350),
    turnEnd(1, 1_400),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.totals.calls, 1)
  assert.equal(view.totals.settled, 1)
  assert.equal(view.totals.errors, 0)
  assert.equal(view.totals.running, 0)
  assert.equal(view.totals.totalMs, 250)
  assert.equal(view.totals.avgMs, 250)
  assert.equal(view.totals.tools, 1)
  assert.equal(view.totals.turns, 1)
  assert.deepEqual(view.calls, [{
    callId: 'c1',
    tool: 'bash',
    summary: '执行 Shell 命令：pnpm test',
    command: 'pnpm test',
    turn: 1,
    step: 1,
    startTime: 1_100,
    endTime: 1_350,
    durationMs: 250,
    status: 'ok',
    error: null,
  }])
  assert.deepEqual(view.byTool, [{
    tool: 'bash',
    calls: 1,
    errors: 0,
    totalMs: 250,
    avgMs: 250,
    maxMs: 250,
    lastMs: 250,
    lastAt: 1_350,
  }])
  assert.equal(view.turns[0].endTime, 1_400)
  assert.equal(view.turns[0].outcome, 'completed')
  assert.equal(view.turns[0].totalMs, 250)
})

test('a failed call carries a bounded error and counts as an error', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'read', { file_path: '/missing.txt' }, 1_100),
    toolResult(1, 1, 'c1', 1_200, {
      isError: true,
      content: [{ type: 'text', text: 'ENOENT: no such file or directory' }, { type: 'text', text: 'second' }],
    }),
    turnEnd(1, 1_300),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.totals.errors, 1)
  assert.equal(view.calls[0].status, 'error')
  assert.equal(view.calls[0].error, 'ENOENT: no such file or directory')
  assert.equal(view.byTool[0].errors, 1)
  assert.equal(view.turns[0].errors, 1)
})

test('an aborted call is a non-failure outcome', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'sleep 10' }, 1_100),
    toolResult(1, 1, 'c1', 1_200, { isError: true, code: 'ABORTED' }),
    turnEnd(1, 1_300),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.calls[0].status, 'aborted')
  assert.equal(view.calls[0].error, null)
  assert.equal(view.totals.errors, 0)
})

test('a turn ending with an unsettled call settles it as aborted', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'sleep 10' }, 1_100),
    turnEnd(1, 1_900, 'aborted'),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.totals.running, 0)
  assert.equal(view.calls.length, 1)
  assert.equal(view.calls[0].status, 'aborted')
  assert.equal(view.calls[0].durationMs, 800)
  assert.equal(view.turns[0].outcome, 'aborted')
})

test('unrelated events keep the same state reference', () => {
  const { definition, state } = makeProjection()
  const next = definition.apply(state, { type: 'step/start', time: 5, data: { turn: 1, step: 1 } })
  assert.equal(next, state)
  const duplicate = definition.apply(state, { type: 'tool/result', time: 5, data: { message: { source: { callId: 'unknown' } } } })
  assert.equal(duplicate, state)
})

test('arguments are redacted and never leak into the wire view', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'echo hello', apiKey: 'sk-live-secret', password: 'hunter2' }, 1_100),
  ])
  const serialized = JSON.stringify(definition.wire.view(state))
  assert.equal(serialized.includes('sk-live-secret'), false)
  assert.equal(serialized.includes('hunter2'), false)
  assert.equal(serialized.includes('"arguments"'), false)
  assert.equal(serialized.includes('apiKey'), false)
  assert.equal(serialized.includes('echo hello'), true)
})

test('explain off emits no summary but still records the command', () => {
  const { definition } = makeProjection({ explain: 'off' })
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'ls -la' }, 1_100),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.running[0].summary, '')
  assert.equal(view.running[0].command, 'ls -la')
})

test('uiCommandChars clips the shell command line', () => {
  const { definition } = makeProjection({ uiCommandChars: 10 })
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'echo 0123456789abcdef' }, 1_100),
  ])
  assert.equal(definition.wire.view(state).running[0].command, 'echo 0123…')
})

test('the recent-call and recent-turn rings are bounded while totals keep counting', () => {
  const { definition } = makeProjection({ uiRecentCalls: 3, uiRecentTurns: 2 })
  const events = []
  for (let turn = 1; turn <= 4; turn += 1) {
    events.push(turnStart(turn, turn * 1_000))
    for (let index = 0; index < 3; index += 1) {
      const callId = `t${turn}-c${index}`
      events.push(toolCall(turn, 1, callId, 'bash', { command: `echo ${turn}-${index}` }, turn * 1_000 + index * 10 + 1))
      events.push(toolResult(turn, 1, callId, turn * 1_000 + index * 10 + 6))
    }
    events.push(turnEnd(turn, turn * 1_000 + 100))
  }
  const state = fold(definition, definition.init({}, 0), events)
  const view = definition.wire.view(state)
  assert.equal(view.calls.length, 3)
  assert.equal(view.turns.length, 2)
  assert.equal(view.totals.calls, 12)
  assert.equal(view.totals.settled, 12)
  assert.equal(view.totals.turns, 4)
  assert.equal(view.totals.tools, 1)
  assert.equal(view.byTool[0].calls, 12)
  assert.deepEqual(view.turns.map(row => row.turn), [3, 4])
})

test('tool rows are sorted by call count and capped at 20', () => {
  const { definition } = makeProjection()
  const events = [turnStart(1, 1_000)]
  for (let index = 0; index < 25; index += 1) {
    const callId = `c${index}`
    events.push(toolCall(1, 1, callId, `tool_${String(index).padStart(2, '0')}`, {}, 1_000 + index))
    events.push(toolResult(1, 1, callId, 1_000 + index + 1))
  }
  // Give tool_24 three extra calls so it must be on top.
  for (let index = 0; index < 3; index += 1) {
    const callId = `extra${index}`
    events.push(toolCall(1, 1, callId, 'tool_24', {}, 2_000 + index))
    events.push(toolResult(1, 1, callId, 2_000 + index + 1))
  }
  const view = definition.wire.view(fold(definition, definition.init({}, 0), events))
  assert.equal(view.byTool.length, 20)
  assert.equal(view.byTool[0].tool, 'tool_24')
  assert.equal(view.byTool[0].calls, 4)
  assert.equal(view.totals.tools, 25)
})

test('the fold state is plain JSON (persisted-cache precondition)', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'pnpm test' }, 1_100),
    toolResult(1, 1, 'c1', 1_300),
    turnEnd(1, 1_400),
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
})

test('init produces an empty, renderable view', () => {
  const { definition } = makeProjection()
  const view = definition.wire.view(definition.init({}, 0))
  assert.equal(view.v, 1)
  assert.equal(view.generatedAt, 0)
  assert.deepEqual(view.totals, {
    calls: 0,
    settled: 0,
    errors: 0,
    running: 0,
    totalMs: 0,
    avgMs: 0,
    maxMs: 0,
    tools: 0,
    turns: 0,
  })
  assert.deepEqual(view.byTool, [])
  assert.deepEqual(view.turns, [])
  assert.deepEqual(view.calls, [])
  assert.deepEqual(view.running, [])
})

test('the view carries the configured explanation language', () => {
  const { definition } = makeProjection({ language: 'en' })
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'bash', { command: 'pnpm test' }, 1_100),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.language, 'en')
  assert.equal(view.running[0].summary, 'Run shell command: pnpm test')
})

test('non-bash tools carry no command line', () => {
  const { definition } = makeProjection()
  const state = fold(definition, definition.init({}, 0), [
    turnStart(1, 1_000),
    toolCall(1, 1, 'c1', 'read', { file_path: '/tmp/a.ts' }, 1_100),
  ])
  const view = definition.wire.view(state)
  assert.equal(view.running[0].command, null)
  assert.match(view.running[0].summary, /读取文件/)
})

test('unknown bounded fields do not throw on malformed event data', () => {
  const { definition, state } = makeProjection()
  const cases = [
    { type: 'tool/call', time: 1, data: null },
    { type: 'tool/call', time: 1, data: { turn: 'x' } },
    { type: 'tool/result', time: 1, data: {} },
    { type: 'turn/start', time: 1, data: {} },
    { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'made-up' } } },
    { type: 'something/else', time: 1, data: {} },
  ]
  for (const event of cases) {
    assert.doesNotThrow(() => definition.apply(state, event))
  }
})
