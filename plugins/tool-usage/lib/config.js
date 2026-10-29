/**
 * Hand-rolled configuration normalization.
 *
 * The plugin deliberately carries no Schemastery (or other) runtime dependency,
 * so raw Cordis config is `unknown` and is normalized here. Invalid values never
 * fail the load: each one is replaced by its default and reported once through
 * `ctx.logger.warn`.
 *
 * @module tool-usage/config
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { SENSITIVE_KEYS } from './redact.js';
/** Default directory template, expanded against the running DSH home. */
export const DEFAULT_OUTPUT_DIR = '$DSH_HOME/tool-usage';
/** Default model-facing tool name. */
export const DEFAULT_TOOL_NAME = 'tool_usage';
/** Default slash-command name. */
export const DEFAULT_COMMAND_NAME = 'tool-usage';
const DEFAULT_CONFIG = {
    enabled: true,
    persistCalls: true,
    persistStats: true,
    restoreStats: true,
    explain: 'detailed',
    language: 'zh',
    maxParamChars: 500,
    maxStringChars: 200,
    recentLimit: 200,
    slowThresholdMs: 5000,
    toolName: DEFAULT_TOOL_NAME,
    commandName: DEFAULT_COMMAND_NAME,
    statsWriteDebounceMs: 2000,
    includeParamsInReport: true,
};
/**
 * Resolve the DSH home directory from the environment.
 *
 * @param env - Process environment.
 * @returns The trimmed `DSH_HOME`, else `<home>/.dsh`, as an absolute path.
 */
export function resolveDshHome(env = process.env) {
    const configured = env['DSH_HOME']?.trim();
    const home = configured !== undefined && configured.length > 0
        ? configured
        : path.join(os.homedir(), '.dsh');
    return path.isAbsolute(home) ? path.normalize(home) : path.resolve(home);
}
/**
 * Expand `~` and `$DSH_HOME` prefixes and make the result absolute.
 *
 * `''` (or whitespace-only) means "do not persist" and stays empty.
 *
 * @param input - Configured output directory template.
 * @param env - Process environment used for `$DSH_HOME`.
 * @returns An absolute normalized path, or `''`.
 */
export function resolveOutputDir(input, env = process.env) {
    const trimmed = input.trim();
    if (trimmed.length === 0)
        return '';
    const dshHome = resolveDshHome(env);
    let expanded = trimmed;
    if (expanded === '~') {
        expanded = os.homedir();
    }
    else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
        expanded = path.join(os.homedir(), expanded.slice(2));
    }
    else if (expanded === '$DSH_HOME' || expanded === '${DSH_HOME}') {
        expanded = dshHome;
    }
    else if (expanded.startsWith('$DSH_HOME/') || expanded.startsWith('$DSH_HOME\\')) {
        expanded = path.join(dshHome, expanded.slice('$DSH_HOME'.length + 1));
    }
    else if (expanded.startsWith('${DSH_HOME}/') || expanded.startsWith('${DSH_HOME}\\')) {
        expanded = path.join(dshHome, expanded.slice('${DSH_HOME}'.length + 1));
    }
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
}
/**
 * Normalize raw plugin config, tolerating unknown keys and invalid values.
 *
 * @param rawConfig - Raw Cordis config (usually a plain object, `undefined` when omitted).
 * @param options - Optional logger and environment override.
 * @returns A fully populated {@link ToolUsageConfig}.
 */
export function resolveConfig(rawConfig, options = {}) {
    const logger = options.logger;
    const env = options.env ?? process.env;
    const warn = (message) => {
        logger?.warn(`tool-usage: ${message}`);
    };
    let raw = {};
    if (rawConfig === undefined || rawConfig === null) {
        raw = {};
    }
    else if (isRecord(rawConfig)) {
        raw = rawConfig;
    }
    else {
        warn('config must be an object; falling back to defaults');
    }
    const enabled = readBoolean(raw, 'enabled', DEFAULT_CONFIG.enabled, warn);
    const outputDirRaw = readString(raw, 'outputDir', DEFAULT_OUTPUT_DIR, warn);
    let persistCalls = readBoolean(raw, 'persistCalls', DEFAULT_CONFIG.persistCalls, warn);
    let persistStats = readBoolean(raw, 'persistStats', DEFAULT_CONFIG.persistStats, warn);
    const restoreStats = readBoolean(raw, 'restoreStats', DEFAULT_CONFIG.restoreStats, warn);
    const outputDir = resolveOutputDir(outputDirRaw, env);
    if (outputDir.length === 0) {
        // An explicitly empty outputDir disables both persistence flags.
        persistCalls = false;
        persistStats = false;
    }
    return {
        enabled,
        outputDir,
        persistCalls,
        persistStats,
        restoreStats,
        explain: readEnum(raw, 'explain', ['off', 'brief', 'detailed'], DEFAULT_CONFIG.explain, warn),
        language: readEnum(raw, 'language', ['zh', 'en'], DEFAULT_CONFIG.language, warn),
        maxParamChars: readInteger(raw, 'maxParamChars', DEFAULT_CONFIG.maxParamChars, 1, 10_000_000, warn),
        maxStringChars: readInteger(raw, 'maxStringChars', DEFAULT_CONFIG.maxStringChars, 1, 1_000_000, warn),
        redactKeys: readRedactKeys(raw, warn),
        recentLimit: readInteger(raw, 'recentLimit', DEFAULT_CONFIG.recentLimit, 1, 1_000_000, warn),
        slowThresholdMs: readInteger(raw, 'slowThresholdMs', DEFAULT_CONFIG.slowThresholdMs, 0, 86_400_000, warn),
        toolName: readIdentifier(raw, 'toolName', DEFAULT_CONFIG.toolName, warn),
        commandName: readCommandName(raw, warn),
        statsWriteDebounceMs: readInteger(raw, 'statsWriteDebounceMs', DEFAULT_CONFIG.statsWriteDebounceMs, 0, 3_600_000, warn),
        includeParamsInReport: readBoolean(raw, 'includeParamsInReport', DEFAULT_CONFIG.includeParamsInReport, warn),
    };
}
function readRedactKeys(raw, warn) {
    const value = raw['redactKeys'];
    if (value === undefined)
        return Object.freeze([...SENSITIVE_KEYS]);
    if (!Array.isArray(value)) {
        warn('redactKeys must be an array of strings; using the built-in sensitive key list');
        return Object.freeze([...SENSITIVE_KEYS]);
    }
    const keys = new Set(SENSITIVE_KEYS);
    for (const item of value) {
        if (typeof item === 'string' && item.trim().length > 0)
            keys.add(item.trim());
    }
    return Object.freeze([...keys]);
}
function readBoolean(raw, key, fallback, warn) {
    const value = raw[key];
    if (value === undefined)
        return fallback;
    if (typeof value === 'boolean')
        return value;
    warn(`${key} must be a boolean; using ${fallback}`);
    return fallback;
}
function readString(raw, key, fallback, warn) {
    const value = raw[key];
    if (value === undefined)
        return fallback;
    if (typeof value === 'string')
        return value;
    warn(`${key} must be a string; using ${JSON.stringify(fallback)}`);
    return fallback;
}
function readIdentifier(raw, key, fallback, warn) {
    const value = readString(raw, key, fallback, warn);
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        warn(`${key} must not be empty; using ${JSON.stringify(fallback)}`);
        return fallback;
    }
    return trimmed;
}
/** Command names accepted by the commands registry. */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
function readCommandName(raw, warn) {
    const value = readString(raw, 'commandName', DEFAULT_CONFIG.commandName, warn);
    const normalized = value.trim().replace(/^\/+/, '').toLowerCase();
    if (!COMMAND_NAME_PATTERN.test(normalized)) {
        warn(`commandName must match ${String(COMMAND_NAME_PATTERN)}; using ${JSON.stringify(DEFAULT_CONFIG.commandName)}`);
        return DEFAULT_CONFIG.commandName;
    }
    return normalized;
}
function readInteger(raw, key, fallback, min, max, warn) {
    const value = raw[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        warn(`${key} must be a finite number; using ${fallback}`);
        return fallback;
    }
    const truncated = Math.trunc(value);
    if (truncated < min || truncated > max) {
        const clamped = Math.min(max, Math.max(min, truncated));
        warn(`${key} must be between ${min} and ${max}; using ${clamped}`);
        return clamped;
    }
    return truncated;
}
function readEnum(raw, key, allowed, fallback, warn) {
    const value = raw[key];
    if (value === undefined)
        return fallback;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        for (const candidate of allowed) {
            if (candidate === normalized)
                return candidate;
        }
    }
    warn(`${key} must be one of ${allowed.join(' | ')}; using ${fallback}`);
    return fallback;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
