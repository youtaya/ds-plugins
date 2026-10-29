/**
 * Durable JSONL call log plus atomic statistics snapshot.
 *
 * Writes are serialized through promise chains so records keep their commit
 * order and a slow/failed write never blocks the caller. Every failure is
 * reported at most once and is otherwise swallowed: recording is best-effort and
 * must never affect a tool result.
 *
 * Files live in one directory:
 * - `calls-YYYY-MM-DD.jsonl` — one JSON line per call, local date;
 * - `stats.json` — the latest aggregated snapshot, rewritten atomically through a
 *   per-process unique temporary file.
 *
 * File modes are best-effort: newly created files get `0o600`, and an existing
 * daily file is tightened to `0o600` once per process on its first append (a
 * pre-existing world-readable file therefore stops leaking). A failed output
 * directory creation is retried on a later write instead of disabling persistence
 * for the plugin lifetime.
 *
 * `stats.json` is a single aggregate snapshot with last-writer-wins semantics, so
 * it assumes one DSH process per `$DSH_HOME`; the append-only JSONL log remains safe
 * with concurrent writers.
 *
 * @module tool-usage/log
 */
import type { CallRecord, LoggerLike, PersistedStats } from './types.js';
/** Options for {@link JsonlCallLog}. */
export interface JsonlCallLogOptions {
    /** Absolute output directory; `''` disables persistence. */
    directory: string;
    /** Append one JSONL line per recorded call. */
    persistCalls: boolean;
    /** Periodically write the aggregated statistics snapshot. */
    persistStats: boolean;
    /** Debounce for the statistics snapshot write. */
    debounceMs: number;
    /** Logger for one warning per failure class. */
    logger?: LoggerLike;
}
/**
 * Ordered, failure-tolerant JSONL writer.
 */
export declare class JsonlCallLog {
    private readonly directory;
    private readonly persistCalls;
    private readonly persistStats;
    private readonly debounceMs;
    private appendChain;
    private statsChain;
    private pendingStats;
    private statsTimer;
    private closed;
    private directoryReady;
    private readonly warn;
    private readonly modeFixed;
    /**
     * @param options - Target directory, persistence switches, debounce, and logger.
     */
    constructor(options: JsonlCallLogOptions);
    /**
     * Append one record to today's JSONL file. Non-blocking, ordered, never throws.
     *
     * @param record - Record to serialize as one JSON line.
     */
    append(record: CallRecord): void;
    /**
     * Schedule a debounced statistics snapshot write. Later calls replace the
     * pending snapshot; the timer is unref'd so it never keeps the process alive.
     *
     * @param snapshot - Latest aggregate snapshot.
     */
    scheduleStats(snapshot: PersistedStats): void;
    /**
     * Read and parse the persisted statistics snapshot.
     *
     * @returns The parsed snapshot, or `undefined` when missing/malformed.
     */
    restoreStats(): Promise<PersistedStats | undefined>;
    /**
     * Await every pending append and write any debounced statistics snapshot now.
     */
    flush(): Promise<void>;
    /**
     * Flush pending work and drop later appends/snapshots. Idempotent.
     */
    dispose(): Promise<void>;
    private cancelStatsTimer;
    private writePendingStats;
    private writeStatsFile;
    /**
     * Best-effort: tighten an existing daily file to `0o600` once per process. Creation
     * already uses `0o600`; this covers a file left world-readable by an older version
     * or by an operator.
     */
    private ensureFileMode;
    private ensureDirectory;
}
