/**
 * Unit tests for the model-facing `tool_usage` tool (`src/tool.ts`, compiled
 * to `lib/tool.js`).
 *
 * Contract: docs/DESIGN.md §12. A fake registration-deps object supplies an
 * in-memory StatsStore, a resolved config and a schema resolver, then the tool
 * definition is executed directly with a fake ToolRunContext.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StatsStore } from '../lib/stats.js'
import { resolveConfig } from '../lib/config.js'
import { createToolUsageTool } from '../lib/tool.js'

const T0 = Date.parse('2026-02-03T04:05:06.000Z')

/** Build one valid CallRecord (docs/DESIGN.md §6). */
function makeRecord(seq, overrides = {}) {
  return {
    v: 1,
    seq,
    at: new Date(T0 + seq * 1000).toISOString(),
    tool: 'bash',
    durationMs: 100,
    status: 'ok',
    params: { command: `echo ${seq}` },
    paramsTruncated: false,
    redacted: false,
    explanation: { summary: `执行 Shell 命令：echo ${seq}` },
    ...overrides,
  }
}

/** Logger-shaped spy accepted by resolveConfig. */
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

/** Fake ToolRunContext: only the fields the tool may read are populated. */
function makeRunContext(agentId = 'sess-1') {
  return {
    callId: 'call-tool-usage',
    rootCallId: 'call-tool-usage',
    name: 'tool_usage',
    arguments: {},
    agent: { id: agentId },
    signal: new AbortController().signal,
    token: Symbol('tool-execution-token'),
    deferContext() {},
    concludeTurn() {},
  }
}

const SCHEMAS = {
  bash: {
    description: 'Run shell commands',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
    },
  },
  read: {
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File to read' },
      },
    },
  },
}

/** Build the tool plus its backing store, seeded with deterministic records. */
function makeTool({ language = 'zh', records = defaultRecords(), configOverrides = {}, schemas = SCHEMAS } = {}) {
  const config = resolveConfig({
    outputDir: '',
    language,
    recentLimit: 300,
    includeParamsInReport: true,
    ...configOverrides,
  }, { logger: makeLogger() })
  const stats = new StatsStore({ recentLimit: 300 })
  for (const record of records) stats.record(record)
  const resolvedSchemaRequests = []
  const resolveToolSchema = (name, agent) => {
    resolvedSchemaRequests.push({ name, agent })
    return schemas[name]
  }
  const tool = createToolUsageTool({ stats, config, resolveToolSchema })
  return { tool, stats, config, resolveToolSchema, resolvedSchemaRequests }
}

/** Two calls in sess-1, one read + one bash in sess-2. */
function defaultRecords() {
  return [
    makeRecord(1, { tool: 'bash', durationMs: 100, sessionId: 'sess-1' }),
    makeRecord(2, { tool: 'bash', durationMs: 300, sessionId: 'sess-1' }),
    makeRecord(3, { tool: 'read', durationMs: 40, sessionId: 'sess-2' }),
    makeRecord(4, { tool: 'bash', durationMs: 60, status: 'error', sessionId: 'sess-2' }),
  ]
}

/** Render the canonical output value into plain text. */
function renderText(tool, args, value) {
  const blocks = tool.output.render(args, value)
  assert.ok(Array.isArray(blocks))
  return blocks.map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : '')).join('\n')
}

test('the tool definition exposes the configured name, parameter schema and read-only metadata', () => {
  const { tool } = makeTool()
  assert.equal(tool.name, 'tool_usage')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 0)
  assert.equal(typeof tool.execute, 'function')

  const parameters = tool.parameters
  assert.equal(typeof parameters, 'object')
  const properties = parameters.properties
  assert.ok(properties, 'parameters must declare properties')
  for (const key of ['view', 'tool', 'scope', 'limit']) {
    assert.ok(properties[key], `parameters should declare ${key}`)
  }
  assert.deepEqual(properties.view.enum, ['summary', 'tools', 'recent', 'explain'])
  assert.deepEqual(properties.scope.enum, ['session', 'all'])
  assert.equal(properties.limit.type, 'integer')

  assert.equal(tool.isConcurrencySafe({ view: 'summary' }), true, 'the tool is read-only and concurrency-safe')
})

test('view=summary defaults to the current session snapshot', async () => {
  const { tool } = makeTool()
  const value = await tool.execute({ view: 'summary' }, makeRunContext('sess-1'))
  assert.equal(typeof value, 'object')
  assert.equal(value.scope.kind, 'session')
  assert.equal(value.scope.sessionId, 'sess-1')
  assert.equal(value.totals.calls, 2)
  assert.equal(value.totals.totalMs, 400)
  assert.deepEqual(value.tools.map(entry => entry.name), ['bash'])
  assert.equal(value.recent.length, 2)
})

test('view=summary with scope=all spans sessions', async () => {
  const { tool } = makeTool()
  const value = await tool.execute({ view: 'summary', scope: 'all' }, makeRunContext('sess-1'))
  assert.equal(value.scope.kind, 'all')
  assert.equal(value.totals.calls, 4)
  assert.equal(value.totals.sessionCount, 2)
  assert.deepEqual(value.tools.map(entry => entry.name).sort(), ['bash', 'read'])
})

test('view=tools returns the per-tool aggregate table', async () => {
  const { tool } = makeTool()
  const value = await tool.execute({ view: 'tools', scope: 'all' }, makeRunContext('sess-1'))
  assert.ok(Array.isArray(value.tools))
  assert.deepEqual(value.tools.map(entry => entry.name).sort(), ['bash', 'read'])
  const bash = value.tools.find(entry => entry.name === 'bash')
  assert.equal(bash.calls, 3)
  assert.equal(bash.errors, 1)
})

test('view=recent returns newest-first calls and defaults to 20 entries', async () => {
  const many = Array.from({ length: 30 }, (_, index) => makeRecord(index + 1, { tool: 'bash', sessionId: 'sess-1' }))
  const { tool } = makeTool({ records: many })
  const value = await tool.execute({ view: 'recent' }, makeRunContext('sess-1'))
  assert.equal(value.recent.length, 20, 'the default recent limit is 20')
  assert.deepEqual(value.recent.map(call => call.seq), Array.from({ length: 20 }, (_, index) => 30 - index))
})

test('view=recent clamps an oversized limit to 100', async () => {
  const many = Array.from({ length: 150 }, (_, index) => makeRecord(index + 1, { tool: 'bash', sessionId: 'sess-1' }))
  const { tool } = makeTool({ records: many })
  const value = await tool.execute({ view: 'recent', limit: 1000 }, makeRunContext('sess-1'))
  assert.equal(value.recent.length, 100)
})

test('view=explain returns the registered description and parameter table', async () => {
  const { tool, resolvedSchemaRequests } = makeTool()
  const value = await tool.execute({ view: 'explain', tool: 'bash' }, makeRunContext('sess-1'))
  assert.equal(typeof value, 'object')
  const serialized = JSON.stringify(value)
  assert.ok(serialized.includes('Run shell commands'), `explain output should include the description: ${serialized}`)
  assert.ok(serialized.includes('command'), 'explain output should include parameter information')
  assert.ok(serialized.includes('Shell command to execute'), 'explain output should include parameter descriptions')
  assert.ok(resolvedSchemaRequests.some(request => request.name === 'bash'))
})

test('view=explain rejects an unknown tool as an error result', async () => {
  const { tool } = makeTool()
  await assert.rejects(
    () => tool.execute({ view: 'explain', tool: 'does_not_exist' }, makeRunContext('sess-1')),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(String(error.message), /does_not_exist|unknown|not found|未找到|未知/iu)
      return true
    },
  )
})

test('view=explain without a tool name is rejected by validation', async () => {
  const { tool } = makeTool()
  await assert.rejects(() => tool.execute({ view: 'explain' }, makeRunContext('sess-1')))
})

test('an invalid view is rejected by the parameter schema', async () => {
  const { tool } = makeTool()
  await assert.rejects(() => tool.execute({ view: 'bogus' }, makeRunContext('sess-1')))
})

test('render produces compact Markdown in Chinese', async () => {
  const { tool } = makeTool({ language: 'zh' })
  const args = { view: 'summary', scope: 'all' }
  const value = await tool.execute(args, makeRunContext('sess-1'))
  const text = renderText(tool, args, value)
  assert.ok(text.includes('bash'), `rendered text should list tools: ${text}`)
  assert.match(text, /统计|工具|调用/u)
  assert.ok(text.split('\n').length > 1, 'rendered text should be multi-line')
})

test('render produces English text when language is en', async () => {
  const { tool } = makeTool({ language: 'en' })
  const args = { view: 'summary', scope: 'all' }
  const value = await tool.execute(args, makeRunContext('sess-1'))
  const text = renderText(tool, args, value)
  assert.ok(text.includes('bash'))
  assert.match(text, /usage|statistic|tool|call/iu)
})

test('recent output includes params and explanations when configured', async () => {
  const { tool } = makeTool({ configOverrides: { includeParamsInReport: true } })
  const value = await tool.execute({ view: 'recent', limit: 5 }, makeRunContext('sess-1'))
  const entry = value.recent[0]
  assert.deepEqual(entry.params, { command: `echo ${entry.seq}` })
  assert.equal(typeof entry.explanation.summary, 'string')
})

test('recent output omits params when includeParamsInReport is false', async () => {
  const { tool } = makeTool({ configOverrides: { includeParamsInReport: false } })
  const value = await tool.execute({ view: 'recent', limit: 5 }, makeRunContext('sess-1'))
  assert.equal(value.recent[0].params, undefined)
})
