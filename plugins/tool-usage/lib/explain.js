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
import { ELLIPSIS } from './redact.js';
const DEFAULT_MAX_VALUE_CHARS = 80;
/** Total character cap on a rendered summary (single line, ellipsis included). */
export const MAX_SUMMARY_CHARS = 2000;
/** Maximum number of retained detail lines for a `detailed` explanation. */
export const MAX_DETAIL_LINES = 50;
/** Maximum total characters across retained detail lines, including newline separators. */
export const MAX_DETAIL_CHARS = 8000;
/** Canonical tool names with a dedicated summary phrasing. */
const KNOWN_TOOLS = new Set([
    'bash',
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'web_search',
    'web_fetch',
    'read_image',
    'todo_write',
    'subagent',
    'subagent_fork',
    'workflow',
    'working_directory',
    'ask_user_question',
    'job_output',
    'job_kill',
    'job_list',
]);
/** Small, explicit alias table; intentionally does not include prefix matching. */
const TOOL_ALIASES = new Map([
    ['shell', 'bash'],
    ['read_file', 'read'],
    ['readfile', 'read'],
    ['write_file', 'write'],
    ['writefile', 'write'],
    ['edit_file', 'edit'],
    ['editfile', 'edit'],
    ['search_web', 'web_search'],
    ['websearch', 'web_search'],
    ['fetch_url', 'web_fetch'],
    ['webfetch', 'web_fetch'],
    ['todo', 'todo_write'],
    ['todos', 'todo_write'],
]);
/**
 * Explain one tool call.
 *
 * @param tool - Tool name as invoked.
 * @param args - Parsed (already redacted) arguments; any shape is accepted.
 * @param schema - Registered tool metadata, when available.
 * @param options - Language, detail level, and value cap.
 * @returns The summary plus detail lines (empty for `brief`).
 */
export function explainToolCall(tool, args, schema, options) {
    const zh = options.language !== 'en';
    const maxValueChars = positiveInteger(options.maxValueChars, DEFAULT_MAX_VALUE_CHARS);
    const name = resolveToolName(tool);
    const record = asRecord(args);
    const summary = summarize(name, record, zh, maxValueChars);
    const details = [];
    if (options.level === 'detailed') {
        const described = describeToolSchema(schema);
        if (described.description !== undefined) {
            const description = clip(described.description, maxValueChars);
            details.push(zh ? `工具说明：${description}` : `Tool description: ${description}`);
        }
        const declared = new Set();
        for (const doc of described.parameters) {
            declared.add(doc.name);
            details.push(parameterLine(doc, record[doc.name], zh, maxValueChars));
        }
        const extraKeys = Object.keys(record).filter(key => !declared.has(key)).sort();
        for (const key of extraKeys) {
            details.push(parameterLine({ name: key, required: false }, record[key], zh, maxValueChars));
        }
    }
    return { summary: capSummary(sanitizeSummary(summary)), details: capDetails(details) };
}
/**
 * Describe a registered tool schema for the `view: "explain"` tool result.
 *
 * @param schema - Registered tool metadata.
 * @returns The description (when present) and every declared parameter in schema order.
 */
export function describeToolSchema(schema) {
    if (schema === undefined || schema === null || typeof schema !== 'object') {
        return { parameters: [] };
    }
    const description = typeof schema.description === 'string' && schema.description.trim().length > 0
        ? schema.description.trim()
        : undefined;
    const parameters = parseParameterDocs(schema.parameters);
    return { ...(description === undefined ? {} : { description }), parameters };
}
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
export function resolveToolName(tool) {
    const raw = typeof tool === 'string' ? tool.trim() : '';
    if (raw.length === 0)
        return 'unknown';
    const lower = raw.toLowerCase();
    const candidate = lower.replace(/-/g, '_');
    const exact = matchKnown(candidate);
    if (exact !== undefined)
        return exact;
    const segments = lower.split(/__|[.:/\\]/).filter(segment => segment.length > 0);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment === undefined)
            continue;
        const matched = matchKnown(segment.replace(/-/g, '_'));
        if (matched !== undefined)
            return matched;
    }
    return lower;
}
function matchKnown(candidate) {
    if (KNOWN_TOOLS.has(candidate))
        return candidate;
    const alias = TOOL_ALIASES.get(candidate);
    return alias;
}
function summarize(name, args, zh, maxChars) {
    switch (name) {
        case 'bash': {
            const command = stringField(args, ['command', 'cmd', 'script']);
            if (command === undefined)
                return zh ? '执行 Shell 命令' : 'Run shell command';
            const commandText = clip(command, maxChars);
            const cwd = stringField(args, ['cwd', 'working_directory']);
            const head = zh ? `执行 Shell 命令：${commandText}` : `Run shell command: ${commandText}`;
            if (cwd === undefined)
                return head;
            return zh ? `${head}（目录 ${clip(cwd, maxChars)}）` : `${head} (cwd ${clip(cwd, maxChars)})`;
        }
        case 'read': {
            const file = stringField(args, ['file_path', 'path']);
            if (file === undefined)
                return zh ? '读取文件' : 'Read file';
            const fileText = clip(file, maxChars);
            const offset = numberField(args, ['offset']);
            const limit = numberField(args, ['limit']);
            if (limit !== undefined) {
                return zh
                    ? `读取文件 ${fileText}（第 ${offset ?? 1} 行起，最多 ${limit} 行）`
                    : `Read file ${fileText} (from line ${offset ?? 1}, up to ${limit} lines)`;
            }
            if (offset !== undefined && offset !== 1) {
                return zh ? `读取文件 ${fileText}（第 ${offset} 行起）` : `Read file ${fileText} (from line ${offset})`;
            }
            return zh ? `读取文件 ${fileText}` : `Read file ${fileText}`;
        }
        case 'write': {
            const file = stringField(args, ['file_path', 'path']);
            if (file === undefined)
                return zh ? '写入文件' : 'Write file';
            const fileText = clip(file, maxChars);
            const content = args['content'];
            const length = typeof content === 'string' ? content.length : undefined;
            if (length === undefined)
                return zh ? `写入文件 ${fileText}` : `Write file ${fileText}`;
            return zh ? `写入文件 ${fileText}（${length} 字符）` : `Write file ${fileText} (${length} chars)`;
        }
        case 'edit': {
            const file = stringField(args, ['file_path', 'path']);
            if (file === undefined)
                return zh ? '编辑文件' : 'Edit file';
            return zh ? `编辑文件 ${clip(file, maxChars)}` : `Edit file ${clip(file, maxChars)}`;
        }
        case 'glob': {
            const pattern = stringField(args, ['pattern', 'glob']);
            if (pattern === undefined)
                return zh ? '查找文件' : 'Find files';
            const path = stringField(args, ['path', 'directory', 'cwd']);
            const head = zh ? `查找文件：${clip(pattern, maxChars)}` : `Find files: ${clip(pattern, maxChars)}`;
            return path === undefined ? head : (zh ? `${head}（目录 ${clip(path, maxChars)}）` : `${head} (in ${clip(path, maxChars)})`);
        }
        case 'grep': {
            const pattern = stringField(args, ['pattern', 'query']);
            const path = stringField(args, ['path', 'directory', 'cwd']);
            const glob = stringField(args, ['glob', 'include']);
            let summary = zh ? '搜索文本' : 'Search text';
            if (pattern !== undefined)
                summary = zh ? `搜索文本：${clip(pattern, maxChars)}` : `Search text: ${clip(pattern, maxChars)}`;
            if (path !== undefined)
                summary += zh ? `（目录 ${clip(path, maxChars)}）` : ` (in ${clip(path, maxChars)})`;
            if (glob !== undefined)
                summary += zh ? `（glob ${clip(glob, maxChars)}）` : ` (glob ${clip(glob, maxChars)})`;
            return summary;
        }
        case 'web_search': {
            const queries = queriesText(args, maxChars, zh);
            if (queries === undefined)
                return zh ? '网络搜索' : 'Search the web';
            return zh ? `网络搜索：${queries}` : `Search the web: ${queries}`;
        }
        case 'web_fetch': {
            const url = stringField(args, ['url']);
            if (url === undefined)
                return zh ? '抓取网页' : 'Fetch URL';
            return zh ? `抓取网页：${clip(url, maxChars)}` : `Fetch URL: ${clip(url, maxChars)}`;
        }
        case 'read_image': {
            const path = stringField(args, ['path', 'file_path']);
            if (path === undefined)
                return zh ? '读取图片' : 'Read image';
            return zh ? `读取图片：${clip(path, maxChars)}` : `Read image: ${clip(path, maxChars)}`;
        }
        case 'todo_write': {
            const count = arrayLength(args, ['todos', 'items', 'tasks']);
            if (count === undefined)
                return zh ? '更新待办事项' : 'Update todo list';
            return zh ? `更新待办事项（${count} 项）` : `Update todo list (${count} items)`;
        }
        case 'subagent':
        case 'subagent_fork': {
            const target = stringField(args, ['description', 'prompt', 'task']);
            if (target === undefined)
                return zh ? '委派子任务' : 'Delegate subtask';
            return zh ? `委派子任务：${clip(target, maxChars)}` : `Delegate subtask: ${clip(target, maxChars)}`;
        }
        case 'workflow': {
            const workflowName = stringField(args, ['name', 'workflow']);
            if (workflowName === undefined)
                return zh ? '运行工作流' : 'Run workflow';
            return zh ? `运行工作流：${clip(workflowName, maxChars)}` : `Run workflow: ${clip(workflowName, maxChars)}`;
        }
        case 'working_directory': {
            const directory = stringField(args, ['path', 'directory', 'cwd']);
            if (directory === undefined)
                return zh ? '读取当前工作目录' : 'Read current working directory';
            return zh ? `切换工作目录到 ${clip(directory, maxChars)}` : `Change working directory to ${clip(directory, maxChars)}`;
        }
        case 'ask_user_question': {
            const questions = args['questions'];
            let count;
            if (Array.isArray(questions))
                count = questions.length;
            else if (args['question'] !== undefined || args['prompt'] !== undefined)
                count = 1;
            if (count === undefined)
                return zh ? '向用户提问' : 'Ask the user';
            return zh ? `向用户提问（${count} 个问题）` : `Ask the user (${count} questions)`;
        }
        case 'job_output': {
            const jobId = stringField(args, ['job_id', 'jobId']);
            const head = zh ? '读取后台任务输出' : 'Read background job output';
            return jobId === undefined ? head : (zh ? `${head}：${clip(jobId, maxChars)}` : `${head}: ${clip(jobId, maxChars)}`);
        }
        case 'job_kill': {
            const jobId = stringField(args, ['job_id', 'jobId']);
            const head = zh ? '结束后台任务' : 'Kill background job';
            return jobId === undefined ? head : (zh ? `${head} ${clip(jobId, maxChars)}` : `${head} ${clip(jobId, maxChars)}`);
        }
        case 'job_list':
            return zh ? '列出后台任务' : 'List background jobs';
        default: {
            const hasName = name.length > 0 && name !== 'unknown';
            const params = compactParams(args, zh, maxChars);
            if (!hasName)
                return zh ? `调用工具：${params}` : `Call tool: ${params}`;
            if (params.length === 0)
                return zh ? `调用工具 ${name}` : `Call tool ${name}`;
            return zh ? `调用工具 ${name}：${params}` : `Call tool ${name}: ${params}`;
        }
    }
}
function compactParams(args, zh, maxChars) {
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        parts.push(`${key}=${valueText(value, maxChars)}`);
    }
    return parts.join(zh ? '，' : ', ');
}
function queriesText(args, maxChars, zh) {
    const queries = args['queries'];
    if (Array.isArray(queries)) {
        const items = queries
            .filter((item) => typeof item === 'string' && item.trim().length > 0)
            .map(item => clip(item, maxChars));
        if (items.length > 0)
            return items.join(zh ? '、' : ', ');
    }
    if (typeof queries === 'string' && queries.trim().length > 0)
        return clip(queries, maxChars);
    const single = args['query'];
    if (typeof single === 'string' && single.trim().length > 0)
        return clip(single, maxChars);
    return undefined;
}
function parameterLine(doc, value, zh, maxChars) {
    const rendered = value === undefined ? (zh ? '（未提供）' : '(not provided)') : valueText(value, maxChars);
    const description = doc.description !== undefined && doc.description.length > 0
        ? clip(doc.description, maxChars)
        : (zh ? '（无说明）' : '(no description)');
    return zh
        ? `参数 ${doc.name}：${description} = ${rendered}`
        : `Parameter ${doc.name}: ${description} = ${rendered}`;
}
function parseParameterDocs(parameters) {
    const root = asRecord(parameters);
    const properties = root['properties'];
    if (!isRecord(properties))
        return [];
    const required = new Set();
    const requiredValue = root['required'];
    if (Array.isArray(requiredValue)) {
        for (const item of requiredValue) {
            if (typeof item === 'string')
                required.add(item);
        }
    }
    const docs = [];
    for (const [name, rawNode] of Object.entries(properties)) {
        const node = asRecord(rawNode);
        const type = schemaType(node);
        const description = typeof node['description'] === 'string' && node['description'].trim().length > 0
            ? node['description'].trim()
            : undefined;
        docs.push({
            name,
            required: required.has(name),
            ...(type === undefined ? {} : { type }),
            ...(description === undefined ? {} : { description }),
        });
    }
    return docs;
}
function schemaType(node) {
    if (typeof node['type'] === 'string')
        return node['type'];
    if (Array.isArray(node['enum']))
        return 'enum';
    if (Array.isArray(node['oneOf']))
        return 'union';
    if (Array.isArray(node['anyOf']))
        return 'union';
    return undefined;
}
function stringField(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
function numberField(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
function arrayLength(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (Array.isArray(value))
            return value.length;
    }
    return undefined;
}
function valueText(value, maxChars) {
    if (typeof value === 'string')
        return clip(value, maxChars);
    try {
        const serialized = JSON.stringify(value);
        if (serialized !== undefined)
            return clip(serialized, maxChars);
    }
    catch {
        // Circular or otherwise unserializable value: fall through to String().
    }
    return clip(String(value), maxChars);
}
function clip(value, maxChars) {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (flat.length <= maxChars)
        return flat;
    return `${flat.slice(0, Math.max(0, maxChars - 1))}${ELLIPSIS}`;
}
function sanitizeSummary(summary) {
    return summary.replace(/\s+/g, ' ').trim();
}
/** Enforce {@link MAX_SUMMARY_CHARS} on an already single-line summary. */
function capSummary(summary) {
    if (summary.length <= MAX_SUMMARY_CHARS)
        return summary;
    return `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}${ELLIPSIS}`;
}
/**
 * Enforce {@link MAX_DETAIL_LINES} and {@link MAX_DETAIL_CHARS}: lines are kept in
 * order until either budget is exhausted; later lines are dropped.
 */
function capDetails(lines) {
    const kept = [];
    let totalChars = 0;
    for (const line of lines) {
        if (kept.length >= MAX_DETAIL_LINES)
            break;
        const nextTotal = totalChars + line.length + (kept.length === 0 ? 0 : 1);
        if (nextTotal > MAX_DETAIL_CHARS)
            break;
        kept.push(line);
        totalChars = nextTotal;
    }
    return kept;
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveInteger(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const truncated = Math.trunc(value);
    return truncated >= 1 ? truncated : 1;
}
