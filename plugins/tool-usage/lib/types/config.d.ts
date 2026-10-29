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
import type { LoggerLike } from './types.js';
/** Explanation detail level. */
export type ExplainSetting = 'off' | 'brief' | 'detailed';
/** Output language. */
export type ConfigLanguage = 'zh' | 'en';
/** Fully resolved plugin configuration (every field present). */
export interface ToolUsageConfig {
    /** Master switch; when false the plugin logs once and does nothing. */
    enabled: boolean;
    /** Directory for `calls-*.jsonl` and `stats.json`; `''` disables persistence. */
    outputDir: string;
    /** Append one JSONL line per call. */
    persistCalls: boolean;
    /** Periodically write the aggregated statistics snapshot. */
    persistStats: boolean;
    /** Restore aggregates from `stats.json` at startup. */
    restoreStats: boolean;
    /** Explanation detail level. */
    explain: ExplainSetting;
    /** Explanation/output language. */
    language: ConfigLanguage;
    /** Cap on the whole serialized argument object. */
    maxParamChars: number;
    /** Cap on each individual string value. */
    maxStringChars: number;
    /** Default sensitive key stems plus user additions. */
    redactKeys: readonly string[];
    /** Number of recent calls kept in memory. */
    recentLimit: number;
    /** A call is marked slow when its duration reaches this many milliseconds. */
    slowThresholdMs: number;
    /** Model-facing tool name. */
    toolName: string;
    /** Slash-command name (without the leading slash). */
    commandName: string;
    /** Debounce for stats snapshot writes. */
    statsWriteDebounceMs: number;
    /** Include redacted parameters in report/snapshot output. */
    includeParamsInReport: boolean;
    /** Register the client-facing `toolUsage` session projection for the Web UI. */
    uiEnabled: boolean;
    /** Number of recent settled calls carried in the projection wire view. */
    uiRecentCalls: number;
    /** Number of recent turns carried in the projection wire view. */
    uiRecentTurns: number;
    /** Character cap for the shell command line carried in the projection wire view. */
    uiCommandChars: number;
}
/** Default directory template, expanded against the running DSH home. */
export declare const DEFAULT_OUTPUT_DIR = "$DSH_HOME/tool-usage";
/** Default model-facing tool name. */
export declare const DEFAULT_TOOL_NAME = "tool_usage";
/** Default slash-command name. */
export declare const DEFAULT_COMMAND_NAME = "tool-usage";
/** Dependencies for {@link resolveConfig}. */
export interface ResolveConfigOptions {
    /** Logger used for one warning per invalid field; diagnostics stay out of console.* */
    logger?: LoggerLike;
    /** Environment used for `$DSH_HOME` expansion; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}
/**
 * Resolve the DSH home directory from the environment.
 *
 * @param env - Process environment.
 * @returns The trimmed `DSH_HOME`, else `<home>/.dsh`, as an absolute path.
 */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
/**
 * Expand `~` and `$DSH_HOME` prefixes and make the result absolute.
 *
 * `''` (or whitespace-only) means "do not persist" and stays empty.
 *
 * @param input - Configured output directory template.
 * @param env - Process environment used for `$DSH_HOME`.
 * @returns An absolute normalized path, or `''`.
 */
export declare function resolveOutputDir(input: string, env?: NodeJS.ProcessEnv): string;
/**
 * Normalize raw plugin config, tolerating unknown keys and invalid values.
 *
 * @param rawConfig - Raw Cordis config (usually a plain object, `undefined` when omitted).
 * @param options - Optional logger and environment override.
 * @returns A fully populated {@link ToolUsageConfig}.
 */
export declare function resolveConfig(rawConfig: unknown, options?: ResolveConfigOptions): ToolUsageConfig;
