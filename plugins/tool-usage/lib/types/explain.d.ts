/**
 * Pure, deterministic tool-call explainer.
 *
 * `explainToolCall` turns a tool name and its (already redacted) arguments into a
 * one-line human-readable summary plus optional detail lines. It performs no I/O,
 * reads no clock, and is safe for arbitrary input shapes: every known tool is
 * special-cased with defensive value reads, and unknown tools fall back to a
 * compact `k=v` rendering of their parameters.
 *
 * Output size is bounded so a record can never grow without limit: summaries are
 * capped at {@link MAX_SUMMARY_CHARS}, detail lines at {@link MAX_DETAIL_LINES} and
 * {@link MAX_DETAIL_CHARS}, and registered descriptions (tool and parameter) are
 * clipped with the same per-value cap as argument values.
 *
 * Summaries never contain a newline; detail lines may.
 *
 * @module tool-usage/explain
 */
import type { Explanation } from './types.js';
export type { Explanation };
/** Output language of an explanation. */
export type ExplainLanguage = 'zh' | 'en';
/** Detail level of an explanation; `off` is handled by the recorder (no work). */
export type ExplainLevel = 'off' | 'brief' | 'detailed';
/** Options controlling one explanation. */
export interface ExplainOptions {
    /** Rendering language. */
    language: ExplainLanguage;
    /** `brief` produces only the summary; `detailed` adds description and parameter lines. */
    level: ExplainLevel;
    /** Per-value character cap used inside a summary or detail line. */
    maxValueChars: number;
}
/** Registered tool metadata used for detailed explanations. */
export interface ToolSchemaInfo {
    description?: string;
    parameters?: unknown;
}
/** One declared parameter of a registered tool. */
export interface ParameterDoc {
    name: string;
    type?: string;
    required: boolean;
    description?: string;
}
/** Result of describing a registered tool schema. */
export interface ToolSchemaDescription {
    description?: string;
    parameters: ParameterDoc[];
}
/** Total character cap on a rendered summary (single line, ellipsis included). */
export declare const MAX_SUMMARY_CHARS = 2000;
/** Maximum number of retained detail lines for a `detailed` explanation. */
export declare const MAX_DETAIL_LINES = 50;
/** Maximum total characters across retained detail lines, including newline separators. */
export declare const MAX_DETAIL_CHARS = 8000;
/**
 * Explain one tool call.
 *
 * @param tool - Tool name as invoked.
 * @param args - Parsed (already redacted) arguments; any shape is accepted.
 * @param schema - Registered tool metadata, when available.
 * @param options - Language, detail level, and value cap.
 * @returns The summary plus detail lines (empty for `brief`).
 */
export declare function explainToolCall(tool: string, args: unknown, schema: ToolSchemaInfo | undefined, options: ExplainOptions): Explanation;
/**
 * Describe a registered tool schema for the `view: "explain"` tool result.
 *
 * @param schema - Registered tool metadata.
 * @returns The description (when present) and every declared parameter in schema order.
 */
export declare function describeToolSchema(schema: ToolSchemaInfo | undefined): ToolSchemaDescription;
/**
 * Resolve a tool name to a canonical known name.
 *
 * Exact names win first, then the explicit alias table, then the last namespace
 * segment (`mcp__server__bash`, `functions.read`, ...). A name that merely starts
 * with a known name (`bash2`) is deliberately not classified.
 *
 * @param tool - Raw tool name.
 * @returns Canonical known name, or the lowercased raw name for unknown tools.
 */
export declare function resolveToolName(tool: string): string;
