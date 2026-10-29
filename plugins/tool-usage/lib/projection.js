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
import { explainToolCall, resolveToolName } from './explain.js';
import { redactArgs } from './redact.js';
/** Projection key carrying the live tool-usage view to the Client. */
export const TOOL_USAGE_PROJECTION_KEY = 'toolUsage';
/** Invalidation version for persisted projection state; bump with the shape. */
export const TOOL_USAGE_PROJECTION_STATE_VERSION = 1;
/** Maximum per-tool rows carried in the wire view (the aggregation keeps all tools). */
const MAX_WIRE_TOOL_ROWS = 20;
/** Safety cap on simultaneously open calls folded into one state. */
const MAX_OPEN_CALLS = 200;
/** The wire view's output boundary; the registry only calls `parse`. */
const passthroughSchema = { parse: (value) => value };
/**
 * Create the `toolUsage` projection unit for one resolved plugin config.
 *
 * @param config - Resolved plugin configuration (language, explain level,
 *   redaction limits, and the `ui*` bounds).
 * @returns The projection definition to register on `ctx.sessionProjections`.
 */
export function createToolUsageProjectionDefinition(config) {
    const recentCalls = clamp(config.uiRecentCalls, 1, 500);
    const recentTurns = clamp(config.uiRecentTurns, 1, 200);
    const commandChars = clamp(config.uiCommandChars, 1, 1000);
    const maxErrorChars = clamp(config.maxStringChars, 1, 2000);
    const explainOff = config.explain === 'off';
    /** Build the settled-call presentation from redacted arguments. */
    function describeCall(tool, rawArguments) {
        let parsed = {};
        try {
            parsed = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
        }
        catch {
            parsed = {};
        }
        const redacted = redactArgs(parsed, {
            maxStringChars: config.maxStringChars,
            redactKeys: config.redactKeys,
        });
        const summary = explainOff
            ? ''
            : explainToolCall(tool, redacted.value, undefined, {
                language: config.language,
                level: 'brief',
                maxValueChars: config.maxStringChars,
            }).summary;
        return { summary, command: shellCommand(tool, redacted.value, commandChars) };
    }
    /** Add a settled call to every aggregate it belongs to. */
    function settleCall(state, call, endTime, status, error) {
        const durationMs = round1(Math.max(0, endTime - call.startTime));
        const settled = {
            callId: call.callId,
            tool: call.tool,
            summary: call.summary,
            command: call.command,
            turn: call.turn,
            step: call.step,
            startTime: call.startTime,
            endTime,
            durationMs,
            status,
            error,
        };
        const toolState = state.byTool[call.tool] ?? emptyToolState();
        return {
            ...state,
            totals: {
                calls: state.totals.calls,
                settled: state.totals.settled + 1,
                errors: state.totals.errors + (status === 'error' ? 1 : 0),
                totalMs: state.totals.totalMs + durationMs,
                maxMs: Math.max(state.totals.maxMs, durationMs),
            },
            byTool: {
                ...state.byTool,
                [call.tool]: {
                    calls: toolState.calls,
                    settled: toolState.settled + 1,
                    errors: toolState.errors + (status === 'error' ? 1 : 0),
                    totalMs: toolState.totalMs + durationMs,
                    minMs: toolState.settled === 0 ? durationMs : Math.min(toolState.minMs, durationMs),
                    maxMs: Math.max(toolState.maxMs, durationMs),
                    lastMs: durationMs,
                    lastAt: endTime,
                },
            },
            calls: pushBounded(state.calls, settled, recentCalls),
            turns: addTurnTotals(state.turns, call.turn, status === 'error' ? 1 : 0, durationMs),
            lastEventTime: endTime,
        };
    }
    /** Drop a running call from the open maps. */
    function closeOpen(state, callId) {
        if (state.open[callId] === undefined)
            return state;
        const open = { ...state.open };
        delete open[callId];
        return {
            ...state,
            open,
            runningOrder: state.runningOrder.filter(id => id !== callId),
        };
    }
    return {
        key: TOOL_USAGE_PROJECTION_KEY,
        stateVersion: TOOL_USAGE_PROJECTION_STATE_VERSION,
        stateSchema: passthroughSchema,
        init: () => emptyState(),
        apply: (state, event) => {
            const data = asRecord(event.data);
            switch (event.type) {
                case 'turn/start': {
                    const turn = readNumber(data, 'turn');
                    if (turn === undefined || !Number.isInteger(turn) || turn < 0)
                        return state;
                    const existing = state.turns.findLast(row => row.turn === turn);
                    if (existing !== undefined)
                        return state;
                    const row = {
                        turn,
                        startTime: event.time,
                        endTime: null,
                        calls: 0,
                        errors: 0,
                        totalMs: 0,
                        outcome: 'open',
                    };
                    return {
                        ...state,
                        turns: pushBounded(state.turns, row, recentTurns),
                        turnCount: state.turnCount + 1,
                        lastEventTime: event.time,
                    };
                }
                case 'turn/end': {
                    const turn = readNumber(data, 'turn');
                    if (turn === undefined)
                        return state;
                    const outcome = turnOutcome(data['reason']);
                    let next = {
                        ...state,
                        turns: state.turns.map(row => row.turn === turn
                            ? { ...row, endTime: row.endTime ?? event.time, outcome: row.outcome === 'open' ? outcome : row.outcome }
                            : row),
                        lastEventTime: event.time,
                    };
                    // A call whose result never landed belongs to this closed Turn: settle
                    // it as aborted so the UI cannot show a permanently spinning row.
                    for (const callId of [...next.runningOrder]) {
                        const call = next.open[callId];
                        if (call === undefined)
                            continue;
                        next = closeOpen(next, callId);
                        next = settleCall(next, call, event.time, 'aborted', null);
                    }
                    return next;
                }
                case 'tool/call': {
                    const callId = readString(data, 'callId');
                    const tool = readString(data, 'name');
                    const turn = readNumber(data, 'turn');
                    const step = readNumber(data, 'step');
                    const rawArguments = readString(data, 'arguments');
                    if (callId === undefined || tool === undefined || turn === undefined || step === undefined) {
                        return state;
                    }
                    // Duplicate or capped open sets are ignored instead of double-counting.
                    if (state.open[callId] !== undefined)
                        return state;
                    if (state.runningOrder.length >= MAX_OPEN_CALLS)
                        return state;
                    const described = describeCall(tool, rawArguments ?? '');
                    const running = {
                        callId,
                        tool,
                        summary: described.summary,
                        command: described.command,
                        turn,
                        step,
                        startTime: event.time,
                    };
                    const toolState = state.byTool[tool] ?? emptyToolState();
                    return {
                        ...state,
                        totals: { ...state.totals, calls: state.totals.calls + 1 },
                        byTool: {
                            ...state.byTool,
                            [tool]: { ...toolState, calls: toolState.calls + 1, lastAt: event.time },
                        },
                        turns: addTurnCalls(state.turns, turn),
                        open: { ...state.open, [callId]: running },
                        runningOrder: [...state.runningOrder, callId],
                        lastEventTime: event.time,
                    };
                }
                case 'tool/result': {
                    const message = asRecord(data['message']);
                    const source = asRecord(message['source']);
                    const callId = readString(source, 'callId');
                    if (callId === undefined)
                        return state;
                    const call = state.open[callId];
                    if (call === undefined)
                        return state;
                    const isError = message['isError'] === true;
                    const failure = asRecord(data['error']);
                    const code = readString(failure, 'code');
                    const status = code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH'
                        ? 'aborted'
                        : isError ? 'error' : 'ok';
                    const closed = closeOpen(state, callId);
                    return settleCall(closed, call, event.time, status, status === 'error' ? failureText(message, data, maxErrorChars) : null);
                }
                default:
                    return state;
            }
        },
        wire: {
            viewSchema: passthroughSchema,
            view: state => buildView(state, config.language),
            summary: false,
        },
    };
}
/**
 * Build the complete wire view from fold state.
 *
 * @param state - Current fold state.
 * @param language - Explanation language carried for the Client's fallback copy.
 * @returns A fresh whole-value view (the registry compares references).
 */
export function buildView(state, language) {
    const toolRows = Object.entries(state.byTool)
        .map(([tool, value]) => ({
        tool,
        calls: value.calls,
        errors: value.errors,
        totalMs: round1(value.totalMs),
        avgMs: value.settled === 0 ? 0 : round1(value.totalMs / value.settled),
        maxMs: round1(value.maxMs),
        lastMs: round1(value.lastMs),
        lastAt: value.lastAt,
    }))
        .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool))
        .slice(0, MAX_WIRE_TOOL_ROWS);
    const running = state.runningOrder
        .map(callId => state.open[callId])
        .filter((call) => call !== undefined);
    return {
        v: 1,
        generatedAt: state.lastEventTime,
        language,
        totals: {
            calls: state.totals.calls,
            settled: state.totals.settled,
            errors: state.totals.errors,
            running: running.length,
            totalMs: round1(state.totals.totalMs),
            avgMs: state.totals.settled === 0 ? 0 : round1(state.totals.totalMs / state.totals.settled),
            maxMs: round1(state.totals.maxMs),
            tools: Object.keys(state.byTool).length,
            turns: state.turnCount,
        },
        byTool: toolRows,
        turns: state.turns.map(row => ({ ...row })),
        calls: state.calls.map(row => ({ ...row })),
        running: running.map(row => ({ ...row })),
    };
}
/** Empty fold state, used by `init` and by tests. */
export function emptyState() {
    return {
        totals: { calls: 0, settled: 0, errors: 0, totalMs: 0, maxMs: 0 },
        byTool: {},
        calls: [],
        turns: [],
        turnCount: 0,
        open: {},
        runningOrder: [],
        lastEventTime: 0,
    };
}
function emptyToolState() {
    return { calls: 0, settled: 0, errors: 0, totalMs: 0, minMs: 0, maxMs: 0, lastMs: 0, lastAt: 0 };
}
/** Extract a one-line shell command for bash-family tools from redacted arguments. */
function shellCommand(tool, args, maxChars) {
    if (resolveToolName(tool) !== 'bash')
        return null;
    const record = asRecord(args);
    for (const key of ['command', 'cmd', 'script']) {
        const value = record[key];
        if (typeof value !== 'string' || value.trim().length === 0)
            continue;
        return clipLine(value, maxChars);
    }
    return null;
}
/** Collapse whitespace and cap one display line. */
function clipLine(value, maxChars) {
    const flat = value.replace(/\s+/gu, ' ').trim();
    if (flat.length <= maxChars)
        return flat;
    return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}
/** Bounded best-effort failure text from a tool result. */
function failureText(message, data, maxChars) {
    const failure = asRecord(data['error']);
    const reason = readString(failure, 'reason');
    const candidate = reason
        ?? contentText(message['content'])
        ?? readString(failure, 'name')
        ?? 'tool error';
    return clipLine(candidate, maxChars);
}
/** First text block of a tool result's content, if any. */
function contentText(content) {
    if (!Array.isArray(content))
        return undefined;
    for (const block of content) {
        const record = asRecord(block);
        if (record['type'] !== 'text')
            continue;
        const text = readString(record, 'text');
        if (text !== undefined)
            return text;
    }
    return undefined;
}
/** Map a persisted `TurnEndReason` to the view's outcome discriminator. */
function turnOutcome(reason) {
    const record = asRecord(reason);
    const kind = readString(record, 'kind');
    switch (kind) {
        case 'completed':
        case 'aborted':
        case 'blocked':
        case 'error':
        case 'max-tokens':
        case 'interrupted':
        case 'forked':
            return kind;
        default:
            return 'completed';
    }
}
/** Increment a tracked Turn's call counter (no-op when the row left the ring). */
function addTurnCalls(turns, turn) {
    let changed = false;
    const next = turns.map((row) => {
        if (row.turn !== turn)
            return row;
        changed = true;
        return { ...row, calls: row.calls + 1 };
    });
    return changed ? next : turns;
}
/** Apply one settled call to a tracked Turn (no-op when the row left the ring). */
function addTurnTotals(turns, turn, errors, durationMs) {
    let changed = false;
    const next = turns.map((row) => {
        if (row.turn !== turn)
            return row;
        changed = true;
        return { ...row, errors: row.errors + errors, totalMs: round1(row.totalMs + durationMs) };
    });
    return changed ? next : turns;
}
/** Append to a bounded recent ring, dropping the oldest member. */
function pushBounded(ring, value, limit) {
    const next = [...ring, value];
    if (next.length <= limit)
        return next;
    return next.slice(next.length - limit);
}
function round1(value) {
    return Math.round(value * 10) / 10;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function readString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readNumber(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
