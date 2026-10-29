/**
 * Unit tests for hand-rolled config normalization (`src/config.ts`, compiled to
 * `lib/config.js`).
 *
 * Contract: docs/DESIGN.md §7. The normalizer must accept `unknown`, apply
 * documented defaults, expand `~` / `$DSH_HOME`, tolerate unknown keys, and
 * warn instead of throwing on invalid values.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { normalizeKey, SENSITIVE_KEYS } from '../lib/redact.js'

/** Logger-shaped spy; config normalization reports invalid values through it. */
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

/** Apply environment variables for one test and restore them afterwards. */
function withEnv(t, patch) {
  const saved = new Map()
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  for (const [key, value] of Object.entries(patch)) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('Web UI projection bounds have documented defaults and clamping', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const defaults = resolveConfig(undefined, { logger: makeLogger() })
  assert.equal(defaults.uiEnabled, true)
  assert.equal(defaults.uiRecentCalls, 60)
  assert.equal(defaults.uiRecentTurns, 30)
  assert.equal(defaults.uiCommandChars, 240)

  const clamped = resolveConfig({
    uiEnabled: false,
    uiRecentCalls: 10_000,
    uiRecentTurns: 0,
    uiCommandChars: 0,
  }, { logger: makeLogger() })
  assert.equal(clamped.uiEnabled, false)
  assert.equal(clamped.uiRecentCalls, 500)
  assert.equal(clamped.uiRecentTurns, 1)
  assert.equal(clamped.uiCommandChars, 1)

  const invalid = makeLogger()
  const normalized = resolveConfig({
    uiEnabled: 'yes',
    uiRecentCalls: 'many',
    uiRecentTurns: null,
    uiCommandChars: Number.NaN,
  }, { logger: invalid })
  assert.equal(normalized.uiEnabled, true)
  assert.equal(normalized.uiRecentCalls, 60)
  assert.equal(normalized.uiRecentTurns, 30)
  assert.equal(normalized.uiCommandChars, 240)
  assert.ok(invalid.messages.length >= 4, 'each invalid UI field should warn once')
})

test('documented defaults are applied when config is omitted', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const logger = makeLogger()
  const config = resolveConfig(undefined, { logger })

  assert.equal(config.enabled, true)
  assert.equal(config.persistCalls, true)
  assert.equal(config.persistStats, true)
  assert.equal(config.restoreStats, true)
  assert.equal(config.explain, 'detailed')
  assert.equal(config.language, 'zh')
  assert.equal(config.maxParamChars, 500)
  assert.equal(config.maxStringChars, 200)
  assert.equal(config.recentLimit, 200)
  assert.equal(config.slowThresholdMs, 5000)
  assert.equal(config.toolName, 'tool_usage')
  assert.equal(config.commandName, 'tool-usage')
  assert.equal(config.statsWriteDebounceMs, 2000)
  assert.equal(config.includeParamsInReport, true)
  assert.ok(Array.isArray(config.redactKeys))
  assert.equal(logger.messages.length, 0, 'a fully defaulted config should not warn')
})

test('the default outputDir lives under $DSH_HOME/tool-usage', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const config = resolveConfig(undefined, { logger: makeLogger() })
  assert.ok(config.outputDir.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(config.outputDir), 'outputDir must be absolute')
  assert.ok(
    config.outputDir === join(homedir(), '.dsh', 'tool-usage')
    || config.outputDir.endsWith(`${join('', '.dsh', 'tool-usage')}`),
    `unexpected default outputDir: ${config.outputDir}`,
  )
})

test('$DSH_HOME is read from the environment and expanded', (t) => {
  const fakeHome = '/tmp/dsh-home-for-tests'
  withEnv(t, { DSH_HOME: fakeHome })
  const fromEnv = resolveConfig(undefined, { logger: makeLogger() })
  assert.equal(fromEnv.outputDir, join(fakeHome, 'tool-usage'), 'default outputDir must be $DSH_HOME/tool-usage')

  const explicit = resolveConfig({ outputDir: '$DSH_HOME/custom/dir' }, { logger: makeLogger() })
  assert.equal(explicit.outputDir, join(fakeHome, 'custom', 'dir'))
})

test('a leading ~ is expanded to the home directory', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const config = resolveConfig({ outputDir: '~/tool-usage-test' }, { logger: makeLogger() })
  assert.equal(config.outputDir, join(homedir(), 'tool-usage-test'))
  assert.ok(config.outputDir.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(config.outputDir))
})

test('the resolved outputDir is always absolute', (t) => {
  withEnv(t, { DSH_HOME: '/tmp/dsh-home-abs' })
  for (const outputDir of ['$DSH_HOME/x', '~/x']) {
    const config = resolveConfig({ outputDir }, { logger: makeLogger() })
    assert.ok(config.outputDir.startsWith('/'), `expected absolute path, got ${config.outputDir}`)
  }
})

test('an empty outputDir disables persistence', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const config = resolveConfig({ outputDir: '' }, { logger: makeLogger() })
  assert.equal(config.outputDir, '')
  assert.equal(config.persistCalls, false)
  assert.equal(config.persistStats, false)
})

test('valid overrides are honoured', (t) => {
  withEnv(t, { DSH_HOME: '/tmp/dsh-home-overrides' })
  const config = resolveConfig({
    enabled: false,
    outputDir: '$DSH_HOME/out',
    persistCalls: false,
    persistStats: false,
    restoreStats: false,
    explain: 'brief',
    language: 'en',
    maxParamChars: 1000,
    maxStringChars: 50,
    recentLimit: 5,
    slowThresholdMs: 250,
    toolName: 'my_usage',
    commandName: 'my-usage',
    statsWriteDebounceMs: 100,
    includeParamsInReport: false,
  }, { logger: makeLogger() })

  assert.equal(config.enabled, false)
  assert.equal(config.outputDir, '/tmp/dsh-home-overrides/out')
  assert.equal(config.persistCalls, false)
  assert.equal(config.persistStats, false)
  assert.equal(config.restoreStats, false)
  assert.equal(config.explain, 'brief')
  assert.equal(config.language, 'en')
  assert.equal(config.maxParamChars, 1000)
  assert.equal(config.maxStringChars, 50)
  assert.equal(config.recentLimit, 5)
  assert.equal(config.slowThresholdMs, 250)
  assert.equal(config.toolName, 'my_usage')
  assert.equal(config.commandName, 'my-usage')
  assert.equal(config.statsWriteDebounceMs, 100)
  assert.equal(config.includeParamsInReport, false)
})

test('redactKeys defaults to SENSITIVE_KEYS and merges user additions', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const defaults = resolveConfig(undefined, { logger: makeLogger() })
  const normalizedDefaults = defaults.redactKeys.map(normalizeKey)
  for (const key of SENSITIVE_KEYS) {
    assert.ok(normalizedDefaults.includes(normalizeKey(key)), `default redactKeys should include ${key}`)
  }

  const merged = resolveConfig({ redactKeys: ['myCustomField', 'another-secret'] }, { logger: makeLogger() })
  const normalizedMerged = merged.redactKeys.map(normalizeKey)
  assert.ok(normalizedMerged.includes('mycustomfield'), 'user additions must be kept')
  assert.ok(normalizedMerged.includes('anothersecret'))
  for (const key of SENSITIVE_KEYS) {
    assert.ok(normalizedMerged.includes(normalizeKey(key)), `user additions must not drop the default ${key}`)
  }
})

test('invalid values warn instead of throwing and fall back to defaults', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const logger = makeLogger()
  const config = resolveConfig({
    enabled: 'yes',
    explain: 'loud',
    language: 'fr',
    maxParamChars: -1,
    maxStringChars: 0,
    recentLimit: 'many',
    slowThresholdMs: Number.NaN,
    statsWriteDebounceMs: -5,
    persistCalls: 'sometimes',
    redactKeys: 'not-an-array',
  }, { logger })

  assert.equal(config.enabled, true)
  assert.equal(config.explain, 'detailed')
  assert.equal(config.language, 'zh')
  // Out-of-range numeric values are clamped to the documented bounds ...
  assert.equal(config.maxParamChars, 1)
  assert.equal(config.maxStringChars, 1)
  assert.equal(config.statsWriteDebounceMs, 0)
  // ... while non-numeric values fall back to their defaults.
  assert.equal(config.recentLimit, 200)
  assert.equal(config.slowThresholdMs, 5000)
  assert.equal(config.persistCalls, true)
  assert.ok(Array.isArray(config.redactKeys))
  assert.ok(logger.messages.length >= 1, 'invalid values must be reported through the logger')
  assert.ok(
    logger.messages.every(args => typeof args[0] === 'string' && args[0].startsWith('tool-usage: ')),
    `every warning must be a prefixed diagnostic string: ${JSON.stringify(logger.messages)}`,
  )
})

test('unknown keys are tolerated and ignored', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const logger = makeLogger()
  let config
  assert.doesNotThrow(() => {
    config = resolveConfig({ totallyUnknownKey: { nested: true }, outputDir: '/tmp/unknown-key-test' }, { logger })
  })
  assert.equal(config.outputDir, '/tmp/unknown-key-test')
  assert.equal(config.enabled, true)
  assert.equal(config.totallyUnknownKey, undefined, 'unknown keys must not leak into the resolved config')
})

test('a null config is treated like an omitted config', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  const config = resolveConfig(null, { logger: makeLogger() })
  assert.equal(config.enabled, true)
  assert.equal(config.language, 'zh')
  assert.ok(Array.isArray(config.redactKeys))
})

test('a missing logger does not break normalization', (t) => {
  withEnv(t, { DSH_HOME: undefined })
  let config
  assert.doesNotThrow(() => { config = resolveConfig({ explain: 'loud' }) })
  assert.equal(config.explain, 'detailed')
})
