/**
 * Plugin integration tests with a fake Cordis context.
 *
 * Contract: docs/DESIGN.md §5.1, §5.2, §15.6. `apply()` is fed a minimal fake
 * context exposing `on`, `tools.register`, `tools.get`, `logger`, `effect` and
 * `inject`; the emitted `tools/execute` listener and the registered `tool_usage`
 * definition are then exercised end-to-end against a temp output directory.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

/** Small delay standing in for real tool execution time. */
function sleep(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

/** Poll an async predicate until it is truthy or the timeout expires. */
async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(intervalMs)
  }
}

/** Logger-shaped spy; Cordis loggers are callable and also carry methods. */
function makeLogger(logs) {
  const record = (...args) => { logs.push(args) }
  return Object.assign(record, {
    info: record,
    warn: record,
    debug: record,
    error: record,
  })
}

/** Wrap an effect body result into an async cleanup function. */
function disposerFor(value) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  return async () => {}
}

/**
 * Minimal fake Cordis context. Records listeners, registered tools, command
 * definitions and effect cleanups so tests can drive and dispose the plugin.
 */
function makeFakeContext({
  commandsAvailable = false,
  commandDisposeDelayMs = 0,
  catalog = {},
  projectionsAvailable = false,
  projectionsRegisterError = undefined,
} = {}) {
  const state = {
    listeners: [],
    tools: new Map(),
    commands: [],
    cleanups: [],
    injections: [],
    logs: [],
    projections: [],
    projectionReleases: 0,
  }
  const logger = makeLogger(state.logs)

  function disposerOf(fn) {
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      await fn()
    }
  }

  function makeCtx() {
    const ctx = {
      logger,
      on(event, handler) {
        const entry = { event, handler, removed: false }
        state.listeners.push(entry)
        return () => { entry.removed = true }
      },
      effect(body, _label) {
        const cleanup = disposerFor(body())
        state.cleanups.push(cleanup)
        return cleanup
      },
      inject(deps, callback) {
        const dependencyList = Array.isArray(deps) ? deps : [deps]
        state.injections.push(dependencyList)
        const disposals = []
        if (dependencyList.includes('commands') && commandsAvailable) {
          const childCtx = makeCtx()
          childCtx.commands = {
            register(definition) {
              state.commands.push(definition)
              return () => {
                state.commands = state.commands.filter(entry => entry !== definition)
              }
            },
          }
          const cleanup = disposerFor(callback(childCtx))
          disposals.push(async () => {
            if (commandDisposeDelayMs > 0) await sleep(commandDisposeDelayMs)
            await cleanup()
          })
        }
        if (dependencyList.includes('sessionProjections') && projectionsAvailable) {
          const childCtx = makeCtx()
          childCtx.sessionProjections = {
            register(definition) {
              if (projectionsRegisterError !== undefined) throw projectionsRegisterError
              state.projections.push(definition)
              return Promise.resolve({
                dispose: async () => { state.projectionReleases += 1 },
              })
            },
          }
          const cleanup = disposerFor(callback(childCtx))
          disposals.push(cleanup)
        }
        // Real Cordis returns a Fiber; `index.ts` disposes it via `fiber.dispose()`.
        return {
          async dispose() {
            for (const disposal of disposals) await disposal()
          },
        }
      },
      tools: {
        register(definition) {
          assert.ok(definition && typeof definition.name === 'string', 'tools.register needs a named definition')
          state.tools.set(definition.name, definition)
          return () => { state.tools.delete(definition.name) }
        },
        get(toolName) {
          return state.tools.get(toolName) ?? catalog[toolName]
        },
      },
    }
    return ctx
  }

  const ctx = makeCtx()
  return { ctx, state, logger }
}

/** Find the active `tools/execute` waterfall listener. */
function toolsExecuteListener(state) {
  const entry = state.listeners.find(listener => listener.event === 'tools/execute' && !listener.removed)
  assert.ok(entry, 'the plugin must subscribe to tools/execute')
  return entry.handler
}

/** Build a dispatch execution value (docs/DESIGN.md §5.2 / DSH ToolExecutionInput). */
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

/** Build a successful normalized ToolExecutionResult. */
function successResult(value = 'hi') {
  return { isError: false, content: [{ type: 'text', text: String(value) }], value }
}

/** Build a failed normalized ToolExecutionResult. */
function failureResult({ message = 'boom', code } = {}) {
  return {
    isError: true,
    error: { message, ...(code === undefined ? {} : { info: { name: 'HarnessError', code } }) },
    content: [{ type: 'text', text: message }],
  }
}

/** Create a disposable temp directory configured as the outputDir. */
async function makeOutputDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tool-usage-plugin-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }).catch(() => {}) })
  return directory
}

/** List calls-YYYY-MM-DD.jsonl files in a directory. */
async function listCallFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

/** Read and parse every JSONL record currently persisted in a directory. */
async function readCallRecords(directory) {
  const records = []
  for (const file of await listCallFiles(directory)) {
    const text = await readFile(join(directory, file), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) records.push(JSON.parse(line))
    }
  }
  return records
}

/** Await all effect cleanups in reverse registration order (Cordis LIFO teardown). */
async function disposeContext(state) {
  for (const cleanup of [...state.cleanups].reverse()) {
    await cleanup()
  }
}

/** Execute the registered tool_usage definition with a fake run context. */
async function runToolUsage(state, args, agentId = 'sess-1') {
  const tool = state.tools.get('tool_usage')
  assert.ok(tool, 'apply() must register the tool_usage tool')
  return tool.execute(args, {
    callId: 'call-tool-usage',
    rootCallId: 'call-tool-usage',
    name: 'tool_usage',
    arguments: args,
    agent: { id: agentId },
    signal: new AbortController().signal,
    token: Symbol('tool-token'),
    deferContext() {},
    concludeTurn() {},
  })
}

test('plugin exports name/inject and registers the tool plus the execute listener', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext()
  assert.equal(name, 'tool-usage')
  assert.deepEqual(inject, ['tools'])

  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })
  assert.ok(state.tools.has('tool_usage'), 'tool_usage must be registered')
  assert.equal(typeof state.tools.get('tool_usage').execute, 'function')
  assert.ok(state.listeners.some(listener => listener.event === 'tools/execute'))
  await disposeContext(state)
})

test('the tools/execute wrapper records timing, redaction, explanation and session', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext()
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })

  const listener = toolsExecuteListener(state)
  const execution = makeExecution({
    name: 'bash',
    arguments: { command: 'echo hi', token: 'super-secret' },
    agent: { id: 'sess-1' },
  })
  const originalResult = successResult('hi')
  const returned = await listener(execution, async () => {
    await sleep(20)
    return originalResult
  })
  assert.equal(returned, originalResult, 'the wrapper must return the original result object unchanged')

  const records = await waitUntil(async () => {
    const persisted = await readCallRecords(outputDir)
    return persisted.length >= 1 ? persisted : undefined
  }, { label: 'the JSONL call record' })

  const record = records[0]
  assert.equal(record.v, 1)
  assert.equal(record.tool, 'bash')
  assert.equal(record.callId, 'call-1')
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(record.status, 'ok')
  assert.equal(typeof record.durationMs, 'number')
  assert.ok(record.durationMs >= 15, `durationMs should reflect the ~20ms call, got ${record.durationMs}`)
  assert.ok(record.durationMs < 2000, `durationMs should stay in a sane range, got ${record.durationMs}`)
  assert.equal(typeof record.at, 'string')
  assert.ok(!Number.isNaN(Date.parse(record.at)))
  assert.equal(record.params.command, 'echo hi')
  assert.equal(record.params.token, '[REDACTED]', 'sensitive arguments must be redacted in the log')
  assert.equal(record.redacted, true)
  assert.equal(record.paramsTruncated, false)
  assert.equal(typeof record.explanation.summary, 'string')
  assert.ok(record.explanation.summary.includes('echo hi'), 'the record carries a human-readable explanation')
  assert.ok(!record.explanation.summary.includes('\n'))

  const snapshot = await runToolUsage(state, { view: 'summary', scope: 'all' })
  assert.ok(snapshot.totals.calls >= 1)
  await disposeContext(state)
})

test('outcome statuses map to ok / error / aborted / threw', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext()
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })
  const listener = toolsExecuteListener(state)

  const okResult = successResult('ok')
  assert.equal(await listener(makeExecution({ callId: 'call-ok' }), async () => okResult), okResult)

  const errorResult = failureResult({ message: 'file missing', code: 'ENOENT' })
  assert.equal(await listener(makeExecution({ callId: 'call-error' }), async () => errorResult), errorResult)

  const abortedResult = failureResult({ message: 'aborted', code: 'ABORTED' })
  assert.equal(await listener(makeExecution({ callId: 'call-aborted' }), async () => abortedResult), abortedResult)

  const abortedEarly = failureResult({ message: 'aborted early', code: 'ABORTED_BEFORE_DISPATCH' })
  await listener(makeExecution({ callId: 'call-aborted-early' }), async () => abortedEarly)

  const thrown = new Error('kaboom')
  await assert.rejects(
    () => listener(makeExecution({ callId: 'call-threw', name: 'read', arguments: { file_path: '/nope' } }), async () => { throw thrown }),
    (rejection) => rejection === thrown,
    'a rejected next() must be rethrown unchanged',
  )

  const records = await waitUntil(async () => {
    const persisted = await readCallRecords(outputDir)
    return persisted.length >= 5 ? persisted : undefined
  }, { label: 'five recorded calls' })

  const byCallId = new Map(records.map(record => [record.callId, record]))
  assert.equal(byCallId.get('call-ok').status, 'ok')
  assert.equal(byCallId.get('call-error').status, 'error')
  assert.equal(byCallId.get('call-aborted').status, 'aborted')
  assert.equal(byCallId.get('call-aborted-early').status, 'aborted')
  assert.equal(byCallId.get('call-threw').status, 'threw')
  assert.equal(byCallId.get('call-threw').error.message, 'kaboom')
  await disposeContext(state)
})

test('recording never throws the tool call even when the log cannot persist', async (t) => {
  const root = await makeOutputDir(t)
  const blockedPath = join(root, 'blocked')
  await writeFile(blockedPath, 'sentinel', 'utf8')

  const { ctx, state } = makeFakeContext()
  apply(ctx, { outputDir: blockedPath, statsWriteDebounceMs: 10, restoreStats: false })
  const listener = toolsExecuteListener(state)

  const result = successResult('unaffected')
  const returned = await listener(makeExecution(), async () => result)
  assert.equal(returned, result, 'persistence failures must not change the tool call outcome')
  assert.equal(await readFile(blockedPath, 'utf8'), 'sentinel', 'the conflicting file must be left alone')
  await disposeContext(state) // must not throw
})

test('disabled config registers nothing and writes nothing', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext()
  apply(ctx, { enabled: false, outputDir, statsWriteDebounceMs: 10 })

  assert.equal(state.tools.size, 0, 'disabled plugin must not register tools')
  assert.equal(state.listeners.filter(listener => listener.event === 'tools/execute').length, 0)
  assert.equal(state.injections.length, 0, 'disabled plugin must not wire the command service')
  assert.ok(state.logs.length >= 1, 'disabled state should be logged once')
  assert.deepEqual(await listCallFiles(outputDir), [])
  await disposeContext(state)
})

test('tools/execute listener and tool_usage operate without a commands service (headless)', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ commandsAvailable: false })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })
  assert.equal(state.commands.length, 0, 'no command must be registered without the commands service')

  const listener = toolsExecuteListener(state)
  await listener(makeExecution(), async () => successResult())
  const snapshot = await runToolUsage(state, { view: 'summary', scope: 'all' })
  assert.ok(snapshot.totals.calls >= 1, 'the tool must work in a headless profile')
  await disposeContext(state)
})

test('the optional /tool-usage command registers and handles every documented form', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ commandsAvailable: true })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })

  assert.equal(state.commands.length, 1, 'exactly one command must be registered')
  const command = state.commands[0]
  assert.equal(command.name, 'tool-usage')
  assert.equal(typeof command.description, 'string')
  assert.equal(typeof command.handler, 'function')

  const listener = toolsExecuteListener(state)
  for (const name of ['bash', 'read', 'grep']) {
    await listener(makeExecution({ callId: `call-${name}`, name }), async () => successResult())
  }
  await waitUntil(async () => (await readCallRecords(outputDir)).length >= 3)

  const invocation = (rawInput, agentId = 'sess-1') => ({
    agent: { id: agentId },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
    commandId: 'cmd-1',
  })

  const summary = await command.handler(invocation(''))
  assert.equal(summary.kind, 'success')
  assert.match(summary.text, /总计 3 次调用/u, `summary must report the three recorded calls: ${summary.text}`)
  assert.ok(summary.text.includes('bash'), `summary should mention recorded tools: ${summary.text}`)

  const global = await command.handler(invocation('all'))
  assert.equal(global.kind, 'success')
  assert.ok(global.text.includes('全部会话'), `the all scope must be reported: ${global.text}`)

  const recent = await command.handler(invocation('recent 2'))
  assert.equal(recent.kind, 'success')
  const recentLines = recent.text.split('\n').filter(line => /^\d+\. \[/u.test(line))
  assert.equal(recentLines.length, 2, `recent 2 must list exactly two calls: ${recent.text}`)
  assert.ok(recentLines[0].includes('grep'), `the newest call must come first: ${recentLines[0]}`)
  assert.ok(recentLines[1].includes('read'))
  assert.ok(!recentLines.some(line => line.includes('bash')), 'the older bash call must be outside the recent window')

  const reset = await command.handler(invocation('reset'))
  assert.equal(reset.kind, 'success')
  assert.match(reset.text, /JSONL/u, 'the reset reply must state that the JSONL log is untouched')
  const afterReset = await command.handler(invocation(''))
  assert.equal(afterReset.kind, 'success')
  assert.match(afterReset.text, /总计 0 次调用/u, `reset must clear the in-memory totals: ${afterReset.text}`)

  const usageError = await command.handler(invocation('bogus-argument'))
  assert.equal(usageError.kind, 'error')
  assert.match(usageError.text, /用法/u)
  assert.match(usageError.text, /tool-usage/u)
  await disposeContext(state)
})

test('dispose flushes the JSONL log and writes the final stats snapshot', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext()
  apply(ctx, { outputDir, statsWriteDebounceMs: 60_000, restoreStats: false }) // long debounce: dispose must flush

  const listener = toolsExecuteListener(state)
  await listener(makeExecution(), async () => successResult())
  await disposeContext(state)

  const records = await readCallRecords(outputDir)
  assert.equal(records.length, 1, 'dispose must flush the queued append')
  assert.equal(records[0].tool, 'bash')

  const stats = JSON.parse(await readFile(join(outputDir, 'stats.json'), 'utf8'))
  assert.equal(stats.v, 1)
  assert.ok(stats.totals.calls >= 1, 'dispose must persist the stats snapshot even with a long debounce')
})

test('stats are restored from disk on the next apply and keep counting', async (t) => {
  const outputDir = await makeOutputDir(t)

  const first = makeFakeContext()
  apply(first.ctx, { outputDir, statsWriteDebounceMs: 10 })
  await toolsExecuteListener(first.state)(makeExecution(), async () => successResult())
  await disposeContext(first.state)

  const persisted = JSON.parse(await readFile(join(outputDir, 'stats.json'), 'utf8'))
  assert.ok(persisted.totals.calls >= 1)

  const second = makeFakeContext()
  apply(second.ctx, { outputDir, statsWriteDebounceMs: 10 })
  const restored = await waitUntil(async () => {
    try {
      const snapshot = await runToolUsage(second.state, { view: 'summary', scope: 'all' })
      return snapshot.totals.calls >= persisted.totals.calls ? snapshot : undefined
    } catch {
      return undefined
    }
  }, { label: 'restored statistics' })
  assert.ok(restored.totals.calls >= persisted.totals.calls)

  await toolsExecuteListener(second.state)(makeExecution(), async () => successResult())
  const incremented = await runToolUsage(second.state, { view: 'summary', scope: 'all' })
  assert.ok(incremented.totals.calls > restored.totals.calls, 'new calls keep aggregating after a restart')
  await disposeContext(second.state)
})

test('calls from two sessions are attributed and scoped separately', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext()
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })
  const listener = toolsExecuteListener(state)

  await listener(makeExecution({ callId: 'a', agent: { id: 'sess-a' } }), async () => successResult())
  await listener(makeExecution({ callId: 'b', agent: { id: 'sess-b' } }), async () => successResult())

  const records = await waitUntil(async () => {
    const persisted = await readCallRecords(outputDir)
    return persisted.length >= 2 ? persisted : undefined
  })
  assert.deepEqual(records.map(record => record.sessionId).sort(), ['sess-a', 'sess-b'])

  const sessionA = await runToolUsage(state, { view: 'summary', scope: 'session' }, 'sess-a')
  assert.equal(sessionA.totals.calls, 1)
  assert.equal(sessionA.scope.sessionId, 'sess-a')
  const global = await runToolUsage(state, { view: 'summary', scope: 'all' })
  assert.equal(global.totals.sessionCount, 2)
  await disposeContext(state)
})

test('an unregistered tool explain view reports an error, not a crash', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ catalog: {} })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })
  const tool = state.tools.get('tool_usage')
  await assert.rejects(() => tool.execute({ view: 'explain', tool: 'ghost_tool' }, {
    callId: 'call-explain',
    rootCallId: 'call-explain',
    name: 'tool_usage',
    arguments: { view: 'explain', tool: 'ghost_tool' },
    agent: { id: 'sess-1' },
    signal: new AbortController().signal,
    token: Symbol('tool-token'),
    deferContext() {},
    concludeTurn() {},
  }))
  await disposeContext(state)
})

test('a call recorded while the startup restore is in flight survives the merge', async (t) => {
  const outputDir = await makeOutputDir(t)

  // First run: one persisted call, flushed on dispose.
  const first = makeFakeContext()
  apply(first.ctx, { outputDir, statsWriteDebounceMs: 10 })
  await toolsExecuteListener(first.state)(makeExecution({ callId: 'old', name: 'oldt' }), async () => successResult())
  await disposeContext(first.state)
  const persisted = JSON.parse(await readFile(join(outputDir, 'stats.json'), 'utf8'))
  assert.ok(persisted.totals.calls >= 1)

  // Second run: record immediately, while the asynchronous restore is still in flight.
  const second = makeFakeContext()
  apply(second.ctx, { outputDir, statsWriteDebounceMs: 10 })
  await toolsExecuteListener(second.state)(makeExecution({ callId: 'live', name: 'livetool' }), async () => successResult())

  const snapshot = await waitUntil(async () => {
    const current = await runToolUsage(second.state, { view: 'summary', scope: 'all' })
    return current.totals.calls >= persisted.totals.calls + 1 ? current : undefined
  }, { label: 'restored aggregates plus the live call' })

  assert.equal(snapshot.totals.calls, persisted.totals.calls + 1, 'the live call must not be erased by the late restore')
  assert.ok(snapshot.recent.some(call => call.tool === 'livetool'), 'the live recent ring must survive the merge')
  assert.ok(snapshot.tools.some(tool => tool.name === 'oldt'), 'the restored tool aggregates must be merged in')
  await disposeContext(second.state)

  // The merged view must be persisted: a snapshot scheduled before the merge (the
  // live call alone) must not overwrite restored history on shutdown.
  const finalStats = JSON.parse(await readFile(join(outputDir, 'stats.json'), 'utf8'))
  assert.equal(finalStats.totals.calls, persisted.totals.calls + 1, 'the merged aggregates must be what is persisted')
})

test('effect teardown awaits the nested command fiber disposal', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ commandsAvailable: true, commandDisposeDelayMs: 20 })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })
  assert.equal(state.commands.length, 1)

  await disposeContext(state)
  assert.equal(state.commands.length, 0, 'the command registration must be gone once teardown resolves')
})

test('/tool-usage reset rewrites the aggregate snapshot and keeps the JSONL log', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ commandsAvailable: true })
  // Long debounce: a pre-reset snapshot is pending when reset is called.
  apply(ctx, { outputDir, statsWriteDebounceMs: 60_000, restoreStats: false })
  const listener = toolsExecuteListener(state)
  await listener(makeExecution({ callId: 'before-reset' }), async () => successResult())
  await waitUntil(async () => (await readCallRecords(outputDir)).length >= 1)

  const command = state.commands[0]
  const invocation = rawInput => ({
    agent: { id: 'sess-1' },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
    commandId: 'cmd-1',
  })
  const reply = await command.handler(invocation('reset'))
  assert.equal(reply.kind, 'success')
  await disposeContext(state)

  const persisted = JSON.parse(await readFile(join(outputDir, 'stats.json'), 'utf8'))
  assert.equal(persisted.totals.calls, 0, 'the cleared state must be persisted, not the pre-reset snapshot')
  assert.deepEqual((await readCallRecords(outputDir)).map(record => record.callId), ['before-reset'])

  // A restart restores the cleared snapshot, not the pre-reset counts.
  const second = makeFakeContext()
  apply(second.ctx, { outputDir, statsWriteDebounceMs: 10 })
  await waitUntil(
    () => second.state.logs.some(args => String(args[0]).includes('restored persisted statistics')),
    { label: 'the startup restore to complete' },
  )
  const restored = await runToolUsage(second.state, { view: 'summary', scope: 'all' })
  assert.equal(restored.totals.calls, 0)
  await disposeContext(second.state)
})


test('the Web UI projection registers by default and releases on teardown', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ projectionsAvailable: true })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })

  assert.equal(state.projections.length, 1, 'the toolUsage projection must be registered once')
  const definition = state.projections[0]
  assert.equal(definition.key, 'toolUsage')
  assert.equal(definition.stateVersion, 1)
  assert.equal(definition.wire.summary, false)

  await disposeContext(state)
  await waitUntil(() => state.projectionReleases >= 1, { label: 'the projection registration release' })
})

test('uiEnabled false skips the projection while keeping recording', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ projectionsAvailable: true })
  apply(ctx, { uiEnabled: false, outputDir, statsWriteDebounceMs: 10, restoreStats: false })

  assert.equal(state.projections.length, 0, 'uiEnabled false must not register the projection')
  const listener = toolsExecuteListener(state)
  await listener(makeExecution({ callId: 'ui-off' }), async () => successResult())
  await waitUntil(async () => (await readCallRecords(outputDir)).length >= 1)
  await disposeContext(state)
})

test('a missing projection registry keeps the plugin loadable and recording', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({ projectionsAvailable: false })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })

  assert.equal(state.projections.length, 0)
  const listener = toolsExecuteListener(state)
  await listener(makeExecution({ callId: 'no-registry' }), async () => successResult())
  await waitUntil(async () => (await readCallRecords(outputDir)).length >= 1)
  assert.equal(state.logs.some(args => String(args[0]).includes('toolUsage projection')), false)
  await disposeContext(state)
})

test('a failing projection registration warns and leaves the recorder working', async (t) => {
  const outputDir = await makeOutputDir(t)
  const { ctx, state } = makeFakeContext({
    projectionsAvailable: true,
    projectionsRegisterError: new Error('projection registry unavailable'),
  })
  apply(ctx, { outputDir, statsWriteDebounceMs: 10, restoreStats: false })

  assert.ok(
    state.logs.some(args => String(args[0]).includes('failed to register the toolUsage projection')),
    'a projection registration failure must be logged as a warning',
  )
  const listener = toolsExecuteListener(state)
  await listener(makeExecution({ callId: 'projection-failed' }), async () => successResult())
  await waitUntil(async () => (await readCallRecords(outputDir)).length >= 1)
  await disposeContext(state)
})
