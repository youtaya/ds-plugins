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
import type { CallRecord, PersistedStats, SnapshotQuery, UsageSnapshot } from './types.js';
/** Options for {@link StatsStore}. */
export interface StatsStoreOptions {
    /** Maximum number of recent calls retained in memory. */
    recentLimit: number;
    /**
     * Duration at which a call is counted as slow. Additive to the documented
     * `{ recentLimit }` options because the snapshots must classify slowness in
     * the store rather than in the caller.
     */
    slowThresholdMs?: number;
}
/**
 * In-memory aggregation store. One instance is created per plugin lifetime.
 */
export declare class StatsStore {
    private readonly recentLimit;
    private readonly slowThresholdMs;
    private sessions;
    private recent;
    /**
     * @param options - Recent-call ring size and slow-call threshold.
     */
    constructor(options: StatsStoreOptions);
    /**
     * Fold one recorded call into the aggregates and the recent-calls ring.
     *
     * @param record - Immutable call record produced by the recorder.
     */
    record(record: CallRecord): void;
    /**
     * Build one usage snapshot.
     *
     * @param query - Scope, limit, and inclusion flags. Milliseconds are rounded to one decimal.
     * @returns The canonical {@link UsageSnapshot}.
     */
    snapshot(query: SnapshotQuery): UsageSnapshot;
    /**
     * Serialize global and per-session aggregates (recent calls are not persisted;
     * the JSONL log is their source of truth).
     *
     * @returns A JSON-safe snapshot for `stats.json`.
     */
    toJSON(): PersistedStats;
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
    restore(data: unknown): void;
    /**
     * Clear in-memory aggregates.
     *
     * @param scope - `'all'` (default) clears everything; `{ sessionId }` clears that session only.
     */
    reset(scope?: 'all' | {
        sessionId: string;
    }): void;
    private ensureScope;
    private countSessions;
    private isSlow;
    private selectRecent;
}
/** Round a millisecond value to one decimal place. */
export declare function round1(value: number): number;
export type { SnapshotQuery } from './types.js';
