/**
 * Shared, dependency-free type contracts for the tool-usage plugin.
 *
 * Everything in this module is either a type or a tiny constant, so importing it
 * never pulls in Node built-ins or the DSH tool runtime. All serializable shapes
 * are declared with `type` aliases (rather than `interface`) so they remain
 * assignable to the canonical lossless-JSON type used by `defineTool`.
 *
 * @module tool-usage/types
 */

/** Lossless JSON value, duplicated locally to avoid a runtime dependency on DSH utility packages. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Version stamped onto every line of the JSONL call log. */
export const CALL_RECORD_VERSION = 1

/** Version stamped onto the persisted statistics snapshot. */
export const PERSISTED_STATS_VERSION = 1

/**
 * Normalized outcome of one tool call:
 * - `ok` — the call succeeded.
 * - `error` — the tool reported a structured failure (or rejected without an abort code).
 * - `aborted` — the tool reported the canonical `ABORTED` / `ABORTED_BEFORE_DISPATCH` code.
 * - `threw` — `next()` rejected (the rejection is rethrown unchanged).
 */
export type CallStatus = 'ok' | 'error' | 'aborted' | 'threw'

/** Per-status call counters. */
export type StatusCounts = {
  ok: number
  error: number
  aborted: number
  threw: number
}

/** Deterministic, human-readable explanation attached to every recorded call. */
export type Explanation = {
  /** One-line description; never contains a newline. */
  summary: string
  /** Optional detail lines (registered description + parameter breakdown). */
  details?: string[]
}

/**
 * One recorded tool invocation. Exactly one of these is appended as one JSON line
 * to `calls-YYYY-MM-DD.jsonl` and kept in the in-memory recent-calls ring.
 */
export type CallRecord = {
  /** Record schema version. */
  v: typeof CALL_RECORD_VERSION
  /** Monotonically increasing sequence within one plugin lifetime. */
  seq: number
  /** ISO-8601 start time. */
  at: string
  /** Tool name as invoked. */
  tool: string
  /** Execution call id, when the executor supplied one. */
  callId?: string
  /** Owning session id (`exec.agent.id`), when present. */
  sessionId?: string
  /** Wall-clock duration from before dispatch to settled result. */
  durationMs: number
  /** Normalized outcome. */
  status: CallStatus
  /** Redacted and truncated JSON arguments; present on every recorded call. */
  params?: JsonValue
  /** Whether arguments were cut by the string, array, depth, or whole-params cap. */
  paramsTruncated: boolean
  /** Whether at least one sensitive parameter was replaced. */
  redacted: boolean
  /** Deterministic, bounded explanation of the call. */
  explanation: Explanation
  /**
   * Failure detail for `error`, `aborted`, and `threw` records. `message` comes from
   * the tool result, is capped at `maxStringChars`, and is not key-redacted.
   */
  error?: { message: string; code?: string }
}

/** Aggregate counters shared by the global and per-session scopes. */
export type AggregateTotals = {
  calls: number
  errors: number
  totalMs: number
  maxMs: number
  slowCalls: number
  statusCounts: StatusCounts
}

/** Per-tool aggregate counters. */
export type ToolTotals = {
  calls: number
  errors: number
  totalMs: number
  minMs: number
  maxMs: number
  lastMs: number
  lastAt: string
  slowCalls: number
  statusCounts: StatusCounts
}

/** Persisted aggregate block for one scope (global or one session). */
export type PersistedScope = {
  totals: AggregateTotals
  byTool: Record<string, ToolTotals>
}

/** Serialized statistics snapshot written atomically to `stats.json`. */
export type PersistedStats = {
  v: typeof PERSISTED_STATS_VERSION
  /** ISO-8601 time the snapshot was produced. */
  updatedAt: string
  /** Global aggregates. */
  totals: AggregateTotals
  /** Global per-tool aggregates. */
  byTool: Record<string, ToolTotals>
  /** Per-session aggregates; the empty key holds calls without a session id. */
  bySession: Record<string, PersistedScope>
  /** Number of distinct real sessions observed. */
  sessionCount: number
}

/** Scope selector for a snapshot query. */
export type SnapshotQuery = {
  /** `current` selects one session (or unscoped calls when `sessionId` is absent). */
  scope: 'current' | 'all'
  /** Session id for `scope: 'current'`. */
  sessionId?: string
  /** Maximum number of recent calls, clamped to 1..100. */
  limit: number
  /** Include redacted arguments in recent calls. */
  includeParams: boolean
  /** Include explanations in recent calls. */
  includeExplanations: boolean
}

/** Snapshot scope description. */
export type SnapshotScope =
  | { kind: 'session'; sessionId?: string }
  | { kind: 'all' }

/** Global totals row of a usage snapshot. */
export type SnapshotTotals = {
  calls: number
  errors: number
  totalMs: number
  avgMs: number
  maxMs: number
  slowCalls: number
  sessionCount: number
}

/** One tool row of a usage snapshot. */
export type SnapshotToolRow = {
  name: string
  calls: number
  errors: number
  errorRate: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  lastMs: number
  lastAt: string
  slowCalls: number
}

/** One recent call row of a usage snapshot. */
export type SnapshotRecentCall = {
  seq: number
  at: string
  tool: string
  durationMs: number
  status: CallStatus
  slow: boolean
  explanation?: Explanation
  params?: JsonValue
  sessionId?: string
}

/** Canonical usage snapshot returned by the model tool and `/tool-usage`. */
export type UsageSnapshot = {
  generatedAt: string
  scope: SnapshotScope
  totals: SnapshotTotals
  tools: SnapshotToolRow[]
  recent: SnapshotRecentCall[]
}

/** Minimal logger surface implemented by `ctx.logger`; diagnostics never use `console.*`. */
export interface LoggerLike {
  warn(...args: any[]): void
  info(...args: any[]): void
  debug(...args: any[]): void
  error(...args: any[]): void
}
