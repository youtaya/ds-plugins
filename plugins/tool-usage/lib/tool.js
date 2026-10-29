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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { describeToolSchema } from './explain.js';
/** Default number of recent calls returned by the tool. */
export const DEFAULT_TOOL_LIMIT = 20;
/** Hard bounds for the `limit` parameter. */
export const MIN_TOOL_LIMIT = 1;
export const MAX_TOOL_LIMIT = 100;
/**
 * Build the model-facing tool definition.
 *
 * @param deps - Stats store, resolved config, and schema lookup.
 * @returns A registry-ready tool definition (read-only/concurrency-safe).
 */
export function createToolUsageTool(deps) {
    const language = deps.config.language;
    return defineTool({
        name: deps.config.toolName,
        description: language === 'en'
            ? 'Show tool-call statistics for the current session or all sessions, list recent calls, or explain a registered tool and its parameters.'
            : '查看当前会话或全部会话的工具调用统计、最近调用记录，或解释一个已注册工具及其参数。',
        parameters: {
            view: {
                type: 'string',
                enum: ['summary', 'tools', 'recent', 'explain'],
                description: 'Report to show. "summary" = totals + tools + recent (default), "tools" = per-tool aggregates only, "recent" = recent calls only, "explain" = describe the tool named by the "tool" parameter.',
            },
            tool: {
                type: 'string',
                description: 'Tool name. Required for view="explain"; for the other views it filters the tools table and recent calls.',
            },
            scope: {
                type: 'string',
                enum: ['session', 'all'],
                description: 'Statistics scope: the calling session (default) or all sessions.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum number of recent calls, 1-100. Default 20.',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (args, value) => {
                const view = args.view ?? 'summary';
                const text = view === 'explain'
                    ? renderExplainMarkdown(value, language)
                    : renderSnapshotMarkdown(value, language, view);
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const view = args.view ?? 'summary';
            const limit = clampLimit(args.limit);
            if (view === 'explain') {
                const target = typeof args.tool === 'string' ? args.tool.trim() : '';
                if (target.length === 0) {
                    throw new Error('tool_usage: the "tool" parameter is required for view="explain"');
                }
                const schema = lookupSchema(deps, target, exec.agent);
                if (schema === undefined) {
                    throw new Error(`tool_usage: tool "${target}" is not registered`);
                }
                return buildExplainResult(target, schema);
            }
            const sessionId = sessionIdOf(exec.agent);
            const scope = args.scope === 'all' ? 'all' : 'session';
            const snapshot = deps.stats.snapshot({
                scope: scope === 'all' ? 'all' : 'current',
                ...(sessionId === undefined ? {} : { sessionId }),
                limit,
                includeParams: deps.config.includeParamsInReport,
                includeExplanations: true,
            });
            const filter = typeof args.tool === 'string' && args.tool.trim().length > 0 ? args.tool.trim() : undefined;
            const output = filter === undefined
                ? snapshot
                : {
                    ...snapshot,
                    tools: snapshot.tools.filter(tool => tool.name === filter),
                    recent: snapshot.recent.filter(call => call.tool === filter),
                };
            return output;
        },
    });
}
function buildExplainResult(tool, schema) {
    const described = describeToolSchema(schema);
    return {
        tool,
        ...(described.description === undefined ? {} : { description: described.description }),
        parameters: described.parameters.map(doc => ({
            name: doc.name,
            required: doc.required,
            ...(doc.type === undefined ? {} : { type: doc.type }),
            ...(doc.description === undefined ? {} : { description: doc.description }),
        })),
    };
}
function lookupSchema(deps, tool, agent) {
    try {
        return deps.resolveToolSchema(tool, agent);
    }
    catch {
        return undefined;
    }
}
function sessionIdOf(agent) {
    if (typeof agent !== 'object' || agent === null)
        return undefined;
    const id = agent.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
}
function clampLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return DEFAULT_TOOL_LIMIT;
    return Math.min(MAX_TOOL_LIMIT, Math.max(MIN_TOOL_LIMIT, Math.trunc(value)));
}
/**
 * Render a usage snapshot as compact Markdown.
 *
 * @param snapshot - Canonical snapshot returned by the tool/command.
 * @param language - Output language.
 * @param view - Which sections to include.
 * @returns Markdown text.
 */
export function renderSnapshotMarkdown(snapshot, language, view = 'summary') {
    const zh = language !== 'en';
    const lines = [];
    const scopeText = snapshot.scope.kind === 'all'
        ? (zh ? '全部会话' : 'all sessions')
        : (zh ? '当前会话' : 'current session');
    lines.push(zh ? `工具调用统计（范围：${scopeText}）` : `Tool call statistics (scope: ${scopeText})`);
    lines.push('');
    const totals = snapshot.totals;
    lines.push(zh
        ? `总计 ${totals.calls} 次调用 / ${totals.errors} 次失败 / 总耗时 ${formatDuration(totals.totalMs)} / 平均 ${formatDuration(totals.avgMs)} / 最慢 ${formatDuration(totals.maxMs)}`
        : `Totals: ${totals.calls} calls / ${totals.errors} failed / ${formatDuration(totals.totalMs)} total / ${formatDuration(totals.avgMs)} avg / ${formatDuration(totals.maxMs)} slowest`);
    if (totals.calls === 0) {
        lines.push('');
        lines.push(zh ? '（尚无记录）' : '(no calls recorded yet)');
        return lines.join('\n');
    }
    if (view !== 'recent') {
        lines.push('');
        lines.push(...renderToolsTable(snapshot.tools, zh));
    }
    if (view !== 'tools') {
        lines.push('');
        lines.push(...renderRecentCalls(snapshot.recent, zh));
    }
    return lines.join('\n');
}
/**
 * Render the `view: "explain"` JSON value as compact Markdown.
 *
 * @param result - Registered tool description + parameter table.
 * @param language - Output language.
 * @returns Markdown text.
 */
export function renderExplainMarkdown(result, language) {
    const zh = language !== 'en';
    const lines = [zh ? `工具：${result.tool}` : `Tool: ${result.tool}`];
    if (result.description !== undefined && result.description.length > 0) {
        lines.push(zh ? `说明：${result.description}` : `Description: ${result.description}`);
    }
    lines.push('');
    if (result.parameters.length === 0) {
        lines.push(zh ? '（该工具没有声明参数）' : '(this tool declares no parameters)');
        return lines.join('\n');
    }
    lines.push(zh ? '| 参数 | 类型 | 必填 | 说明 |' : '| Parameter | Type | Required | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const parameter of result.parameters) {
        const required = parameter.required ? (zh ? '是' : 'yes') : (zh ? '否' : 'no');
        lines.push(`| ${escapeCell(parameter.name)} | ${escapeCell(parameter.type ?? '-')} | ${required} | ${escapeCell(parameter.description ?? '-')} |`);
    }
    return lines.join('\n');
}
function renderToolsTable(tools, zh) {
    const header = zh
        ? '| 工具 | 次数 | 失败 | 平均 | 最慢 | 最近 |'
        : '| Tool | Calls | Errors | Avg | Slowest | Last |';
    const separator = '| --- | --- | --- | --- | --- | --- |';
    const rows = tools.map(tool => `| ${escapeCell(tool.name)} | ${tool.calls} | ${tool.errors} | ${formatDuration(tool.avgMs)} | ${formatDuration(tool.maxMs)} | ${formatTime(tool.lastAt)} |`);
    if (rows.length === 0) {
        rows.push(zh ? '| （无） | - | - | - | - | - |' : '| (none) | - | - | - | - | - |');
    }
    return [header, separator, ...rows];
}
function renderRecentCalls(recent, zh) {
    const lines = [zh ? '最近调用：' : 'Recent calls:'];
    if (recent.length === 0) {
        lines.push(zh ? '（无）' : '(none)');
        return lines;
    }
    recent.forEach((call, index) => {
        const summary = call.explanation?.summary ?? '';
        const head = `${index + 1}. [${formatTime(call.at)}] ${call.tool}`;
        const explanation = summary.length > 0 ? ` — ${summary}` : '';
        const duration = formatDuration(call.durationMs);
        const status = statusSuffix(call.status, zh);
        lines.push(zh
            ? `${head}${explanation}（${duration}${status}）`
            : `${head}${explanation} (${duration}${status})`);
    });
    return lines;
}
function statusSuffix(status, zh) {
    if (status === 'ok')
        return '';
    if (status === 'aborted')
        return zh ? '，已取消' : ', aborted';
    if (status === 'threw')
        return zh ? '，异常' : ', threw';
    return zh ? '，失败' : ', failed';
}
function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
        return '0ms';
    if (milliseconds >= 1000) {
        const seconds = Math.round((milliseconds / 1000) * 10) / 10;
        return `${seconds}s`;
    }
    if (milliseconds >= 10)
        return `${Math.round(milliseconds)}ms`;
    return `${Math.round(milliseconds * 10) / 10}ms`;
}
function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '--:--:--';
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}
function escapeCell(value) {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
