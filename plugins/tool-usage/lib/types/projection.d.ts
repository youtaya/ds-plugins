/**
 * Client-facing session projection for the tool-usage Web UI.
 *
 * The Host folds committed `turn/start`, `tool/call`, `tool/result`, and
 * `turn/end` events into a bounded, privacy-bounded view of the current
 * Session's tool activity. The registry pushes whole values to the browser, so
 * the Client never folds the event log itself; the per-turn dashboard card,
 * session dashboard, and right-side live stream all read the same `toolUsage`
 * key.
 *
 * Design constraints:
 * - The fold is synchronous and pure, and returns the same state reference for
 *   unrelated events (`Object.is` gates all downstream work).
 * - State is plain JSON because the projection cache checkpoints it.
 * - Arguments never leave the Host: the wire view carries only the deterministic
 *   explanation summary, the extracted shell command line, and aggregate
 *   numbers. Explanation and command text are derived from redacted arguments.
 * - Memory is bounded: settled calls and turn rows are recent rings; per-tool
 *   and whole-session totals cover the complete log.
 *
 * The definition is registered with `ctx.sessionProjections` through a nested
 * optional injection in `index.ts`; keeping the type surface local means the
 * plugin keeps zero runtime dependencies.
 *
 * @module tool-usage/projection
 */
import type { ToolUsageConfig } from './config.js';
/** Projection key carrying the live tool-usage view to the Client. */
export declare const TOOL_USAGE_PROJECTION_KEY = "toolUsage";
/** Invalidation version for persisted projection state; bump with the shape. */
export declare const TOOL_USAGE_PROJECTION_STATE_VERSION = 1;
/** Normalized outcome carried in the view for a settled call. */
export type ToolUsageCallStatus = 'ok' | 'error' | 'aborted';
/** Turn lifecycle state carried in the view. */
export type ToolUsageTurnOutcome = 'open' | 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked';
/** One settled call in the wire view (and the recent ring folded by the Host). */
export interface ToolUsageCallView {
    callId: string;
    tool: string;
    /** One-line deterministic explanation; empty when explanation is disabled. */
    summary: string;
    /** Shell command line for `bash`-family tools; null for other tools. */
    command: string | null;
    turn: number;
    step: number;
    /** Unix epoch ms when the call event was committed. */
    startTime: number;
    /** Unix epoch ms when the result (or the turn-end flush) was committed. */
    endTime: number;
    durationMs: number;
    status: ToolUsageCallStatus;
    /** Bounded failure message for `error`; null otherwise. */
    error: string | null;
}
/** One currently running call in the wire view. */
export interface ToolUsageRunningView {
    callId: string;
    tool: string;
    summary: string;
    command: string | null;
    turn: number;
    step: number;
    startTime: number;
}
/** One tool's whole-session aggregates in the wire view. */
export interface ToolUsageToolRow {
    tool: string;
    calls: number;
    errors: number;
    totalMs: number;
    avgMs: number;
    maxMs: number;
    lastMs: number;
    /** Unix epoch ms of the tool's most recent settled call. */
    lastAt: number;
}
/** One Turn's aggregates in the wire view. */
export interface ToolUsageTurnRow {
    turn: number;
    startTime: number;
    /** Null while the Turn is open (or its `turn/end` left the recent ring). */
    endTime: number | null;
    calls: number;
    errors: number;
    totalMs: number;
    outcome: ToolUsageTurnOutcome;
}
/** Whole-session totals in the wire view. */
export interface ToolUsageTotalsView {
    /** Calls started (settled + running). */
    calls: number;
    settled: number;
    errors: number;
    running: number;
    totalMs: number;
    /** Mean settled duration, rounded to 0.1 ms. */
    avgMs: number;
    maxMs: number;
    /** Distinct tool names observed. */
    tools: number;
    /** Turns observed over the whole Session (may exceed `turns.length`). */
    turns: number;
}
/** Complete wire view of the `toolUsage` projection. */
export interface ToolUsageView {
    v: 1;
    /** Unix epoch ms of the last folded event; 0 for an empty Session. */
    generatedAt: number;
    language: 'zh' | 'en';
    totals: ToolUsageTotalsView;
    byTool: ToolUsageToolRow[];
    turns: ToolUsageTurnRow[];
    calls: ToolUsageCallView[];
    running: ToolUsageRunningView[];
}
/** Per-tool fold state (plain JSON). */
interface ToolUsageToolState {
    calls: number;
    settled: number;
    errors: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    lastMs: number;
    lastAt: number;
}
/** Fold state of one Turn (plain JSON, view-shaped). */
type TurnState = ToolUsageTurnRow;
/** Persisted/cached projection state for one Session. */
export interface ToolUsageState {
    totals: {
        calls: number;
        settled: number;
        errors: number;
        totalMs: number;
        maxMs: number;
    };
    byTool: Record<string, ToolUsageToolState>;
    /** Recent settled calls, ascending by end time; bounded by `uiRecentCalls`. */
    calls: ToolUsageCallView[];
    /** Recent turns, ascending; bounded by `uiRecentTurns`. */
    turns: TurnState[];
    /** Turns observed over the whole Session, including turns that left the ring. */
    turnCount: number;
    /** Running calls by call id. */
    open: Record<string, ToolUsageRunningView>;
    /** Running call ids in start order (JSON object key order is not relied on). */
    runningOrder: string[];
    /** Last folded event time, used for `generatedAt`. */
    lastEventTime: number;
}
/** Minimal Session event shape read by the fold; unknown fields are ignored. */
export interface ToolUsageProjectionEvent {
    readonly type: string;
    readonly time: number;
    readonly data?: unknown;
}
/** Minimal structural projection definition accepted by the registry. */
export interface ToolUsageProjectionDefinition {
    key: typeof TOOL_USAGE_PROJECTION_KEY;
    stateVersion: typeof TOOL_USAGE_PROJECTION_STATE_VERSION;
    /** Structural stand-in for the registry's schema (only `parse` is called). */
    stateSchema: {
        parse(value: unknown): unknown;
    };
    init(header: unknown, inheritedEventCount: unknown): ToolUsageState;
    apply(state: ToolUsageState, event: ToolUsageProjectionEvent): ToolUsageState;
    wire: {
        viewSchema: {
            parse(value: unknown): unknown;
        };
        view(state: ToolUsageState): ToolUsageView;
        summary: false;
    };
}
/**
 * Create the `toolUsage` projection unit for one resolved plugin config.
 *
 * @param config - Resolved plugin configuration (language, explain level,
 *   redaction limits, and the `ui*` bounds).
 * @returns The projection definition to register on `ctx.sessionProjections`.
 */
export declare function createToolUsageProjectionDefinition(config: ToolUsageConfig): ToolUsageProjectionDefinition;
/**
 * Build the complete wire view from fold state.
 *
 * @param state - Current fold state.
 * @param language - Explanation language carried for the Client's fallback copy.
 * @returns A fresh whole-value view (the registry compares references).
 */
export declare function buildView(state: ToolUsageState, language: 'zh' | 'en'): ToolUsageView;
/** Empty fold state, used by `init` and by tests. */
export declare function emptyState(): ToolUsageState;
export {};
