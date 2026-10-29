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
import { createCommand } from './command.js';
import { resolveConfig } from './config.js';
import { JsonlCallLog } from './log.js';
import { createToolUsageProjectionDefinition } from './projection.js';
import { ToolUsageRecorder } from './recorder.js';
import { StatsStore } from './stats.js';
import { createToolUsageTool } from './tool.js';
/** Cordis plugin name used by loader diagnostics and logger naming. */
export const name = 'tool-usage';
/** The recorder only needs the tool registry; `commands` is injected optionally. */
export const inject = ['tools'];
/**
 * Plugin entry point.
 *
 * @param ctx - Plugin-scoped Cordis context.
 * @param rawConfig - Unvalidated Cordis config; normalized by `resolveConfig`.
 */
export function apply(ctx, rawConfig) {
    const logger = ctx.logger;
    const config = resolveConfig(rawConfig, { logger });
    if (!config.enabled) {
        logger.info('tool-usage: disabled by config; no tool calls will be recorded');
        return;
    }
    const stats = new StatsStore({
        recentLimit: config.recentLimit,
        slowThresholdMs: config.slowThresholdMs,
    });
    const log = new JsonlCallLog({
        directory: config.outputDir,
        persistCalls: config.persistCalls,
        persistStats: config.persistStats,
        debounceMs: config.statsWriteDebounceMs,
        logger,
    });
    /** Safe registered-schema lookup; never throws into the recorder or the tool. */
    const resolveToolSchema = (toolName, agent) => {
        try {
            const definition = ctx.tools.get(toolName, agent);
            if (definition === undefined)
                return undefined;
            return { description: definition.description, parameters: definition.parameters };
        }
        catch (error) {
            logger.debug(`tool-usage: failed to look up a tool schema: ${describeError(error)}`);
            return undefined;
        }
    };
    const recorder = new ToolUsageRecorder({
        stats,
        log,
        config,
        logger,
        resolveToolSchema,
    });
    // Restore aggregates without blocking plugin load. `StatsStore.restore` merges the
    // snapshot into the live store, so a call recorded while this read is in flight is
    // kept in both the aggregates and the recent-calls ring; failures only warn.
    if (config.restoreStats && config.persistStats) {
        void log.restoreStats()
            .then((restored) => {
            if (restored === undefined)
                return;
            try {
                stats.restore(restored);
                // Persist the merged view: a snapshot scheduled while the read was in
                // flight must not overwrite restored history with the live-only counts.
                log.scheduleStats(stats.toJSON());
                logger.debug('tool-usage: restored persisted statistics');
            }
            catch (error) {
                logger.warn(`tool-usage: failed to restore persisted statistics: ${describeError(error)}`);
            }
        })
            .catch((error) => {
            logger.warn(`tool-usage: failed to restore persisted statistics: ${describeError(error)}`);
        });
    }
    ctx.on('tools/execute', (exec, next) => recorder.wrap(exec, next));
    ctx.effect(() => {
        try {
            return ctx.tools.register(createToolUsageTool({ stats, config, resolveToolSchema }));
        }
        catch (error) {
            logger.warn(`tool-usage: failed to register the ${config.toolName} tool: ${describeError(error)}`);
            return () => { };
        }
    });
    // Optional human command: nested injection keeps headless profiles loadable.
    ctx.effect(() => {
        let fiber;
        try {
            fiber = ctx.inject(['commands'], (scope) => {
                try {
                    const disposeCommand = scope.commands.register(createCommand({ stats, config, log }));
                    return () => disposeCommand();
                }
                catch (error) {
                    scope.logger.warn(`tool-usage: failed to register the /${config.commandName} command: ${describeError(error)}`);
                    return () => { };
                }
            });
        }
        catch (error) {
            logger.warn(`tool-usage: failed to register the /${config.commandName} command: ${describeError(error)}`);
            return () => { };
        }
        // Return an async cleanup so Cordis awaits the nested fiber's disposal; starting
        // it fire-and-forget could let the old command registration overlap a hot reload.
        return async () => {
            try {
                await fiber?.dispose?.();
            }
            catch (error) {
                logger.warn(`tool-usage: failed to dispose the /${config.commandName} command: ${describeError(error)}`);
            }
        };
    });
    // Optional Web UI data: a session projection carrying live call state to the
    // browser (`toolUsage`). Nested optional injection keeps every profile that
    // lacks the projection registry loadable. The registry's typed surface is
    // consumed structurally here so the plugin keeps zero runtime dependencies.
    if (config.uiEnabled) {
        ctx.effect(() => {
            let fiber;
            try {
                fiber = injectSessionProjections(ctx, (scope) => {
                    try {
                        const registration = scope.sessionProjections.register(createToolUsageProjectionDefinition(config));
                        return () => {
                            void Promise.resolve(registration)
                                .then(handle => handle.dispose())
                                .catch((error) => {
                                logger.warn(`tool-usage: failed to release the toolUsage projection: ${describeError(error)}`);
                            });
                        };
                    }
                    catch (error) {
                        scope.logger.warn(`tool-usage: failed to register the toolUsage projection: ${describeError(error)}`);
                        return () => { };
                    }
                });
            }
            catch (error) {
                logger.warn(`tool-usage: failed to register the toolUsage projection: ${describeError(error)}`);
                return () => { };
            }
            return async () => {
                try {
                    await fiber?.dispose?.();
                }
                catch (error) {
                    logger.warn(`tool-usage: failed to dispose the toolUsage projection: ${describeError(error)}`);
                }
            };
        });
    }
    // Final flush: pending JSONL appends and the last statistics snapshot.
    ctx.effect(() => () => recorder.dispose());
}
/**
 * Inject the optional `sessionProjections` service through a structural cast.
 * Cordis resolves the service by name; the type system only lacks the optional
 * service's augmented key when the DSH package is not imported.
 */
function injectSessionProjections(ctx, callback) {
    const inject = ctx.inject;
    return inject.call(ctx, ['sessionProjections'], callback);
}
/** Render a diagnostic error without relying on the host logger's placeholder formatting. */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
