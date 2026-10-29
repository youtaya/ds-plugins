/**
 * Optional human `/tool-usage` slash command.
 *
 * Registration is optional: the plugin entry injects `commands` through a nested
 * `ctx.inject`, so a headless profile without the command runtime still loads.
 * The command renders the same Markdown as the model-facing tool.
 *
 * @module tool-usage/command
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ToolUsageConfig } from './config.js'
import type { JsonlCallLog } from './log.js'
import type { StatsStore } from './stats.js'
import { renderSnapshotMarkdown } from './tool.js'
import type { ToolView } from './tool.js'

/** Dependencies of {@link createCommand}. */
export interface ToolUsageCommandDeps {
  stats: StatsStore
  config: ToolUsageConfig
  /** Optional persistence hook: `reset` rewrites the aggregate snapshot when present. */
  log?: Pick<JsonlCallLog, 'scheduleStats'>
}

const DEFAULT_RECENT_LIMIT = 10
const MIN_RECENT_LIMIT = 1
const MAX_RECENT_LIMIT = 100
const RECENT_PATTERN = /^recent(?:\s+(\d+))?$/i

/**
 * Build the `/tool-usage` command definition.
 *
 * @param deps - Stats store and resolved config.
 * @returns A registry-ready command definition.
 */
export function createCommand(deps: ToolUsageCommandDeps): CommandDefinition {
  const zh = deps.config.language !== 'en'
  return {
    name: deps.config.commandName,
    description: zh ? '查看工具调用统计与最近调用记录' : 'Show tool-call statistics and recent calls',
    handler: (invocation: CommandInvocation): CommandResult => handleCommand(deps, invocation),
  }
}

function handleCommand(deps: ToolUsageCommandDeps, invocation: CommandInvocation): CommandResult {
  const zh = deps.config.language !== 'en'
  const usage = zh
    ? `用法：/${deps.config.commandName} [all|recent [N]|reset]`
    : `Usage: /${deps.config.commandName} [all|recent [N]|reset]`
  const input = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  const sessionId = sessionIdOf(invocation.agent)

  if (input === '') {
    return { kind: 'success', text: snapshotText(deps, 'current', sessionId, DEFAULT_RECENT_LIMIT, 'summary') }
  }
  if (input.toLowerCase() === 'all') {
    return { kind: 'success', text: snapshotText(deps, 'all', undefined, DEFAULT_RECENT_LIMIT, 'summary') }
  }

  const recentMatch = RECENT_PATTERN.exec(input)
  if (recentMatch !== null) {
    const parsed = recentMatch[1] === undefined ? DEFAULT_RECENT_LIMIT : Number.parseInt(recentMatch[1], 10)
    const limit = Number.isFinite(parsed)
      ? Math.min(MAX_RECENT_LIMIT, Math.max(MIN_RECENT_LIMIT, Math.trunc(parsed)))
      : DEFAULT_RECENT_LIMIT
    return { kind: 'success', text: snapshotText(deps, 'current', sessionId, limit, 'recent') }
  }

  if (input.toLowerCase() === 'reset') {
    deps.stats.reset('all')
    // Rewrite the aggregate snapshot from the cleared state so a restart does not
    // bring the pre-reset counts back (a pending debounced snapshot is replaced too).
    // The append-only JSONL log is intentionally left untouched.
    deps.log?.scheduleStats(deps.stats.toJSON())
    const persisted = deps.log !== undefined && deps.config.persistStats
    return {
      kind: 'success',
      text: zh
        ? `已重置工具调用统计${persisted ? '并重写聚合快照' : ''}（已写出的 JSONL 调用日志不受影响）`
        : `Cleared tool-call statistics${persisted ? ' and rewrote the aggregate snapshot' : ''} (the persisted JSONL call log is untouched)`,
    }
  }

  return { kind: 'error', text: usage }
}

function snapshotText(
  deps: ToolUsageCommandDeps,
  scope: 'current' | 'all',
  sessionId: string | undefined,
  limit: number,
  view: ToolView,
): string {
  const snapshot = deps.stats.snapshot({
    scope,
    ...(sessionId === undefined ? {} : { sessionId }),
    limit,
    includeParams: deps.config.includeParamsInReport,
    includeExplanations: true,
  })
  return renderSnapshotMarkdown(snapshot, deps.config.language, view)
}

function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}
