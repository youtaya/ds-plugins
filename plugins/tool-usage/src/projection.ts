/**
 * Client-facing session projection for the tool-usage Web UI.
 *
 * The Host folds committed `turn/start`, `tool/call`, `tool/result`, and
 * `turn/end` events into a bounded, privacy-bounded view of the current
 * Session's tool activity. The registry pushes whole values to the browser, so
 * the Client never folds the event log itself and the live strip, per-turn
 * dashboard card, and session dashboard all read the same `toolUsage` key.
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

import type { ToolUsageConfig } from './config.js'
import { explainToolCall, resolveToolName } from './explain.js'
import { redactArgs } from './redact.js'
import type { JsonValue } from './types.js'

/** Projection key carrying the live tool-usage view to the Client. */
export const TOOL_USAGE_PROJECTION_KEY = 'toolUsage'

/** Invalidation version for persisted projection state; bump with the shape. */
export const TOOL_USAGE_PROJECTION_STATE_VERSION = 1

/** Maximum per-tool rows carried in the wire view (the aggregation keeps all tools). */
const MAX_WIRE_TOOL_ROWS = 20

/** Safety cap on simultaneously open calls folded into one state. */
const MAX_OPEN_CALLS = 200

/** Normalized outcome carried in the view for a settled call. */
export type ToolUsageCallStatus = 'ok' | 'error' | 'aborted'

/** Turn lifecycle state carried in the view. */
export type ToolUsageTurnOutcome =
  | 'open'
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'forked'

/** One settled call in the wire view (and the recent ring folded by the Host). */
export interface ToolUsageCallView {
  callId: string
  tool: string
  /** One-line deterministic explanation; empty when explanation is disabled. */
  summary: string
  /** Shell command line for `bash`-family tools; null for other tools. */
  command: string | null
  turn: number
  step: number
  /** Unix epoch ms when the call event was committed. */
  startTime: number
  /** Unix epoch ms when the result (or the turn-end flush) was committed. */
  endTime: number
  durationMs: number
  status: ToolUsageCallStatus
  /** Bounded failure message for `error`; null otherwise. */
  error: string | null
}

/** One currently running call in the wire view. */
export interface ToolUsageRunningView {
  callId: string
  tool: string
  summary: string
  command: string | null
  turn: number
  step: number
  startTime: number
}

/** One tool's whole-session aggregates in the wire view. */
export interface ToolUsageToolRow {
  tool: string
  calls: number
  errors: number
  totalMs: number
  avgMs: number
  maxMs: number
  lastMs: number
  /** Unix epoch ms of the tool's most recent settled call. */
  lastAt: number
}

/** One Turn's aggregates in the wire view. */
export interface ToolUsageTurnRow {
  turn: number
  startTime: number
  /** Null while the Turn is open (or its `turn/end` left the recent ring). */
  endTime: number | null
  calls: number
  errors: number
  totalMs: number
  outcome: ToolUsageTurnOutcome
}

/** Whole-session totals in the wire view. */
export interface ToolUsageTotalsView {
  /** Calls started (settled + running). */
  calls: number
  settled: number
  errors: number
  running: number
  totalMs: number
  /** Mean settled duration, rounded to 0.1 ms. */
  avgMs: number
  maxMs: number
  /** Distinct tool names observed. */
  tools: number
  /** Turns observed over the whole Session (may exceed `turns.length`). */
  turns: number
}

/** Complete wire view of the `toolUsage` projection. */
export interface ToolUsageView {
  v: 1
  /** Unix epoch ms of the last folded event; 0 for an empty Session. */
  generatedAt: number
  language: 'zh' | 'en'
  totals: ToolUsageTotalsView
  byTool: ToolUsageToolRow[]
  turns: ToolUsageTurnRow[]
  calls: ToolUsageCallView[]
  running: ToolUsageRunningView[]
}

/** Per-tool fold state (plain JSON). */
interface ToolUsageToolState {
  calls: number
  settled: number
  errors: number
  totalMs: number
  minMs: number
  maxMs: number
  lastMs: number
  lastAt: number
}

/** Fold state of one Turn (plain JSON, view-shaped). */
type TurnState = ToolUsageTurnRow

/** Persisted/cached projection state for one Session. */
export interface ToolUsageState {
  totals: { calls: number; settled: number; errors: number; totalMs: number; maxMs: number }
  byTool: Record<string, ToolUsageToolState>
  /** Recent settled calls, ascending by end time; bounded by `uiRecentCalls`. */
  calls: ToolUsageCallView[]
  /** Recent turns, ascending; bounded by `uiRecentTurns`. */
  turns: TurnState[]
  /** Turns observed over the whole Session, including turns that left the ring. */
  turnCount: number
  /** Running calls by call id. */
  open: Record<string, ToolUsageRunningView>
  /** Running call ids in start order (JSON object key order is not relied on). */
  runningOrder: string[]
  /** Last folded event time, used for `generatedAt`. */
  lastEventTime: number
}

/** Minimal Session event shape read by the fold; unknown fields are ignored. */
export interface ToolUsageProjectionEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/** Minimal structural projection definition accepted by the registry. */
export interface ToolUsageProjectionDefinition {
  key: typeof TOOL_USAGE_PROJECTION_KEY
  stateVersion: typeof TOOL_USAGE_PROJECTION_STATE_VERSION
  /** Structural stand-in for the registry's schema (only `parse` is called). */
  stateSchema: { parse(value: unknown): unknown }
  init(header: unknown, inheritedEventCount: unknown): ToolUsageState
  apply(state: ToolUsageState, event: ToolUsageProjectionEvent): ToolUsageState
  wire: {
    viewSchema: { parse(value: unknown): unknown }
    view(state: ToolUsageState): ToolUsageView
    summary: false
  }
}

/** The wire view's output boundary; the registry only calls `parse`. */
const passthroughSchema = { parse: (value: unknown): unknown => value }

/**
 * Create the `toolUsage` projection unit for one resolved plugin config.
 *
 * @param config - Resolved plugin configuration (language, explain level,
 *   redaction limits, and the `ui*` bounds).
 * @returns The projection definition to register on `ctx.sessionProjections`.
 */
export function createToolUsageProjectionDefinition(
  config: ToolUsageConfig,
): ToolUsageProjectionDefinition {
  const recentCalls = clamp(config.uiRecentCalls, 1, 500)
  const recentTurns = clamp(config.uiRecentTurns, 1, 200)
  const commandChars = clamp(config.uiCommandChars, 1, 1000)
  const maxErrorChars = clamp(config.maxStringChars, 1, 2000)
  const explainOff = config.explain === 'off'

  /** Build the settled-call presentation from redacted arguments. */
  function describeCall(
    tool: string,
    rawArguments: string,
  ): { summary: string; command: string | null } {
    let parsed: unknown = {}
    try {
      parsed = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments)
    } catch {
      parsed = {}
    }
    const redacted = redactArgs(parsed, {
      maxStringChars: config.maxStringChars,
      redactKeys: config.redactKeys,
    })
    const summary = explainOff
      ? ''
      : explainToolCall(tool, redacted.value, undefined, {
        language: config.language,
        level: 'brief',
        maxValueChars: config.maxStringChars,
      }).summary
    return { summary, command: shellCommand(tool, redacted.value, commandChars) }
  }

  /** Add a settled call to every aggregate it belongs to. */
  function settleCall(
    state: ToolUsageState,
    call: ToolUsageRunningView,
    endTime: number,
    status: ToolUsageCallStatus,
    error: string | null,
  ): ToolUsageState {
    const durationMs = round1(Math.max(0, endTime - call.startTime))
    const settled: ToolUsageCallView = {
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
    }
    const toolState = state.byTool[call.tool] ?? emptyToolState()
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
    }
  }

  /** Drop a running call from the open maps. */
  function closeOpen(state: ToolUsageState, callId: string): ToolUsageState {
    if (state.open[callId] === undefined) return state
    const open = { ...state.open }
    delete open[callId]
    return {
      ...state,
      open,
      runningOrder: state.runningOrder.filter(id => id !== callId),
    }
  }

  return {
    key: TOOL_USAGE_PROJECTION_KEY,
    stateVersion: TOOL_USAGE_PROJECTION_STATE_VERSION,
    stateSchema: passthroughSchema,
    init: () => emptyState(),
    apply: (state, event) => {
      const data = asRecord(event.data)
      switch (event.type) {
        case 'turn/start': {
          const turn = readNumber(data, 'turn')
          if (turn === undefined || !Number.isInteger(turn) || turn < 0) return state
          const existing = state.turns.findLast(row => row.turn === turn)
          if (existing !== undefined) return state
          const row: ToolUsageTurnRow = {
            turn,
            startTime: event.time,
            endTime: null,
            calls: 0,
            errors: 0,
            totalMs: 0,
            outcome: 'open',
          }
          return {
            ...state,
            turns: pushBounded(state.turns, row, recentTurns),
            turnCount: state.turnCount + 1,
            lastEventTime: event.time,
          }
        }
        case 'turn/end': {
          const turn = readNumber(data, 'turn')
          if (turn === undefined) return state
          const outcome = turnOutcome(data['reason'])
          let next: ToolUsageState = {
            ...state,
            turns: state.turns.map(row => row.turn === turn
              ? { ...row, endTime: row.endTime ?? event.time, outcome: row.outcome === 'open' ? outcome : row.outcome }
              : row),
            lastEventTime: event.time,
          }
          // A call whose result never landed belongs to this closed Turn: settle
          // it as aborted so the UI cannot show a permanently spinning row.
          for (const callId of [...next.runningOrder]) {
            const call = next.open[callId]
            if (call === undefined) continue
            next = closeOpen(next, callId)
            next = settleCall(next, call, event.time, 'aborted', null)
          }
          return next
        }
        case 'tool/call': {
          const callId = readString(data, 'callId')
          const tool = readString(data, 'name')
          const turn = readNumber(data, 'turn')
          const step = readNumber(data, 'step')
          const rawArguments = readString(data, 'arguments')
          if (callId === undefined || tool === undefined || turn === undefined || step === undefined) {
            return state
          }
          // Duplicate or capped open sets are ignored instead of double-counting.
          if (state.open[callId] !== undefined) return state
          if (state.runningOrder.length >= MAX_OPEN_CALLS) return state
          const described = describeCall(tool, rawArguments ?? '')
          const running: ToolUsageRunningView = {
            callId,
            tool,
            summary: described.summary,
            command: described.command,
            turn,
            step,
            startTime: event.time,
          }
          const toolState = state.byTool[tool] ?? emptyToolState()
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
          }
        }
        case 'tool/result': {
          const message = asRecord(data['message'])
          const source = asRecord(message['source'])
          const callId = readString(source, 'callId')
          if (callId === undefined) return state
          const call = state.open[callId]
          if (call === undefined) return state
          const isError = message['isError'] === true
          const failure = asRecord(data['error'])
          const code = readString(failure, 'code')
          const status: ToolUsageCallStatus = code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH'
            ? 'aborted'
            : isError ? 'error' : 'ok'
          const closed = closeOpen(state, callId)
          return settleCall(
            closed,
            call,
            event.time,
            status,
            status === 'error' ? failureText(message, data, maxErrorChars) : null,
          )
        }
        default:
          return state
      }
    },
    wire: {
      viewSchema: passthroughSchema,
      view: state => buildView(state, config.language),
      summary: false,
    },
  }
}

/**
 * Build the complete wire view from fold state.
 *
 * @param state - Current fold state.
 * @param language - Explanation language carried for the Client's fallback copy.
 * @returns A fresh whole-value view (the registry compares references).
 */
export function buildView(state: ToolUsageState, language: 'zh' | 'en'): ToolUsageView {
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
    .slice(0, MAX_WIRE_TOOL_ROWS)
  const running = state.runningOrder
    .map(callId => state.open[callId])
    .filter((call): call is ToolUsageRunningView => call !== undefined)
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
  }
}

/** Empty fold state, used by `init` and by tests. */
export function emptyState(): ToolUsageState {
  return {
    totals: { calls: 0, settled: 0, errors: 0, totalMs: 0, maxMs: 0 },
    byTool: {},
    calls: [],
    turns: [],
    turnCount: 0,
    open: {},
    runningOrder: [],
    lastEventTime: 0,
  }
}

function emptyToolState(): ToolUsageToolState {
  return { calls: 0, settled: 0, errors: 0, totalMs: 0, minMs: 0, maxMs: 0, lastMs: 0, lastAt: 0 }
}

/** Extract a one-line shell command for bash-family tools from redacted arguments. */
function shellCommand(tool: string, args: JsonValue, maxChars: number): string | null {
  if (resolveToolName(tool) !== 'bash') return null
  const record = asRecord(args)
  for (const key of ['command', 'cmd', 'script']) {
    const value = record[key]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    return clipLine(value, maxChars)
  }
  return null
}

/** Collapse whitespace and cap one display line. */
function clipLine(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Bounded best-effort failure text from a tool result. */
function failureText(message: Record<string, unknown>, data: Record<string, unknown>, maxChars: number): string {
  const failure = asRecord(data['error'])
  const reason = readString(failure, 'reason')
  const candidate = reason
    ?? contentText(message['content'])
    ?? readString(failure, 'name')
    ?? 'tool error'
  return clipLine(candidate, maxChars)
}

/** First text block of a tool result's content, if any. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const record = asRecord(block)
    if (record['type'] !== 'text') continue
    const text = readString(record, 'text')
    if (text !== undefined) return text
  }
  return undefined
}

/** Map a persisted `TurnEndReason` to the view's outcome discriminator. */
function turnOutcome(reason: unknown): ToolUsageTurnOutcome {
  const record = asRecord(reason)
  const kind = readString(record, 'kind')
  switch (kind) {
    case 'completed':
    case 'aborted':
    case 'blocked':
    case 'error':
    case 'max-tokens':
    case 'interrupted':
    case 'forked':
      return kind
    default:
      return 'completed'
  }
}

/** Increment a tracked Turn's call counter (no-op when the row left the ring). */
function addTurnCalls(turns: TurnState[], turn: number): TurnState[] {
  let changed = false
  const next = turns.map((row) => {
    if (row.turn !== turn) return row
    changed = true
    return { ...row, calls: row.calls + 1 }
  })
  return changed ? next : turns
}

/** Apply one settled call to a tracked Turn (no-op when the row left the ring). */
function addTurnTotals(turns: TurnState[], turn: number, errors: number, durationMs: number): TurnState[] {
  let changed = false
  const next = turns.map((row) => {
    if (row.turn !== turn) return row
    changed = true
    return { ...row, errors: row.errors + errors, totalMs: round1(row.totalMs + durationMs) }
  })
  return changed ? next : turns
}

/** Append to a bounded recent ring, dropping the oldest member. */
function pushBounded<T>(ring: readonly T[], value: T, limit: number): T[] {
  const next = [...ring, value]
  if (next.length <= limit) return next
  return next.slice(next.length - limit)
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
