/**
 * The model-facing `tool_usage` tool and the shared Markdown renderer.
 *
 * `view: "summary"` (default) shows totals, the per-tool table, and the newest
 * calls; `"tools"` shows only the table; `"recent"` only the recent list;
 * `"explain"` describes a currently registered tool and its parameters.
 * `scope` defaults to the calling session. The output value is always canonical
 * JSON so other tools/commands can reuse it; `output.render` is a pure projection.
 *
 * @module tool-usage/tool
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ConfigLanguage, ToolUsageConfig } from './config.js';
import type { ToolSchemaInfo } from './explain.js';
import type { StatsStore } from './stats.js';
import type { UsageSnapshot } from './types.js';
/** Supported views of the model-facing tool. */
export type ToolView = 'summary' | 'tools' | 'recent' | 'explain';
/** One parameter row returned by `view: "explain"`. */
export type ExplainParameterDoc = {
    name: string;
    type?: string;
    required: boolean;
    description?: string;
};
/** Canonical JSON value returned by `view: "explain"`. */
export type ToolExplainResult = {
    tool: string;
    description?: string;
    parameters: ExplainParameterDoc[];
};
/** Default number of recent calls returned by the tool. */
export declare const DEFAULT_TOOL_LIMIT = 20;
/** Hard bounds for the `limit` parameter. */
export declare const MIN_TOOL_LIMIT = 1;
export declare const MAX_TOOL_LIMIT = 100;
/** Dependencies of {@link createToolUsageTool}. */
export interface ToolUsageToolDeps {
    stats: StatsStore;
    config: ToolUsageConfig;
    /** Safe registered-schema lookup (returns `undefined` for unknown tools). */
    resolveToolSchema: (name: string, agent?: unknown) => ToolSchemaInfo | undefined;
}
/**
 * Build the model-facing tool definition.
 *
 * @param deps - Stats store, resolved config, and schema lookup.
 * @returns A registry-ready tool definition (read-only/concurrency-safe).
 */
export declare function createToolUsageTool(deps: ToolUsageToolDeps): ToolDefinition;
/**
 * Render a usage snapshot as compact Markdown.
 *
 * @param snapshot - Canonical snapshot returned by the tool/command.
 * @param language - Output language.
 * @param view - Which sections to include.
 * @returns Markdown text.
 */
export declare function renderSnapshotMarkdown(snapshot: UsageSnapshot, language: ConfigLanguage, view?: ToolView): string;
/**
 * Render the `view: "explain"` JSON value as compact Markdown.
 *
 * @param result - Registered tool description + parameter table.
 * @param language - Output language.
 * @returns Markdown text.
 */
export declare function renderExplainMarkdown(result: ToolExplainResult, language: ConfigLanguage): string;
