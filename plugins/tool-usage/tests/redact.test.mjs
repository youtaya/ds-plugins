/**
 * Unit tests for the pure redaction/truncation module (`src/redact.ts`,
 * compiled to `lib/redact.js`).
 *
 * Contract: docs/DESIGN.md §8. Output must always be plain lossless JSON:
 * sensitive keys are replaced, strings and arrays are capped, depth is capped,
 * and every lossy step sets the matching result flag.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKey, redactArgs, SENSITIVE_KEYS } from '../lib/redact.js'

/** Default-ish options: the shipped sensitive key list and no string cap. */
function options(overrides = {}) {
  return {
    maxStringChars: 500,
    redactKeys: SENSITIVE_KEYS,
    ...overrides,
  }
}

/** JSON round-trip: throws when the value is not lossless JSON. */
function lossless(value) {
  return JSON.parse(JSON.stringify(value))
}

test('SENSITIVE_KEYS covers the documented sensitive key families', () => {
  assert.ok(Array.isArray(SENSITIVE_KEYS), 'SENSITIVE_KEYS must be an array')
  assert.ok(SENSITIVE_KEYS.length > 0, 'SENSITIVE_KEYS must not be empty')
  const normalized = SENSITIVE_KEYS.map(normalizeKey)
  for (const expected of ['token', 'password', 'apikey', 'authorization', 'cookie']) {
    assert.ok(normalized.includes(expected), `SENSITIVE_KEYS should contain a ${expected} entry (got ${normalized.join(', ')})`)
  }
})

test('sensitive keys are redacted, matching values are untouched', () => {
  const result = redactArgs({
    token: 'abc',
    password: 'hunter2',
    apiKey: 'k-123',
    authorization: 'Bearer secret',
    cookie: 'session=deadbeef',
    command: 'pnpm test',
  }, options())

  assert.deepEqual(result.value, {
    token: '[REDACTED]',
    password: '[REDACTED]',
    apiKey: '[REDACTED]',
    authorization: '[REDACTED]',
    cookie: '[REDACTED]',
    command: 'pnpm test',
  })
  assert.equal(result.redacted, true)
  assert.equal(result.truncated, false)
  assert.deepEqual(lossless(result.value), result.value, 'result value must be lossless JSON')
})

test('key matching is case-insensitive and ignores -/_ separators', () => {
  const result = redactArgs({
    API_KEY: 'a',
    'Access-Token': 'b',
    'x-api-key': 'c',
    'mySecretValue': 'd',
    sessionToken: 'e',
  }, options({ redactKeys: ['token', 'apikey', 'secret'] }))

  assert.equal(result.value.API_KEY, '[REDACTED]')
  assert.equal(result.value['Access-Token'], '[REDACTED]')
  assert.equal(result.value['x-api-key'], '[REDACTED]')
  assert.equal(result.value.mySecretValue, '[REDACTED]')
  assert.equal(result.value.sessionToken, '[REDACTED]')
  assert.equal(result.redacted, true)
})

test('key normalization also ignores dots and whitespace', () => {
  const result = redactArgs({
    'api.key': 'a',
    'api key': 'b',
    'API\tKEY': 'c',
    'access token': 'd',
  }, options())

  assert.equal(result.value['api.key'], '[REDACTED]')
  assert.equal(result.value['api key'], '[REDACTED]')
  assert.equal(result.value['API\tKEY'], '[REDACTED]')
  assert.equal(result.value['access token'], '[REDACTED]')
  assert.equal(result.redacted, true)
  assert.equal(normalizeKey('API Key'), 'apikey')
  assert.equal(normalizeKey('api.key'), 'apikey')
  assert.equal(normalizeKey('x_api-key'), 'xapikey')
})

test('documented limitation: pair/array shapes and value-embedded secrets are not redacted', () => {
  // README/DESIGN document that matching is key-name based only. These structural
  // shapes stay visible; users mitigate with redactKeys or by disabling persistence.
  const result = redactArgs({
    headers: [['Authorization', 'Bearer sk-pair-secret']],
    env: ['API_KEY=sk-env-secret'],
    command: 'curl --token=sk-value-secret',
  }, options())

  assert.deepEqual(result.value.headers, [['Authorization', 'Bearer sk-pair-secret']])
  assert.deepEqual(result.value.env, ['API_KEY=sk-env-secret'])
  assert.equal(result.value.command, 'curl --token=sk-value-secret')
  assert.equal(result.redacted, false)
})

test('normalized key stems match by substring, not only by exact key', () => {
  // Contract: a key is sensitive when its normalized form *contains* a stem.
  const result = redactArgs({ monkey: 'visible', keyboard: 'visible', tokensPerSecond: 12 }, options({
    redactKeys: ['token'],
  }))
  assert.deepEqual(result.value, { monkey: 'visible', keyboard: 'visible', tokensPerSecond: '[REDACTED]' })
  assert.equal(result.redacted, true)

  const preserved = redactArgs({ monkey: 'visible', keyboard: 'visible' }, options({ redactKeys: ['token'] }))
  assert.deepEqual(preserved.value, { monkey: 'visible', keyboard: 'visible' })
  assert.equal(preserved.redacted, false)
})

test('redaction applies recursively through nested objects and arrays', () => {
  const result = redactArgs({
    outer: {
      users: [
        { name: 'alice', access_token: 'aaa' },
        { name: 'bob', nested: { password: 'bbb' } },
      ],
    },
    headers: [{ 'x-api-key': 'ccc' }],
  }, options())

  assert.deepEqual(result.value, {
    outer: {
      users: [
        { name: 'alice', access_token: '[REDACTED]' },
        { name: 'bob', nested: { password: '[REDACTED]' } },
      ],
    },
    headers: [{ 'x-api-key': '[REDACTED]' }],
  })
  assert.equal(result.redacted, true)
})

test('long strings are truncated to maxStringChars - 1 plus an ellipsis', () => {
  const result = redactArgs({ command: 'a'.repeat(30) }, options({ maxStringChars: 10 }))
  assert.equal(result.value.command, `${'a'.repeat(9)}…`)
  assert.equal(result.value.command.length, 10)
  assert.equal(result.truncated, true)

  const short = redactArgs({ command: 'echo hi' }, options({ maxStringChars: 10 }))
  assert.equal(short.value.command, 'echo hi')
  assert.equal(short.truncated, false)
})

test('top-level long strings and array string elements are truncated too', () => {
  const topLevel = redactArgs('x'.repeat(20), options({ maxStringChars: 5 }))
  assert.equal(topLevel.value, 'xxxx…')
  assert.equal(topLevel.truncated, true)

  const nested = redactArgs({ args: ['y'.repeat(20)] }, options({ maxStringChars: 5 }))
  assert.equal(nested.value.args[0], 'yyyy…')
})

test('arrays longer than 50 items are cut with a trailing summary marker', () => {
  const items = Array.from({ length: 52 }, (_, index) => index)
  const result = redactArgs({ items }, options())
  assert.ok(Array.isArray(result.value.items))
  assert.equal(result.value.items.length, 51, '50 kept values plus one marker')
  assert.deepEqual(result.value.items.slice(0, 50), items.slice(0, 50))
  assert.equal(typeof result.value.items[50], 'string')
  assert.match(result.value.items[50], /more items/u)
  assert.match(result.value.items[50], /\b2\b/u)
  assert.equal(result.truncated, true)
})

test('arrays of exactly 50 items are not truncated', () => {
  const items = Array.from({ length: 50 }, (_, index) => index)
  const result = redactArgs({ items }, options())
  assert.deepEqual(result.value.items, items)
  assert.equal(result.truncated, false)
})

test('depth beyond the cap becomes the [deep] marker', () => {
  let nested = { leaf: 'bottom' }
  for (let depth = 0; depth < 12; depth += 1) nested = { level: nested }
  const result = redactArgs(nested, options())
  const serialized = JSON.stringify(result.value)
  assert.ok(serialized.includes('"[deep]"'), `deep value should be replaced, got ${serialized.slice(0, 200)}`)
  assert.ok(!serialized.includes('bottom'), 'values past the depth cap must not leak through')
})

test('circular and non-JSON inputs degrade to plain JSON without throwing', () => {
  const circular = { name: 'x' }
  circular.self = circular
  const circularResult = redactArgs(circular, options())
  assert.equal(circularResult.value.name, 'x')
  assert.equal(circularResult.value.self, '[unserializable]')
  assert.deepEqual(lossless(circularResult.value), circularResult.value)

  class Widget {
    constructor() {
      this.value = 1
    }
  }

  const result = redactArgs({
    missing: undefined,
    callback: () => 1,
    symbol: Symbol('s'),
    big: 9_007_199_254_740_993n,
    widget: new Widget(),
    date: new Date('2026-01-01T00:00:00.000Z'),
    fnArray: [() => 1],
  }, options())

  assert.equal(result.value.missing, '[unserializable]')
  assert.equal(result.value.callback, '[unserializable]')
  assert.equal(result.value.symbol, '[unserializable]')
  assert.equal(result.value.big, '9007199254740993', 'bigint must become its decimal string')
  assert.equal(result.value.widget, '[unserializable]')
  assert.equal(result.value.date, '[unserializable]')
  assert.deepEqual(result.value.fnArray, ['[unserializable]'])
  assert.deepEqual(lossless(result.value), result.value)
})

test('primitives, empty args and nullish args are handled without throwing', () => {
  assert.equal(redactArgs(undefined, options()).value, '[unserializable]')
  assert.equal(redactArgs(null, options()).value, null)
  assert.equal(redactArgs(42, options()).value, 42)
  assert.equal(redactArgs(true, options()).value, true)
  assert.deepEqual(redactArgs({}, options()).value, {})
  assert.deepEqual(redactArgs([], options()).value, [])
  const empty = redactArgs({}, options())
  assert.equal(empty.redacted, false)
  assert.equal(empty.truncated, false)
})

test('an empty redactKeys list leaves all keys visible', () => {
  const result = redactArgs({ token: 'visible', password: 'visible' }, options({ redactKeys: [] }))
  assert.deepEqual(result.value, { token: 'visible', password: 'visible' })
  assert.equal(result.redacted, false)
})

test('both flags can be set by one call (redacted and truncated together)', () => {
  const result = redactArgs({ token: 't'.repeat(20), command: 'c'.repeat(20) }, options({ maxStringChars: 5 }))
  assert.equal(result.value.token, '[REDACTED]')
  assert.equal(result.value.command, 'cccc…')
  assert.equal(result.redacted, true)
  assert.equal(result.truncated, true)
})

test('an own __proto__ key is preserved as data and never pollutes the prototype', () => {
  const input = JSON.parse('{"__proto__":{"polluted":"yes"},"safe":1}')
  const result = redactArgs(input, options())

  assert.deepEqual(Object.keys(result.value).sort(), ['__proto__', 'safe'])
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype, 'the result prototype must stay Object.prototype')
  assert.equal(({}).polluted, undefined, 'the global Object prototype must not be polluted')
  assert.equal(result.value.polluted, undefined, 'the __proto__ value must not leak through inheritance')
  assert.deepEqual(result.value.__proto__, { polluted: 'yes' }, '__proto__ must be an ordinary own data property')
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), input, 'the key must survive a JSON round-trip')
  assert.deepEqual(lossless(result.value), input)
  assert.equal(result.redacted, false)
})
