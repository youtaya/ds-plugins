/**
 * Optional human `/tool-usage` slash command.
 *
 * Registration is optional: the plugin entry injects `commands` through a nested
 * `ctx.inject`, so a headless profile without the command runtime still loads.
 * The command renders the same Markdown as the model-facing tool.
 *
 * @module tool-usage/command
 */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ToolUsageConfig } from './config.js';
import type { JsonlCallLog } from './log.js';
import type { StatsStore } from './stats.js';
/** Dependencies of {@link createCommand}. */
export interface ToolUsageCommandDeps {
    stats: StatsStore;
    config: ToolUsageConfig;
    /** Optional persistence hook: `reset` rewrites the aggregate snapshot when present. */
    log?: Pick<JsonlCallLog, 'scheduleStats'>;
}
/**
 * Build the `/tool-usage` command definition.
 *
 * @param deps - Stats store and resolved config.
 * @returns A registry-ready command definition.
 */
export declare function createCommand(deps: ToolUsageCommandDeps): CommandDefinition;
