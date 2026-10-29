/**
 * The `tools/execute` wrapper: timing, redaction, explanation, aggregation, and logging.
 *
 * Contract (DESIGN §5.2): the wrapper never changes the tool result, `exec.signal`,
 * or any call identity. It measures around `next()`, records in every outcome
 * (including a rejected `next()`), and rethrows rejections unchanged. Recording is
 * best-effort: a stats/log/explain/schema failure is reported once and never
 * affects the caller's result.
 *
 * Record size is bounded: arguments are capped by `maxStringChars` /
 * `maxParamChars`, explanation summaries/details by the caps in `explain.ts`, and
 * failure messages by `maxStringChars`. Failure messages are taken from the tool
 * result and are **not** key-redacted (they are not part of the argument object).
 *
 * @module tool-usage/recorder
 */
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { ToolUsageConfig } from './config.js';
import type { ToolSchemaInfo } from './explain.js';
import type { JsonlCallLog } from './log.js';
import type { StatsStore } from './stats.js';
import type { LoggerLike } from './types.js';
/**
 * Smallest serialized form of the whole-params truncation preview,
 * `{"_truncated":"…"}`. A configured `maxParamChars` below this cannot be honoured
 * literally, so the effective cap is raised to this floor (documented in README and
 * DESIGN §7).
 */
export declare const MIN_TRUNCATED_PARAMS_JSON_CHARS = 18;
/** Dependencies of a {@link ToolUsageRecorder}. */
export interface ToolUsageRecorderOptions {
    stats: StatsStore;
    log: JsonlCallLog;
    config: ToolUsageConfig;
    logger: LoggerLike;
    /** Safe schema lookup supplied by the plugin entry (`ctx.tools.get` in a try/catch). */
    resolveToolSchema: (name: string, agent?: unknown) => ToolSchemaInfo | undefined;
}
/**
 * Wraps `tools/execute` to record every call.
 */
export declare class ToolUsageRecorder {
    private readonly stats;
    private readonly log;
    private readonly config;
    private readonly resolveToolSchema;
    private readonly warn;
    private seq;
    /**
     * @param options - Store, log, resolved config, logger, and schema resolver.
     */
    constructor(options: ToolUsageRecorderOptions);
    /**
     * Around-dispatch listener body. Must be used exactly once per `tools/execute`
     * invocation and its return value/rejection must be returned unchanged.
     *
     * @param exec - The pending, allowed call.
     * @param next - Dispatch continuation returning the normalized result.
     * @returns The exact result produced by `next()`.
     */
    wrap(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
    /**
     * Flush the log queue and write the final statistics snapshot.
     */
    dispose(): Promise<void>;
    private buildRecord;
    private explain;
    private capParams;
    private commit;
}
