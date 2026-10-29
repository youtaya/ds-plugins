/**
 * Pure in-memory statistics store with scoped snapshots and JSON persistence.
 *
 * The store keeps one aggregate per session (the empty session key holds calls
 * without an owning session) plus a ring buffer of recent calls. Global
 * aggregates are derived by summing the session aggregates, so a session reset
 * never needs a recomputation pass over double-booked counters.
 *
 * All durations are wall-clock deltas measured by the recorder with
 * `performance.now()`; parallel tool calls overlap, so sums are not CPU time.
 *
 * @module tool-usage/stats
 */

import { PERSISTED_STATS_VERSION } from './types.js'
import type {
  AggregateTotals,
  CallRecord,
  CallStatus,
  PersistedScope,
  PersistedStats,
  SnapshotQuery,
  SnapshotRecentCall,
  SnapshotScope,
  SnapshotToolRow,
  SnapshotTotals,
  StatusCounts,
  ToolTotals,
  UsageSnapshot,
} from './types.js'

/** Options for {@link StatsStore}. */
export interface StatsStoreOptions {
  /** Maximum number of recent calls retained in memory. */
  recentLimit: number
  /**
   * Duration at which a call is counted as slow. Additive to the documented
   * `{ recentLimit }` options because the snapshots must classify slowness in
   * the store rather than in the caller.
   */
  slowThresholdMs?: number
}

/** Session key used for calls without an owning session. */
const UNSCOPED_SESSION_KEY = ''

const DEFAULT_RECENT_LIMIT = 200
const DEFAULT_SLOW_THRESHOLD_MS = 5000
const MAX_RECENT_LIMIT = 1_000_000

/** Mutable per-scope aggregate (same shape as the persisted one). */
type MutableScope = {
  totals: AggregateTotals
  byTool: Map<string, ToolTotals>
}

const CALL_STATUSES: readonly CallStatus[] = ['ok', 'error', 'aborted', 'threw']

/**
 * In-memory aggregation store. One instance is created per plugin lifetime.
 */
export class StatsStore {
  private readonly recentLimit: number
  private readonly slowThresholdMs: number
  private sessions = new Map<string, MutableScope>()
  private recent: CallRecord[] = []

  /**
   * @param options - Recent-call ring size and slow-call threshold.
   */
  constructor(options: StatsStoreOptions) {
    this.recentLimit = clampInt(options.recentLimit, DEFAULT_RECENT_LIMIT, 1, MAX_RECENT_LIMIT)
    this.slowThresholdMs = clampInt(options.slowThresholdMs, DEFAULT_SLOW_THRESHOLD_MS, 0, 86_400_000)
  }

  /**
   * Fold one recorded call into the aggregates and the recent-calls ring.
   *
   * @param record - Immutable call record produced by the recorder.
   */
  record(record: CallRecord): void {
    const toolName = typeof record.tool === 'string' && record.tool.length > 0 ? record.tool : 'unknown'
    const sessionKey = sessionKeyOf(record.sessionId)
    const durationMs = normalizeDuration(record.durationMs)
    const slow = this.isSlow(durationMs)
    const status = isCallStatus(record.status) ? record.status : 'error'
    const at = typeof record.at === 'string' && record.at.length > 0 ? record.at : new Date(0).toISOString()

    const scope = this.ensureScope(sessionKey)
    bumpAggregate(scope.totals, status, durationMs, slow)
    let tool = scope.byTool.get(toolName)
    if (tool === undefined) {
      tool = createToolTotals(at)
      scope.byTool.set(toolName, tool)
    }
    bumpTool(tool, status, durationMs, slow, at)

    this.recent.push(record)
    const overflow = this.recent.length - this.recentLimit
    if (overflow > 0) this.recent.splice(0, overflow)
  }

  /**
   * Build one usage snapshot.
   *
   * @param query - Scope, limit, and inclusion flags. Milliseconds are rounded to one decimal.
   * @returns The canonical {@link UsageSnapshot}.
   */
  snapshot(query: SnapshotQuery): UsageSnapshot {
    const generatedAt = new Date().toISOString()
    const limit = clampInt(query.limit, 20, 1, 100)
    const includeParams = query.includeParams === true
    const includeExplanations = query.includeExplanations === true
    const sessionId = typeof query.sessionId === 'string' && query.sessionId.length > 0 ? query.sessionId : undefined
    const scopeKind: 'current' | 'all' = query.scope === 'all' ? 'all' : 'current'
    const sessionKey = scopeKind === 'current' ? (sessionId ?? UNSCOPED_SESSION_KEY) : undefined

    const scopes: MutableScope[] = []
    if (scopeKind === 'all') {
      for (const scope of this.sessions.values()) scopes.push(scope)
    } else {
      const selected = this.sessions.get(sessionKey ?? UNSCOPED_SESSION_KEY)
      if (selected !== undefined) scopes.push(selected)
    }

    const aggregate = sumAggregates(scopes)
    const sessionCount = scopeKind === 'all' ? this.countSessions() : scopes.length > 0 ? 1 : 0
    const totals: SnapshotTotals = {
      calls: aggregate.calls,
      errors: aggregate.errors,
      totalMs: round1(aggregate.totalMs),
      avgMs: aggregate.calls > 0 ? round1(aggregate.totalMs / aggregate.calls) : 0,
      maxMs: round1(aggregate.maxMs),
      slowCalls: aggregate.slowCalls,
      sessionCount,
    }
    const tools = [...sumToolTotals(scopes).entries()]
      .map(([name, totalsForTool]) => toToolRow(name, totalsForTool))
      .sort(compareToolRows)
    const recent = this.selectRecent(sessionKey, limit, includeParams, includeExplanations)
    const scope: SnapshotScope = scopeKind === 'all'
      ? { kind: 'all' }
      : { kind: 'session', ...(sessionId === undefined ? {} : { sessionId }) }

    return { generatedAt, scope, totals, tools, recent }
  }

  /**
   * Serialize global and per-session aggregates (recent calls are not persisted;
   * the JSONL log is their source of truth).
   *
   * @returns A JSON-safe snapshot for `stats.json`.
   */
  toJSON(): PersistedStats {
    const scopes = [...this.sessions.values()]
    const bySession: Record<string, PersistedScope> = {}
    for (const [key, scope] of this.sessions) {
      bySession[key] = {
        totals: cloneAggregate(scope.totals),
        byTool: persistToolTotals(scope.byTool),
      }
    }
    const aggregate = sumAggregates(scopes)
    return {
      v: PERSISTED_STATS_VERSION,
      updatedAt: new Date().toISOString(),
      totals: {
        calls: aggregate.calls,
        errors: aggregate.errors,
        totalMs: round1(aggregate.totalMs),
        maxMs: round1(aggregate.maxMs),
        slowCalls: aggregate.slowCalls,
        statusCounts: { ...aggregate.statusCounts },
      },
      byTool: persistToolTotals(sumToolTotals(scopes)),
      bySession,
      sessionCount: this.countSessions(),
    }
  }

  /**
   * Merge aggregates from a previously persisted snapshot into the live store.
   *
   * Restoration is additive: persisted totals are added to whatever has already been
   * recorded in this process. Calls recorded while the asynchronous snapshot read is
   * in flight therefore stay counted, and the in-memory recent-calls ring is left
   * untouched (recent calls are not persisted). Malformed input is ignored
   * defensively. Because the merge is additive, call this once per snapshot; passing
   * the same snapshot twice adds it twice.
   *
   * @param data - Parsed `stats.json` content, however malformed.
   */
  restore(data: unknown): void {
    try {
      if (!isRecord(data) || data['v'] !== PERSISTED_STATS_VERSION) return
      const restored = new Map<string, MutableScope>()
      const rawSessions = data['bySession']
      if (isRecord(rawSessions)) {
        for (const [sessionKey, rawScope] of Object.entries(rawSessions)) {
          const scope = parseScope(rawScope)
          if (scope !== undefined) {
            restored.set(sessionKey, { totals: scope.totals, byTool: new Map(Object.entries(scope.byTool)) })
          }
        }
      }
      if (restored.size === 0) {
        const scope = parseScope({ totals: data['totals'], byTool: data['byTool'] })
        if (scope !== undefined) {
          restored.set(UNSCOPED_SESSION_KEY, { totals: scope.totals, byTool: new Map(Object.entries(scope.byTool)) })
        }
      }
      if (restored.size === 0) return
      for (const [sessionKey, scope] of restored) {
        const existing = this.sessions.get(sessionKey)
        if (existing === undefined) {
          this.sessions.set(sessionKey, scope)
          continue
        }
        mergeAggregate(existing.totals, scope.totals)
        for (const [toolName, tool] of scope.byTool) {
          const target = existing.byTool.get(toolName)
          if (target === undefined) existing.byTool.set(toolName, tool)
          else mergeToolTotals(target, tool)
        }
      }
    } catch {
      // Restoring statistics is best-effort: keep whatever state we already have.
    }
  }

  /**
   * Clear in-memory aggregates.
   *
   * @param scope - `'all'` (default) clears everything; `{ sessionId }` clears that session only.
   */
  reset(scope?: 'all' | { sessionId: string }): void {
    if (scope === undefined || scope === 'all') {
      this.sessions.clear()
      this.recent = []
      return
    }
    const sessionKey = typeof scope.sessionId === 'string' && scope.sessionId.length > 0
      ? scope.sessionId
      : UNSCOPED_SESSION_KEY
    this.sessions.delete(sessionKey)
    this.recent = this.recent.filter(record => sessionKeyOf(record.sessionId) !== sessionKey)
  }

  private ensureScope(sessionKey: string): MutableScope {
    let scope = this.sessions.get(sessionKey)
    if (scope === undefined) {
      scope = { totals: createAggregate(), byTool: new Map() }
      this.sessions.set(sessionKey, scope)
    }
    return scope
  }

  private countSessions(): number {
    let count = 0
    for (const key of this.sessions.keys()) {
      if (key !== UNSCOPED_SESSION_KEY) count += 1
    }
    return count
  }

  private isSlow(durationMs: number): boolean {
    return durationMs >= this.slowThresholdMs
  }

  private selectRecent(
    sessionKey: string | undefined,
    limit: number,
    includeParams: boolean,
    includeExplanations: boolean,
  ): SnapshotRecentCall[] {
    const filtered = sessionKey === undefined
      ? this.recent
      : this.recent.filter(record => sessionKeyOf(record.sessionId) === sessionKey)
    const window = filtered.slice(Math.max(0, filtered.length - limit))
    const result: SnapshotRecentCall[] = []
    for (let index = window.length - 1; index >= 0; index -= 1) {
      const record = window[index]
      if (record === undefined) continue
      result.push({
        seq: record.seq,
        at: record.at,
        tool: record.tool,
        durationMs: round1(normalizeDuration(record.durationMs)),
        status: record.status,
        slow: this.isSlow(normalizeDuration(record.durationMs)),
        ...(includeExplanations ? { explanation: record.explanation } : {}),
        ...(includeParams && record.params !== undefined ? { params: record.params } : {}),
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      })
    }
    return result
  }
}

/** Round a millisecond value to one decimal place. */
export function round1(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10) / 10
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10_000) / 10_000
}

function createStatusCounts(): StatusCounts {
  return { ok: 0, error: 0, aborted: 0, threw: 0 }
}

function createAggregate(): AggregateTotals {
  return { calls: 0, errors: 0, totalMs: 0, maxMs: 0, slowCalls: 0, statusCounts: createStatusCounts() }
}

function createToolTotals(at: string): ToolTotals {
  return {
    calls: 0,
    errors: 0,
    totalMs: 0,
    minMs: 0,
    maxMs: 0,
    lastMs: 0,
    lastAt: at,
    slowCalls: 0,
    statusCounts: createStatusCounts(),
  }
}

/**
 * Whether a status counts as a failure in the `errors` totals. Aborted calls are
 * tracked in `statusCounts` but are not failures: the caller cancelled them.
 */
function isFailureStatus(status: CallStatus): boolean {
  return status === 'error' || status === 'threw'
}

function bumpAggregate(totals: AggregateTotals, status: CallStatus, durationMs: number, slow: boolean): void {
  totals.calls += 1
  if (isFailureStatus(status)) totals.errors += 1
  totals.totalMs += durationMs
  if (durationMs > totals.maxMs || totals.calls === 1) totals.maxMs = durationMs
  if (slow) totals.slowCalls += 1
  totals.statusCounts[status] += 1
}

function bumpTool(tool: ToolTotals, status: CallStatus, durationMs: number, slow: boolean, at: string): void {
  if (tool.calls === 0) tool.minMs = durationMs
  else tool.minMs = Math.min(tool.minMs, durationMs)
  tool.calls += 1
  if (isFailureStatus(status)) tool.errors += 1
  tool.totalMs += durationMs
  if (durationMs > tool.maxMs || tool.calls === 1) tool.maxMs = durationMs
  tool.lastMs = durationMs
  tool.lastAt = at
  if (slow) tool.slowCalls += 1
  tool.statusCounts[status] += 1
}

function mergeAggregate(target: AggregateTotals, source: AggregateTotals): void {
  target.calls += source.calls
  target.errors += source.errors
  target.totalMs += source.totalMs
  target.maxMs = Math.max(target.maxMs, source.maxMs)
  target.slowCalls += source.slowCalls
  for (const status of CALL_STATUSES) target.statusCounts[status] += source.statusCounts[status]
}

function mergeToolTotals(target: ToolTotals, source: ToolTotals): void {
  if (target.calls === 0) target.minMs = source.minMs
  else target.minMs = Math.min(target.minMs, source.minMs)
  target.calls += source.calls
  target.errors += source.errors
  target.totalMs += source.totalMs
  target.maxMs = Math.max(target.maxMs, source.maxMs)
  if (source.lastAt >= target.lastAt) {
    target.lastAt = source.lastAt
    target.lastMs = source.lastMs
  }
  target.slowCalls += source.slowCalls
  for (const status of CALL_STATUSES) target.statusCounts[status] += source.statusCounts[status]
}

function sumAggregates(scopes: readonly MutableScope[]): AggregateTotals {
  const aggregate = createAggregate()
  for (const scope of scopes) {
    aggregate.calls += scope.totals.calls
    aggregate.errors += scope.totals.errors
    aggregate.totalMs += scope.totals.totalMs
    aggregate.maxMs = Math.max(aggregate.maxMs, scope.totals.maxMs)
    aggregate.slowCalls += scope.totals.slowCalls
    for (const status of CALL_STATUSES) aggregate.statusCounts[status] += scope.totals.statusCounts[status]
  }
  return aggregate
}

function sumToolTotals(scopes: readonly MutableScope[]): Map<string, ToolTotals> {
  const merged = new Map<string, ToolTotals>()
  for (const scope of scopes) {
    for (const [name, tool] of scope.byTool) {
      let target = merged.get(name)
      if (target === undefined) {
        target = createToolTotals(tool.lastAt)
        merged.set(name, target)
      }
      if (target.calls === 0) target.minMs = tool.minMs
      else target.minMs = Math.min(target.minMs, tool.minMs)
      target.calls += tool.calls
      target.errors += tool.errors
      target.totalMs += tool.totalMs
      target.maxMs = Math.max(target.maxMs, tool.maxMs)
      if (tool.lastAt >= target.lastAt) {
        target.lastAt = tool.lastAt
        target.lastMs = tool.lastMs
      }
      target.slowCalls += tool.slowCalls
      for (const status of CALL_STATUSES) target.statusCounts[status] += tool.statusCounts[status]
    }
  }
  return merged
}

function toToolRow(name: string, tool: ToolTotals): SnapshotToolRow {
  return {
    name,
    calls: tool.calls,
    errors: tool.errors,
    errorRate: tool.calls > 0 ? round4(tool.errors / tool.calls) : 0,
    totalMs: round1(tool.totalMs),
    avgMs: tool.calls > 0 ? round1(tool.totalMs / tool.calls) : 0,
    minMs: round1(tool.minMs),
    maxMs: round1(tool.maxMs),
    lastMs: round1(tool.lastMs),
    lastAt: tool.lastAt,
    slowCalls: tool.slowCalls,
  }
}

function compareToolRows(a: SnapshotToolRow, b: SnapshotToolRow): number {
  if (b.calls !== a.calls) return b.calls - a.calls
  // Code-point comparison keeps the tie order identical on every host (localeCompare
  // is locale-dependent).
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

function persistToolTotals(byTool: ReadonlyMap<string, ToolTotals>): Record<string, ToolTotals> {
  const result: Record<string, ToolTotals> = {}
  for (const [name, tool] of byTool) result[name] = cloneToolTotals(tool)
  return result
}

function cloneStatusCounts(counts: StatusCounts): StatusCounts {
  return { ok: counts.ok, error: counts.error, aborted: counts.aborted, threw: counts.threw }
}

function cloneAggregate(totals: AggregateTotals): AggregateTotals {
  return {
    calls: totals.calls,
    errors: totals.errors,
    totalMs: round1(totals.totalMs),
    maxMs: round1(totals.maxMs),
    slowCalls: totals.slowCalls,
    statusCounts: cloneStatusCounts(totals.statusCounts),
  }
}

function cloneToolTotals(tool: ToolTotals): ToolTotals {
  return {
    calls: tool.calls,
    errors: tool.errors,
    totalMs: round1(tool.totalMs),
    minMs: round1(tool.minMs),
    maxMs: round1(tool.maxMs),
    lastMs: round1(tool.lastMs),
    lastAt: tool.lastAt,
    slowCalls: tool.slowCalls,
    statusCounts: cloneStatusCounts(tool.statusCounts),
  }
}

function parseScope(value: unknown): PersistedScope | undefined {
  if (!isRecord(value)) return undefined
  const byTool: Record<string, ToolTotals> = {}
  const rawTools = isRecord(value['byTool']) ? value['byTool'] : {}
  for (const [name, rawTool] of Object.entries(rawTools)) {
    const parsed = parseToolTotals(rawTool)
    if (parsed !== undefined) byTool[name] = parsed
  }
  const totals = parseAggregate(value['totals']) ?? aggregateFromTools(byTool)
  if (totals === undefined) return undefined
  return { totals, byTool }
}

function parseAggregate(value: unknown): AggregateTotals | undefined {
  if (!isRecord(value)) return undefined
  const calls = parseNonNegativeInteger(value['calls'])
  if (calls === undefined) return undefined
  const statusCounts = parseStatusCounts(value['statusCounts'])
  return {
    calls,
    errors: parseNonNegativeInteger(value['errors']) ?? 0,
    totalMs: parseNonNegativeNumber(value['totalMs']) ?? 0,
    maxMs: parseNonNegativeNumber(value['maxMs']) ?? 0,
    slowCalls: parseNonNegativeInteger(value['slowCalls']) ?? 0,
    statusCounts,
  }
}

function parseToolTotals(value: unknown): ToolTotals | undefined {
  if (!isRecord(value)) return undefined
  const calls = parseNonNegativeInteger(value['calls'])
  if (calls === undefined || calls === 0) return undefined
  return {
    calls,
    errors: parseNonNegativeInteger(value['errors']) ?? 0,
    totalMs: parseNonNegativeNumber(value['totalMs']) ?? 0,
    minMs: parseNonNegativeNumber(value['minMs']) ?? 0,
    maxMs: parseNonNegativeNumber(value['maxMs']) ?? 0,
    lastMs: parseNonNegativeNumber(value['lastMs']) ?? 0,
    lastAt: typeof value['lastAt'] === 'string' ? value['lastAt'] : '',
    slowCalls: parseNonNegativeInteger(value['slowCalls']) ?? 0,
    statusCounts: parseStatusCounts(value['statusCounts']),
  }
}

function parseStatusCounts(value: unknown): StatusCounts {
  const counts = createStatusCounts()
  if (!isRecord(value)) return counts
  for (const status of CALL_STATUSES) {
    const parsed = parseNonNegativeInteger(value[status])
    if (parsed !== undefined) counts[status] = parsed
  }
  return counts
}

function aggregateFromTools(byTool: Record<string, ToolTotals>): AggregateTotals | undefined {
  const entries = Object.values(byTool)
  if (entries.length === 0) return undefined
  const aggregate = createAggregate()
  for (const tool of entries) {
    aggregate.calls += tool.calls
    aggregate.errors += tool.errors
    aggregate.totalMs += tool.totalMs
    aggregate.maxMs = Math.max(aggregate.maxMs, tool.maxMs)
    aggregate.slowCalls += tool.slowCalls
    for (const status of CALL_STATUSES) aggregate.statusCounts[status] += tool.statusCounts[status]
  }
  return aggregate
}

function sessionKeyOf(sessionId: unknown): string {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : UNSCOPED_SESSION_KEY
}

function isCallStatus(value: unknown): value is CallStatus {
  return value === 'ok' || value === 'error' || value === 'aborted' || value === 'threw'
}

function normalizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Re-exported here so the documented `stats` module surface is self-contained.
export type { SnapshotQuery } from './types.js'
