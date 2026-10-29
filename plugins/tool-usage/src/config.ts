/**
 * Hand-rolled configuration normalization.
 *
 * The plugin deliberately carries no Schemastery (or other) runtime dependency,
 * so raw Cordis config is `unknown` and is normalized here. Invalid values never
 * fail the load: each one is replaced by its default and reported once through
 * `ctx.logger.warn`.
 *
 * @module tool-usage/config
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { SENSITIVE_KEYS } from './redact.js'
import type { LoggerLike } from './types.js'

/** Explanation detail level. */
export type ExplainSetting = 'off' | 'brief' | 'detailed'

/** Output language. */
export type ConfigLanguage = 'zh' | 'en'

/** Fully resolved plugin configuration (every field present). */
export interface ToolUsageConfig {
  /** Master switch; when false the plugin logs once and does nothing. */
  enabled: boolean
  /** Directory for `calls-*.jsonl` and `stats.json`; `''` disables persistence. */
  outputDir: string
  /** Append one JSONL line per call. */
  persistCalls: boolean
  /** Periodically write the aggregated statistics snapshot. */
  persistStats: boolean
  /** Restore aggregates from `stats.json` at startup. */
  restoreStats: boolean
  /** Explanation detail level. */
  explain: ExplainSetting
  /** Explanation/output language. */
  language: ConfigLanguage
  /** Cap on the whole serialized argument object. */
  maxParamChars: number
  /** Cap on each individual string value. */
  maxStringChars: number
  /** Default sensitive key stems plus user additions. */
  redactKeys: readonly string[]
  /** Number of recent calls kept in memory. */
  recentLimit: number
  /** A call is marked slow when its duration reaches this many milliseconds. */
  slowThresholdMs: number
  /** Model-facing tool name. */
  toolName: string
  /** Slash-command name (without the leading slash). */
  commandName: string
  /** Debounce for stats snapshot writes. */
  statsWriteDebounceMs: number
  /** Include redacted parameters in report/snapshot output. */
  includeParamsInReport: boolean
}

/** Default directory template, expanded against the running DSH home. */
export const DEFAULT_OUTPUT_DIR = '$DSH_HOME/tool-usage'

/** Default model-facing tool name. */
export const DEFAULT_TOOL_NAME = 'tool_usage'

/** Default slash-command name. */
export const DEFAULT_COMMAND_NAME = 'tool-usage'

const DEFAULT_CONFIG: Omit<ToolUsageConfig, 'outputDir' | 'redactKeys'> = {
  enabled: true,
  persistCalls: true,
  persistStats: true,
  restoreStats: true,
  explain: 'detailed',
  language: 'zh',
  maxParamChars: 500,
  maxStringChars: 200,
  recentLimit: 200,
  slowThresholdMs: 5000,
  toolName: DEFAULT_TOOL_NAME,
  commandName: DEFAULT_COMMAND_NAME,
  statsWriteDebounceMs: 2000,
  includeParamsInReport: true,
}

/** Dependencies for {@link resolveConfig}. */
export interface ResolveConfigOptions {
  /** Logger used for one warning per invalid field; diagnostics stay out of console.* */
  logger?: LoggerLike
  /** Environment used for `$DSH_HOME` expansion; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the DSH home directory from the environment.
 *
 * @param env - Process environment.
 * @returns The trimmed `DSH_HOME`, else `<home>/.dsh`, as an absolute path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']?.trim()
  const home = configured !== undefined && configured.length > 0
    ? configured
    : path.join(os.homedir(), '.dsh')
  return path.isAbsolute(home) ? path.normalize(home) : path.resolve(home)
}

/**
 * Expand `~` and `$DSH_HOME` prefixes and make the result absolute.
 *
 * `''` (or whitespace-only) means "do not persist" and stays empty.
 *
 * @param input - Configured output directory template.
 * @param env - Process environment used for `$DSH_HOME`.
 * @returns An absolute normalized path, or `''`.
 */
export function resolveOutputDir(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) return ''
  const dshHome = resolveDshHome(env)
  let expanded = trimmed

  if (expanded === '~') {
    expanded = os.homedir()
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2))
  } else if (expanded === '$DSH_HOME' || expanded === '${DSH_HOME}') {
    expanded = dshHome
  } else if (expanded.startsWith('$DSH_HOME/') || expanded.startsWith('$DSH_HOME\\')) {
    expanded = path.join(dshHome, expanded.slice('$DSH_HOME'.length + 1))
  } else if (expanded.startsWith('${DSH_HOME}/') || expanded.startsWith('${DSH_HOME}\\')) {
    expanded = path.join(dshHome, expanded.slice('${DSH_HOME}'.length + 1))
  }

  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded)
}

/**
 * Normalize raw plugin config, tolerating unknown keys and invalid values.
 *
 * @param rawConfig - Raw Cordis config (usually a plain object, `undefined` when omitted).
 * @param options - Optional logger and environment override.
 * @returns A fully populated {@link ToolUsageConfig}.
 */
export function resolveConfig(rawConfig: unknown, options: ResolveConfigOptions = {}): ToolUsageConfig {
  const logger = options.logger
  const env = options.env ?? process.env
  const warn = (message: string): void => {
    logger?.warn(`tool-usage: ${message}`)
  }

  let raw: Record<string, unknown> = {}
  if (rawConfig === undefined || rawConfig === null) {
    raw = {}
  } else if (isRecord(rawConfig)) {
    raw = rawConfig
  } else {
    warn('config must be an object; falling back to defaults')
  }

  const enabled = readBoolean(raw, 'enabled', DEFAULT_CONFIG.enabled, warn)
  const outputDirRaw = readString(raw, 'outputDir', DEFAULT_OUTPUT_DIR, warn)
  let persistCalls = readBoolean(raw, 'persistCalls', DEFAULT_CONFIG.persistCalls, warn)
  let persistStats = readBoolean(raw, 'persistStats', DEFAULT_CONFIG.persistStats, warn)
  const restoreStats = readBoolean(raw, 'restoreStats', DEFAULT_CONFIG.restoreStats, warn)
  const outputDir = resolveOutputDir(outputDirRaw, env)
  if (outputDir.length === 0) {
    // An explicitly empty outputDir disables both persistence flags.
    persistCalls = false
    persistStats = false
  }

  return {
    enabled,
    outputDir,
    persistCalls,
    persistStats,
    restoreStats,
    explain: readEnum(raw, 'explain', ['off', 'brief', 'detailed'] as const, DEFAULT_CONFIG.explain, warn),
    language: readEnum(raw, 'language', ['zh', 'en'] as const, DEFAULT_CONFIG.language, warn),
    maxParamChars: readInteger(raw, 'maxParamChars', DEFAULT_CONFIG.maxParamChars, 1, 10_000_000, warn),
    maxStringChars: readInteger(raw, 'maxStringChars', DEFAULT_CONFIG.maxStringChars, 1, 1_000_000, warn),
    redactKeys: readRedactKeys(raw, warn),
    recentLimit: readInteger(raw, 'recentLimit', DEFAULT_CONFIG.recentLimit, 1, 1_000_000, warn),
    slowThresholdMs: readInteger(raw, 'slowThresholdMs', DEFAULT_CONFIG.slowThresholdMs, 0, 86_400_000, warn),
    toolName: readIdentifier(raw, 'toolName', DEFAULT_CONFIG.toolName, warn),
    commandName: readCommandName(raw, warn),
    statsWriteDebounceMs: readInteger(raw, 'statsWriteDebounceMs', DEFAULT_CONFIG.statsWriteDebounceMs, 0, 3_600_000, warn),
    includeParamsInReport: readBoolean(raw, 'includeParamsInReport', DEFAULT_CONFIG.includeParamsInReport, warn),
  }
}

function readRedactKeys(raw: Record<string, unknown>, warn: (message: string) => void): readonly string[] {
  const value = raw['redactKeys']
  if (value === undefined) return Object.freeze([...SENSITIVE_KEYS])
  if (!Array.isArray(value)) {
    warn('redactKeys must be an array of strings; using the built-in sensitive key list')
    return Object.freeze([...SENSITIVE_KEYS])
  }
  const keys = new Set<string>(SENSITIVE_KEYS)
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) keys.add(item.trim())
  }
  return Object.freeze([...keys])
}

function readBoolean(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warn: (message: string) => void,
): boolean {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warn(`${key} must be a boolean; using ${fallback}`)
  return fallback
}

function readString(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
  warn: (message: string) => void,
): string {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  warn(`${key} must be a string; using ${JSON.stringify(fallback)}`)
  return fallback
}

function readIdentifier(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
  warn: (message: string) => void,
): string {
  const value = readString(raw, key, fallback, warn)
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    warn(`${key} must not be empty; using ${JSON.stringify(fallback)}`)
    return fallback
  }
  return trimmed
}

/** Command names accepted by the commands registry. */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

function readCommandName(raw: Record<string, unknown>, warn: (message: string) => void): string {
  const value = readString(raw, 'commandName', DEFAULT_CONFIG.commandName, warn)
  const normalized = value.trim().replace(/^\/+/, '').toLowerCase()
  if (!COMMAND_NAME_PATTERN.test(normalized)) {
    warn(`commandName must match ${String(COMMAND_NAME_PATTERN)}; using ${JSON.stringify(DEFAULT_CONFIG.commandName)}`)
    return DEFAULT_CONFIG.commandName
  }
  return normalized
}

function readInteger(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warn: (message: string) => void,
): number {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warn(`${key} must be a finite number; using ${fallback}`)
    return fallback
  }
  const truncated = Math.trunc(value)
  if (truncated < min || truncated > max) {
    const clamped = Math.min(max, Math.max(min, truncated))
    warn(`${key} must be between ${min} and ${max}; using ${clamped}`)
    return clamped
  }
  return truncated
}

function readEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  warn: (message: string) => void,
): T {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    for (const candidate of allowed) {
      if (candidate === normalized) return candidate
    }
  }
  warn(`${key} must be one of ${allowed.join(' | ')}; using ${fallback}`)
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
