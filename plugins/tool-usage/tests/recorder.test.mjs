/**
 * Unit tests for the `tools/execute` wrapper (`src/recorder.ts`, compiled to
 * `lib/recorder.js`).
 *
 * Contract: docs/DESIGN.md §5.2. The wrapper must preserve the result object
 * and rejections exactly, measure wall-clock duration, map every outcome to the
 * documented status, and swallow all recording failures.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MIN_TRUNCATED_PARAMS_JSON_CHARS, ToolUsageRecorder } from '../lib/recorder.js'
import { StatsStore } from '../lib/stats.js'
import { resolveConfig } from '../lib/config.js'

/** Small delay used to give the measured duration a non-zero value. */
function sleep(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

/** Build a valid normalized ToolExecutionResult (success). */
function successResult(value = 'hi') {
  return { isError: false, content: [{ type: 'text', text: String(value) }], value }
}

/** Build a valid normalized ToolExecutionResult (failure). */
function failureResult({ message = 'boom', code } = {}) {
  const error = { message, ...(code === undefined ? {} : { info: { name: 'HarnessError', code } }) }
  return { isError: true, error, content: [{ type: 'text', text: message }] }
}

/** Build a fake ToolDispatchExecution. */
function makeExecution(overrides = {}) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'bash',
    arguments: { command: 'echo hi' },
    agent: { id: 'sess-1' },
    signal: new AbortController().signal,
    token: Symbol('execution-token'),
    ...overrides,
  }
}

/** Logger-shaped spy. */
function makeLogger() {
  const messages = []
  const record = (...args) => { messages.push(args) }
  return Object.assign(record, {
    info: record,
    warn: record,
    debug: record,
    error: record,
    messages,
  })
}

/** In-memory JsonlCallLog stand-in: records every call for assertions. */
function makeFakeLog() {
  const state = { appended: [], scheduled: [], disposed: false, disposeError: undefined }
  return {
    state,
    log: {
      append(record) { state.appended.push(record) },
      scheduleStats(snapshot) { state.scheduled.push(snapshot) },
      async dispose() {
        state.disposed = true
        if (state.disposeError !== undefined) throw state.disposeError
      },
    },
  }
}

/** Build the recorder with a real StatsStore and an in-memory log. */
function makeHarness({ configOverrides = {}, stats, log, logger = makeLogger(), resolveToolSchema } = {}) {
  const config = resolveConfig({
    outputDir: '',
    language: 'zh',
    explain: 'detailed',
    maxParamChars: 500,
    maxStringChars: 200,
    ...configOverrides,
  }, { logger: makeLogger() })
  const statsStore = stats ?? new StatsStore({ recentLimit: 100 })
  const fakeLog = log === undefined
    ? makeFakeLog()
    : { state: { appended: [], scheduled: [], disposed: false }, log }
  const schemaCalls = []
  const resolver = resolveToolSchema ?? ((toolName) => {
    schemaCalls.push(toolName)
    return { description: 'Run shell commands', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
  })
  const recorder = new ToolUsageRecorder({
    stats: statsStore,
    log: fakeLog.log,
    config,
    logger,
    resolveToolSchema: resolver,
  })
  return { recorder, stats: statsStore, logState: fakeLog.state, logger, config, schemaCalls }
}

test('an ok call is timed, explained, redacted, and recorded once', async () => {
  const harness = makeHarness()
  const execution = makeExecution({
    arguments: { command: 'echo hi', token: 'super-secret' },
  })
  const originalResult = successResult('hi')

  const returned = await harness.recorder.wrap(execution, async () => {
    await sleep(20)
    return originalResult
  })
  assert.equal(returned, originalResult, 'the wrapper must return the exact result object')

  assert.equal(harness.logState.appended.length, 1)
  assert.equal(harness.logState.scheduled.length, 1)
  const record = harness.logState.appended[0]
  assert.equal(record.v, 1)
  assert.equal(record.seq, 1)
  assert.equal(record.tool, 'bash')
  assert.equal(record.callId, 'call-1')
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(record.status, 'ok')
  assert.equal(typeof record.at, 'string')
  assert.ok(!Number.isNaN(Date.parse(record.at)))
  assert.ok(record.durationMs >= 15, `expected a ~20ms duration, got ${record.durationMs}`)
  assert.ok(record.durationMs < 2000, `duration should stay in a sane range, got ${record.durationMs}`)
  assert.equal(record.params.command, 'echo hi')
  assert.equal(record.params.token, '[REDACTED]')
  assert.equal(record.redacted, true)
  assert.equal(record.paramsTruncated, false)
  assert.equal(record.error, undefined)
  assert.equal(typeof record.explanation.summary, 'string')
  assert.ok(record.explanation.summary.includes('echo hi'))
  assert.ok(!record.explanation.summary.includes('super-secret'), 'explanations must see the redacted arguments only')
  assert.ok(!JSON.stringify(record.params).includes('super-secret'))

  // The scheduled snapshot is a valid persisted aggregate.
  assert.equal(harness.logState.scheduled[0].v, 1)
  assert.equal(harness.logState.scheduled[0].totals.calls, 1)
  assert.equal(harness.stats.snapshot({ scope: 'all', limit: 10, includeParams: false, includeExplanations: false }).totals.calls, 1)
})

test('structured failures map to status=error and keep the failure detail', async () => {
  const harness = makeHarness()
  const failure = failureResult({ message: 'file missing', code: 'ENOENT' })
  const returned = await harness.recorder.wrap(makeExecution({ name: 'read', arguments: { file_path: '/nope' } }), async () => failure)
  assert.equal(returned, failure)

  const record = harness.logState.appended[0]
  assert.equal(record.status, 'error')
  assert.equal(record.error.message, 'file missing')
  assert.equal(record.error.code, 'ENOENT')
  const snapshot = harness.stats.snapshot({ scope: 'all', limit: 10, includeParams: false, includeExplanations: false })
  assert.equal(snapshot.totals.errors, 1)
})

test('canonical abort codes map to status=aborted', async () => {
  const harness = makeHarness()
  for (const code of ['ABORTED', 'ABORTED_BEFORE_DISPATCH']) {
    await harness.recorder.wrap(makeExecution({ callId: `call-${code}` }), async () => failureResult({ message: 'cancelled', code }))
  }
  const statuses = harness.logState.appended.map(record => record.status)
  assert.deepEqual(statuses, ['aborted', 'aborted'])
  assert.equal(harness.logState.appended[0].error.code, 'ABORTED')
  assert.equal(harness.logState.appended[1].error.code, 'ABORTED_BEFORE_DISPATCH')
})

test('a rejected next() is rethrown unchanged and recorded as status=threw', async () => {
  const harness = makeHarness()
  const thrown = new Error('kaboom')
  await assert.rejects(
    () => harness.recorder.wrap(makeExecution(), async () => { throw thrown }),
    (rejection) => rejection === thrown,
    'the rejection identity must be preserved',
  )

  assert.equal(harness.logState.appended.length, 1)
  const record = harness.logState.appended[0]
  assert.equal(record.status, 'threw')
  assert.equal(record.error.message, 'kaboom')
  const snapshot = harness.stats.snapshot({ scope: 'all', limit: 10, includeParams: false, includeExplanations: false })
  assert.equal(snapshot.totals.errors, 1, 'threw is a real failure and counts in totals.errors')
  assert.equal(harness.stats.toJSON().totals.statusCounts.error, 0)
  assert.equal(harness.stats.toJSON().totals.statusCounts.threw, 1)
})

test('sequence numbers are monotonic and sessions are attributed separately', async () => {
  const harness = makeHarness()
  await harness.recorder.wrap(makeExecution({ callId: 'a', agent: { id: 'sess-a' } }), async () => successResult())
  await harness.recorder.wrap(makeExecution({ callId: 'b', agent: { id: 'sess-b' } }), async () => successResult())
  await harness.recorder.wrap(makeExecution({ callId: 'c', agent: undefined }), async () => successResult())

  assert.deepEqual(harness.logState.appended.map(record => record.seq), [1, 2, 3])
  assert.deepEqual(harness.logState.appended.map(record => record.sessionId), ['sess-a', 'sess-b', undefined])

  const sessionA = harness.stats.snapshot({ scope: 'current', sessionId: 'sess-a', limit: 10, includeParams: false, includeExplanations: false })
  assert.equal(sessionA.totals.calls, 1)
  const unscoped = harness.stats.snapshot({ scope: 'current', limit: 10, includeParams: false, includeExplanations: false })
  assert.equal(unscoped.totals.calls, 1, 'a missing agent means an unscoped record')
})

test('recording failures never escape the wrapper or change the result', async () => {
  const logger = makeLogger()
  const stats = {
    record() { throw new Error('stats boom') },
    toJSON() { return { v: 1, updatedAt: new Date(0).toISOString(), totals: {}, byTool: {}, bySession: {}, sessionCount: 0 } },
  }
  const log = {
    append() { throw new Error('log boom') },
    scheduleStats() { throw new Error('schedule boom') },
    async dispose() { throw new Error('dispose boom') },
  }
  const harness = makeHarness({ stats, log, logger })
  const result = successResult('unaffected')
  const returned = await harness.recorder.wrap(makeExecution(), async () => result)
  assert.equal(returned, result)
  assert.ok(logger.messages.length >= 3, `each failure class should warn once, got ${JSON.stringify(logger.messages)}`)

  // Repeated failures do not warn again (warn-once bookkeeping).
  const warningsAfterFirst = logger.messages.length
  await harness.recorder.wrap(makeExecution(), async () => result)
  assert.equal(logger.messages.length, warningsAfterFirst, 'warnings are emitted once per failure class')

  await assert.doesNotReject(() => harness.recorder.dispose(), 'dispose must swallow log failures')
  assert.ok(logger.messages.length > warningsAfterFirst, 'the dispose failure is reported too')
})

test('an explainer/schema failure falls back to the tool name and does not break recording', async () => {
  const logger = makeLogger()
  const harness = makeHarness({
    logger,
    resolveToolSchema() { throw new Error('schema registry down') },
  })
  const result = successResult()
  const returned = await harness.recorder.wrap(makeExecution(), async () => result)
  assert.equal(returned, result)
  assert.equal(harness.logState.appended[0].explanation.summary, 'bash', 'fallback summary is the tool name')
  assert.ok(logger.messages.length >= 1)
})

test('explain=off records an empty summary and skips schema lookups', async () => {
  const harness = makeHarness({ configOverrides: { explain: 'off' } })
  await harness.recorder.wrap(makeExecution(), async () => successResult())
  const record = harness.logState.appended[0]
  assert.equal(record.explanation.summary, '')
  assert.deepEqual(harness.schemaCalls, [])
})

test('the whole-params cap keeps valid JSON and sets paramsTruncated', async () => {
  const harness = makeHarness({ configOverrides: { maxParamChars: 40 } })
  const bigArguments = { command: `echo ${'x'.repeat(200)}` }
  await harness.recorder.wrap(makeExecution({ arguments: bigArguments }), async () => successResult())

  const record = harness.logState.appended[0]
  assert.equal(record.paramsTruncated, true)
  assert.deepEqual(Object.keys(record.params), ['_truncated'])
  assert.equal(typeof record.params._truncated, 'string')
  assert.ok(record.params._truncated.endsWith('…'))
  assert.ok(JSON.parse(JSON.stringify(record.params)), 'params must stay valid JSON')
})

test('the wrapper leaves exec.signal and call identity untouched', async () => {
  const harness = makeHarness()
  const signal = new AbortController().signal
  const execution = makeExecution({ signal })
  let seenSignal
  await harness.recorder.wrap(execution, async () => {
    seenSignal = execution.signal
    return successResult()
  })
  assert.equal(seenSignal, signal)
  assert.equal(execution.signal, signal)
  assert.equal(execution.callId, 'call-1')
  assert.equal(execution.name, 'bash')
})

test('dispose flushes the log', async () => {
  const harness = makeHarness()
  await harness.recorder.wrap(makeExecution(), async () => successResult())
  await harness.recorder.dispose()
  assert.equal(harness.logState.disposed, true)
})

test('missing agent id and non-string call id are omitted from the record', async () => {
  const harness = makeHarness()
  await harness.recorder.wrap(makeExecution({ agent: { id: '' }, callId: 42 }), async () => successResult())
  const record = harness.logState.appended[0]
  assert.equal('sessionId' in record, false)
  assert.equal('callId' in record, false)
})

test('failure error messages are capped at maxStringChars and keep the record bounded', async () => {
  const harness = makeHarness({ configOverrides: { maxStringChars: 64 } })
  const longMessage = `${'E'.repeat(100_000)}SECRET-TOKEN-VALUE`

  await harness.recorder.wrap(
    makeExecution({ name: 'read', arguments: { file_path: '/nope' } }),
    async () => failureResult({ message: longMessage }),
  )

  const record = harness.logState.appended[0]
  assert.equal(record.status, 'error')
  assert.equal(record.error.message.length, 64, 'the message must be capped at maxStringChars')
  assert.ok(record.error.message.endsWith('…'))
  assert.ok(!record.error.message.includes('SECRET-TOKEN-VALUE'), 'the capped message must not retain the tail')
  assert.ok(JSON.stringify(record).length < 10_000, `the whole record must stay bounded, got ${JSON.stringify(record).length}`)
  assert.equal(harness.stats.snapshot({ scope: 'all', limit: 10, includeParams: false, includeExplanations: false }).totals.errors, 1)
})

test('thrown string and thrown object messages are capped too', async () => {
  const harness = makeHarness({ configOverrides: { maxStringChars: 32 } })
  const bigString = 'T'.repeat(5000)
  await assert.rejects(
    () => harness.recorder.wrap(makeExecution({ callId: 'call-str' }), async () => { throw bigString }),
    rejected => rejected === bigString,
    'the raw rejection must still be rethrown unchanged',
  )
  await assert.rejects(
    () => harness.recorder.wrap(makeExecution({ callId: 'call-obj' }), async () => { throw { message: bigString, code: 'E_THROWN' } }),
    rejected => typeof rejected === 'object' && rejected !== null && rejected.message === bigString,
  )

  const [thrownString, thrownObject] = harness.logState.appended
  assert.equal(thrownString.status, 'threw')
  assert.equal(thrownString.error.message.length, 32)
  assert.ok(thrownString.error.message.endsWith('…'))
  assert.equal(thrownObject.status, 'threw')
  assert.equal(thrownObject.error.message.length, 32)
  assert.equal(thrownObject.error.code, 'E_THROWN')
})

test('failure error codes are capped at maxStringChars too', async () => {
  const harness = makeHarness({ configOverrides: { maxStringChars: 64 } })
  await harness.recorder.wrap(
    makeExecution({ name: 'read' }),
    async () => failureResult({ message: 'denied', code: `${'C'.repeat(100_000)}TAIL-SECRET` }),
  )

  const record = harness.logState.appended[0]
  assert.equal(record.status, 'error')
  assert.equal(record.error.code.length, 64, 'the code must be capped at maxStringChars')
  assert.ok(record.error.code.endsWith('…'))
  assert.ok(!record.error.code.includes('TAIL-SECRET'))
  assert.ok(JSON.stringify(record).length < 10_000, 'the whole record must stay bounded')
})

test('maxParamChars is a true upper bound on the serialized params preview', async () => {
  for (const cap of [40, 200]) {
    const harness = makeHarness({ configOverrides: { maxParamChars: cap } })
    await harness.recorder.wrap(
      makeExecution({ arguments: { command: `echo ${'x'.repeat(500)}` } }),
      async () => successResult(),
    )
    const record = harness.logState.appended[0]
    const serialized = JSON.stringify(record.params)
    assert.equal(record.paramsTruncated, true)
    assert.deepEqual(Object.keys(record.params), ['_truncated'])
    assert.ok(record.params._truncated.endsWith('…'))
    assert.ok(serialized.length <= cap, `params JSON is ${serialized.length} chars, cap is ${cap}`)
    assert.deepEqual(JSON.parse(serialized), record.params, 'the preview must stay valid JSON')
  }
})

test('a maxParamChars below the preview envelope is raised to the documented floor', async () => {
  const harness = makeHarness({ configOverrides: { maxParamChars: 1 } })
  await harness.recorder.wrap(
    makeExecution({ arguments: { command: `echo ${'x'.repeat(500)}` } }),
    async () => successResult(),
  )
  const record = harness.logState.appended[0]
  const serialized = JSON.stringify(record.params)
  assert.equal(serialized.length, MIN_TRUNCATED_PARAMS_JSON_CHARS)
  assert.deepEqual(JSON.parse(serialized), record.params)
})

test('a throwing argument getter is a recording failure, not a tool failure', async () => {
  const logger = makeLogger()
  const harness = makeHarness({ logger })
  const evilArguments = { safe: 1 }
  Object.defineProperty(evilArguments, 'boom', {
    enumerable: true,
    get() { throw new Error('getter boom') },
  })

  const result = successResult('unchanged')
  const returned = await harness.recorder.wrap(makeExecution({ arguments: evilArguments }), async () => result)
  assert.equal(returned, result, 'the tool result must be returned unchanged')
  assert.equal(harness.logState.appended.length, 0, 'no partial record may be written')
  assert.ok(
    logger.messages.some(message => String(message[0]).includes('failed to record a tool call')),
    `the recording failure must be reported through the logger: ${JSON.stringify(logger.messages)}`,
  )
})
