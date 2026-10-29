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
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createWarnOnce } from './warn.js';
const DEFAULT_DEBOUNCE_MS = 2000;
/**
 * Ordered, failure-tolerant JSONL writer.
 */
export class JsonlCallLog {
    directory;
    persistCalls;
    persistStats;
    debounceMs;
    appendChain = Promise.resolve();
    statsChain = Promise.resolve();
    pendingStats;
    statsTimer;
    closed = false;
    directoryReady;
    warn;
    modeFixed = new Set();
    /**
     * @param options - Target directory, persistence switches, debounce, and logger.
     */
    constructor(options) {
        this.directory = typeof options.directory === 'string' ? options.directory.trim() : '';
        this.persistCalls = options.persistCalls === true && this.directory.length > 0;
        this.persistStats = options.persistStats === true && this.directory.length > 0;
        this.debounceMs = clampInt(options.debounceMs, DEFAULT_DEBOUNCE_MS, 0, 3_600_000);
        this.warn = createWarnOnce(options.logger);
    }
    /**
     * Append one record to today's JSONL file. Non-blocking, ordered, never throws.
     *
     * @param record - Record to serialize as one JSON line.
     */
    append(record) {
        if (this.closed || !this.persistCalls)
            return;
        let line;
        try {
            line = `${JSON.stringify(record)}\n`;
        }
        catch (error) {
            this.warn('serialize', 'failed to serialize a call record', error);
            return;
        }
        const file = path.join(this.directory, `calls-${localDateString(record.at)}.jsonl`);
        this.appendChain = this.appendChain
            .then(async () => {
            if (this.closed)
                return;
            const ready = await this.ensureDirectory();
            if (!ready)
                return;
            await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
            await this.ensureFileMode(file);
        })
            .catch((error) => {
            this.warn('append', 'failed to append to the call log', error);
        });
    }
    /**
     * Schedule a debounced statistics snapshot write. Later calls replace the
     * pending snapshot; the timer is unref'd so it never keeps the process alive.
     *
     * @param snapshot - Latest aggregate snapshot.
     */
    scheduleStats(snapshot) {
        if (this.closed || !this.persistStats)
            return;
        this.pendingStats = snapshot;
        this.cancelStatsTimer();
        this.statsTimer = setTimeout(() => {
            this.statsTimer = undefined;
            void this.writePendingStats();
        }, this.debounceMs);
        this.statsTimer.unref();
    }
    /**
     * Read and parse the persisted statistics snapshot.
     *
     * @returns The parsed snapshot, or `undefined` when missing/malformed.
     */
    async restoreStats() {
        if (this.directory.length === 0)
            return undefined;
        try {
            const text = await readFile(path.join(this.directory, 'stats.json'), 'utf8');
            const parsed = JSON.parse(text);
            if (!isRecord(parsed)) {
                this.warn('restore-shape', 'ignoring a malformed statistics snapshot');
                return undefined;
            }
            return parsed;
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR'))
                return undefined;
            this.warn('restore', 'failed to restore the statistics snapshot', error);
            return undefined;
        }
    }
    /**
     * Await every pending append and write any debounced statistics snapshot now.
     */
    async flush() {
        this.cancelStatsTimer();
        const statsWrite = this.writePendingStats();
        await this.appendChain;
        await statsWrite;
        await this.statsChain;
        await this.appendChain;
    }
    /**
     * Flush pending work and drop later appends/snapshots. Idempotent.
     */
    async dispose() {
        if (this.closed)
            return;
        try {
            await this.flush();
        }
        finally {
            this.closed = true;
            this.cancelStatsTimer();
            this.pendingStats = undefined;
        }
    }
    cancelStatsTimer() {
        if (this.statsTimer !== undefined) {
            clearTimeout(this.statsTimer);
            this.statsTimer = undefined;
        }
    }
    writePendingStats() {
        const snapshot = this.pendingStats;
        this.pendingStats = undefined;
        if (snapshot === undefined || !this.persistStats)
            return this.statsChain;
        this.statsChain = this.statsChain
            .then(async () => this.writeStatsFile(snapshot))
            .catch((error) => {
            this.warn('stats-write', 'failed to write the statistics snapshot', error);
        });
        return this.statsChain;
    }
    async writeStatsFile(snapshot) {
        const ready = await this.ensureDirectory();
        if (!ready)
            return;
        const target = path.join(this.directory, 'stats.json');
        // Unique per process and per write: two writers racing on the same directory can
        // never rename each other's partially written file (last writer still wins).
        const temporary = path.join(this.directory, `stats.json.${process.pid}.${randomUUID()}.tmp`);
        const content = `${JSON.stringify(snapshot, null, 2)}\n`;
        try {
            await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
            await rename(temporary, target);
        }
        catch (error) {
            await rm(temporary, { force: true }).catch(() => { });
            throw error;
        }
    }
    /**
     * Best-effort: tighten an existing daily file to `0o600` once per process. Creation
     * already uses `0o600`; this covers a file left world-readable by an older version
     * or by an operator.
     */
    async ensureFileMode(file) {
        if (this.modeFixed.has(file))
            return;
        this.modeFixed.add(file);
        try {
            await chmod(file, 0o600);
        }
        catch (error) {
            this.warn('chmod', 'failed to enforce 0o600 on a call-log file', error);
        }
    }
    ensureDirectory() {
        if (this.directory.length === 0)
            return Promise.resolve(false);
        if (this.directoryReady === undefined) {
            this.directoryReady = mkdir(this.directory, { recursive: true, mode: 0o700 })
                .then(() => true)
                .catch((error) => {
                // Do not cache a transient failure forever: the next append retries mkdir,
                // while the warning stays one-per-process.
                this.directoryReady = undefined;
                this.warn('mkdir', `cannot create output directory ${this.directory}`, error);
                return false;
            });
        }
        return this.directoryReady;
    }
}
function localDateString(iso) {
    const parsed = typeof iso === 'string' ? new Date(iso) : new Date(Number.NaN);
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isErrorCode(error, code) {
    return typeof error === 'object' && error !== null && 'code' in error
        && error.code === code;
}
function clampInt(value, fallback, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
