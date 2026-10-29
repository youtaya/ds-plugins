/**
 * `dsh-plugin-tool-usage` entry point.
 *
 * Wires the recorder into the `tools/execute` waterfall, registers the
 * model-facing `tool_usage` tool, and — when the optional `commands` service is
 * present — the human `/tool-usage` slash command. Every listener and
 * registration is effect-scoped, so a hot reload disposes the previous instance
 * (including a final log flush and stats snapshot).
 *
 * @module tool-usage
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name used by loader diagnostics and logger naming. */
export declare const name = "tool-usage";
/** The recorder only needs the tool registry; `commands` is injected optionally. */
export declare const inject: string[];
/**
 * Plugin entry point.
 *
 * @param ctx - Plugin-scoped Cordis context.
 * @param rawConfig - Unvalidated Cordis config; normalized by `resolveConfig`.
 */
export declare function apply(ctx: Context, rawConfig?: unknown): void;
