/**
 * Unit tests for the deterministic tool-call explainer (`src/explain.ts`,
 * compiled to `lib/explain.js`).
 *
 * Contract: docs/DESIGN.md §9. The explainer is pure, never throws, always
 * yields a newline-free summary, supports zh/en and brief/detailed levels, and
 * special-cases the first-party tools while falling back to a generic form.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { explainToolCall, MAX_DETAIL_CHARS, MAX_DETAIL_LINES, MAX_SUMMARY_CHARS } from '../lib/explain.js'

/** Chinese detailed options (the plugin default). */
const ZH_DETAILED = { language: 'zh', level: 'detailed', maxValueChars: 200 }
/** English detailed options. */
const EN_DETAILED = { language: 'en', level: 'detailed', maxValueChars: 200 }

const BASH_SCHEMA = {
  description: 'Execute a shell command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
}

const READ_SCHEMA = {
  description: 'Read a text file',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to read' },
    },
  },
}

/** A summary must never contain a line break. */
function assertNewlineFree(summary) {
  assert.equal(typeof summary, 'string')
  assert.ok(summary.length > 0, 'summary must not be empty')
  assert.ok(!summary.includes('\n'), `summary must not contain a newline: ${JSON.stringify(summary)}`)
  assert.ok(!summary.includes('\r'), `summary must not contain a carriage return: ${JSON.stringify(summary)}`)
}

/** Every call must return the Explanation shape. */
function assertExplanationShape(explanation) {
  assert.equal(typeof explanation, 'object')
  assert.equal(typeof explanation.summary, 'string')
  assert.ok(Array.isArray(explanation.details), 'details must be an array')
  for (const detail of explanation.details) assert.equal(typeof detail, 'string')
}

test('bash explanation in zh includes the command and reads naturally', () => {
  const explanation = explainToolCall('bash', { command: 'pnpm test', cwd: '/tmp/work' }, BASH_SCHEMA, ZH_DETAILED)
  assertExplanationShape(explanation)
  assertNewlineFree(explanation.summary)
  assert.ok(explanation.summary.includes('pnpm test'), `summary should mention the command: ${explanation.summary}`)
  assert.match(explanation.summary, /执行|Shell|命令|shell/u)
})

test('bash explanation in en differs from zh and mentions the command', () => {
  const zh = explainToolCall('bash', { command: 'pnpm test' }, BASH_SCHEMA, ZH_DETAILED)
  const en = explainToolCall('bash', { command: 'pnpm test' }, BASH_SCHEMA, EN_DETAILED)
  assertNewlineFree(en.summary)
  assert.ok(en.summary.includes('pnpm test'), `summary should mention the command: ${en.summary}`)
  assert.match(en.summary, /shell|command/iu)
  assert.notEqual(en.summary, zh.summary, 'zh and en explanations should differ')
})

test('read explanation includes the file path and the line window', () => {
  const zh = explainToolCall('read', { file_path: '/tmp/a.ts', offset: 1, limit: 200 }, READ_SCHEMA, ZH_DETAILED)
  assertNewlineFree(zh.summary)
  assert.ok(zh.summary.includes('/tmp/a.ts'), `summary should mention the path: ${zh.summary}`)
  assert.ok(zh.summary.includes('200'), `summary should mention the line limit: ${zh.summary}`)
  assert.match(zh.summary, /读取|read|文件/u)
})

test('grep explanation includes pattern and search root', () => {
  const zh = explainToolCall('grep', { pattern: 'TODO', path: 'src' }, undefined, ZH_DETAILED)
  assertNewlineFree(zh.summary)
  assert.ok(zh.summary.includes('TODO'), `summary should mention the pattern: ${zh.summary}`)
  assert.ok(zh.summary.includes('src'), `summary should mention the search path: ${zh.summary}`)

  const en = explainToolCall('grep', { pattern: 'TODO', path: 'src', glob: '*.ts' }, undefined, EN_DETAILED)
  assertNewlineFree(en.summary)
  assert.ok(en.summary.includes('TODO'))
})

test('web_search explanation handles queries array and singular query', () => {
  const fromArray = explainToolCall('web_search', { queries: ['dsh plugin', 'tool usage'] }, undefined, ZH_DETAILED)
  assertNewlineFree(fromArray.summary)
  assert.ok(fromArray.summary.includes('dsh plugin'), `summary should mention a query: ${fromArray.summary}`)

  const fromSingular = explainToolCall('web_search', { query: 'hello world' }, undefined, EN_DETAILED)
  assertNewlineFree(fromSingular.summary)
  assert.ok(fromSingular.summary.includes('hello world'))

  const fromEnglish = explainToolCall('web_search', { 'queries': ['alpha'], 'language': 'en' }, undefined, EN_DETAILED)
  assertNewlineFree(fromEnglish.summary)
})

test('web_fetch and read_image are special-cased by URL/path', () => {
  const fetch = explainToolCall('web_fetch', { url: 'https://example.com/a' }, undefined, ZH_DETAILED)
  assertNewlineFree(fetch.summary)
  assert.ok(fetch.summary.includes('https://example.com/a'))

  const image = explainToolCall('read_image', { path: '/tmp/pic.png' }, undefined, EN_DETAILED)
  assertNewlineFree(image.summary)
  assert.ok(image.summary.includes('/tmp/pic.png'))
})

test('unknown tools fall back to a generic zh/en summary with compact params', () => {
  const args = { alpha: 1, beta: 'two' }
  const zh = explainToolCall('custom_tool', args, undefined, ZH_DETAILED)
  assertNewlineFree(zh.summary)
  assert.ok(zh.summary.startsWith('调用工具 custom_tool'), `unexpected zh summary: ${zh.summary}`)
  assert.ok(zh.summary.includes('alpha'), 'compact params should include keys')
  assert.ok(zh.summary.includes('1'), 'compact params should include values')

  const en = explainToolCall('custom_tool', args, undefined, EN_DETAILED)
  assertNewlineFree(en.summary)
  assert.ok(en.summary.startsWith('Call tool custom_tool'), `unexpected en summary: ${en.summary}`)
})

test('tool aliases map to the specialized explanations', () => {
  const aliasedBash = explainToolCall('shell', { command: 'pnpm test' }, undefined, ZH_DETAILED)
  assertNewlineFree(aliasedBash.summary)
  assert.ok(aliasedBash.summary.includes('pnpm test'))
  assert.ok(!aliasedBash.summary.includes('调用工具 shell'), 'shell should be explained like bash, not generically')

  const aliasedRead = explainToolCall('read_file', { file_path: '/tmp/a.ts' }, undefined, ZH_DETAILED)
  assertNewlineFree(aliasedRead.summary)
  assert.ok(aliasedRead.summary.includes('/tmp/a.ts'))
  assert.ok(!aliasedRead.summary.includes('调用工具 read_file'))
})

test('brief level omits details; detailed includes schema description and parameter lines', () => {
  const brief = explainToolCall('bash', { command: 'pnpm test' }, BASH_SCHEMA, { ...ZH_DETAILED, level: 'brief' })
  assertExplanationShape(brief)
  assert.deepEqual(brief.details, [], 'brief explanations must have no details')
  assertNewlineFree(brief.summary)

  const detailed = explainToolCall('bash', { command: 'pnpm test' }, BASH_SCHEMA, ZH_DETAILED)
  assert.ok(detailed.details.length > 0, 'detailed explanations should carry details')
  assert.ok(
    detailed.details.some(detail => detail.includes('Execute a shell command')),
    `details should include the registered description: ${JSON.stringify(detailed.details)}`,
  )
  assert.ok(
    detailed.details.some(detail => detail.includes('command')),
    `details should include a per-parameter line: ${JSON.stringify(detailed.details)}`,
  )
})

test('detailed explanations work without a registered schema', () => {
  const explanation = explainToolCall('bash', { command: 'ls' }, undefined, ZH_DETAILED)
  assertExplanationShape(explanation)
  assert.ok(explanation.details.length > 0)
  assertNewlineFree(explanation.summary)
})

test('summaries stay newline-free even when argument values contain newlines', () => {
  const cases = [
    ['bash', { command: 'echo one\necho two' }],
    ['write', { file_path: '/tmp/x', content: 'line1\nline2\nline3' }],
    ['custom_tool', { text: 'a\nb' }],
  ]
  for (const [tool, args] of cases) {
    const explanation = explainToolCall(tool, args, undefined, ZH_DETAILED)
    assertNewlineFree(explanation.summary)
  }
})

test('explainToolCall is safe for malformed and non-object arguments', () => {
  const circular = { command: 'x' }
  circular.self = circular
  const malformedArguments = [undefined, null, 'a string', 42, true, [], {}, { command: null }, { command: 42 }, circular]

  for (const language of ['zh', 'en']) {
    for (const args of malformedArguments) {
      const explanation = explainToolCall('bash', args, undefined, { language, level: 'detailed', maxValueChars: 80 })
      assertExplanationShape(explanation)
      assertNewlineFree(explanation.summary)
    }
  }
})

test('special-cased tools tolerate missing or mistyped fields without throwing', () => {
  const noisyArgs = [
    { command: 42, cwd: [] },
    { file_path: { nested: true } },
    { queries: 'not-an-array' },
    { url: null },
  ]
  for (const tool of ['bash', 'read', 'grep', 'web_search', 'web_fetch', 'write', 'edit', 'glob', 'todo_write']) {
    for (const args of noisyArgs) {
      const explanation = explainToolCall(tool, args, undefined, ZH_DETAILED)
      assertExplanationShape(explanation)
      assertNewlineFree(explanation.summary)
    }
  }
})

test('maxValueChars bounds the rendered argument previews', () => {
  const huge = 'z'.repeat(500)
  const explanation = explainToolCall('bash', { command: huge }, undefined, { ...ZH_DETAILED, maxValueChars: 10 })
  assertNewlineFree(explanation.summary)
  assert.ok(!explanation.summary.includes(huge), 'the full oversized value must not be inlined')
  assert.ok(explanation.summary.length < 400, `summary should stay compact: ${explanation.summary.length} chars`)
})

test('summary and details are totally capped for a 500-argument unknown tool', () => {
  const properties = {}
  const args = {}
  for (let index = 0; index < 500; index += 1) {
    properties[`p${index}`] = { type: 'string', description: 'd'.repeat(50) }
    args[`p${index}`] = 'v'.repeat(50)
  }
  const hugeDescription = 'D'.repeat(5000)
  const explanation = explainToolCall(
    'mystery_tool',
    args,
    { description: hugeDescription, parameters: { properties } },
    { language: 'zh', level: 'detailed', maxValueChars: 200 },
  )

  assertNewlineFree(explanation.summary)
  assert.equal(explanation.summary.length, MAX_SUMMARY_CHARS, 'an oversized summary is cut exactly at the cap')
  assert.ok(explanation.summary.endsWith('…'))
  assert.ok(explanation.details.length <= MAX_DETAIL_LINES, `details are ${explanation.details.length} lines`)
  let total = 0
  for (const [index, line] of explanation.details.entries()) {
    total += line.length + (index === 0 ? 0 : 1)
    assert.equal(typeof line, 'string')
  }
  assert.ok(total <= MAX_DETAIL_CHARS, `details total ${total} chars exceeds ${MAX_DETAIL_CHARS}`)
  assert.ok(
    !explanation.details.some(line => line.includes(hugeDescription)),
    'the registered description must be clipped in details',
  )
})

test('the registered tool/parameter descriptions are clipped to maxValueChars in details', () => {
  const longDescription = 'D'.repeat(5000)
  const explanation = explainToolCall('bash', { command: 'ls' }, {
    description: longDescription,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'd'.repeat(5000) },
      },
    },
  }, { ...ZH_DETAILED, maxValueChars: 80 })

  const descriptionLine = explanation.details.find(line => line.includes('工具说明：'))
  assert.ok(descriptionLine, 'the schema description line must be present')
  assert.ok(descriptionLine.length < 300, `description line must be clipped, got ${descriptionLine.length} chars`)
  assert.ok(!descriptionLine.includes(longDescription))
  const parameterLine = explanation.details.find(line => line.startsWith('参数 command'))
  assert.ok(parameterLine, 'the per-parameter line must be present')
  assert.ok(parameterLine.length < 300, `parameter line must be clipped, got ${parameterLine.length} chars`)
})
