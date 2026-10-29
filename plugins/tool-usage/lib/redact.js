/**
 * Pure argument redaction and truncation.
 *
 * The recorder never stores raw tool arguments. This module walks arbitrary
 * `unknown` input and produces a plain lossless-JSON value that is safe to write
 * to disk and to render back to a model:
 *
 * - sensitive object keys become `"[REDACTED]"`;
 * - over-long strings are cut to `maxStringChars - 1` characters plus `"…"`;
 * - arrays over `maxArrayItems` are cut with a trailing item count;
 * - nesting deeper than `maxDepth` becomes `"[deep]"`;
 * - every non-JSON input (`undefined`, function, symbol, class instance, circular)
 *   becomes `"[unserializable]"`, while `bigint` becomes a decimal string.
 *
 * The walker is defensive for arbitrary plain data: no value shape above can make it
 * throw. Reading an exotic object (a `Proxy` trap or a throwing getter) can still
 * throw; callers such as the recorder treat that as a recording failure and swallow
 * it, so it never reaches the tool call.
 *
 * Redaction matches object **keys** only. Structural pair/array shapes are a
 * documented limitation: `headers: [["Authorization", "Bearer ..."]]` and
 * `env: ["API_KEY=..."]` keep their string contents (only object keys are
 * inspected), as does secret text embedded in a value.
 *
 * @module tool-usage/redact
 */
/** Placeholder for a redacted sensitive value. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';
/** Placeholder for a value that has no lossless JSON representation. */
export const UNSERIALIZABLE_PLACEHOLDER = '[unserializable]';
/** Placeholder for a value below the configured depth limit. */
export const DEEP_PLACEHOLDER = '[deep]';
/** Appended when a string is truncated. */
export const ELLIPSIS = '…';
/**
 * Key stems that are redacted by default. Matching is case-insensitive and
 * ignores `-`, `_`, `.`, and whitespace, so `api_key`, `apiKey`, `API-KEY`,
 * `api.key`, and `"api key"` all match `apikey`.
 */
export const SENSITIVE_KEYS = Object.freeze([
    'token',
    'password',
    'passwd',
    'secret',
    'apikey',
    'authorization',
    'cookie',
    'credential',
    'privatekey',
    'accesskey',
    'secretkey',
    'clientsecret',
    'sessiontoken',
]);
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ARRAY_ITEMS = 50;
const DEFAULT_MAX_STRING_CHARS = 200;
/**
 * Redact and truncate one tool-argument value.
 *
 * @param args - Arbitrary parsed tool arguments; any shape is accepted.
 * @param options - String/array/depth limits and sensitive key stems.
 * @returns The JSON-safe value plus `redacted` / `truncated` flags.
 */
export function redactArgs(args, options) {
    const maxStringChars = positiveInteger(options.maxStringChars, DEFAULT_MAX_STRING_CHARS);
    const maxDepth = nonNegativeInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
    const maxArrayItems = nonNegativeInteger(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS);
    const sensitiveKeys = normalizeKeyList(options.redactKeys);
    const state = { redacted: false, truncated: false };
    const ancestors = new WeakSet();
    const walk = (value, depth) => {
        if (depth > maxDepth) {
            state.truncated = true;
            return DEEP_PLACEHOLDER;
        }
        switch (typeof value) {
            case 'string':
                return truncateString(value, maxStringChars, state);
            case 'boolean':
                return value;
            case 'number':
                // NaN and ±Infinity have no JSON representation.
                return Number.isFinite(value) ? value : UNSERIALIZABLE_PLACEHOLDER;
            case 'bigint':
                return value.toString();
            case 'undefined':
            case 'function':
            case 'symbol':
                return UNSERIALIZABLE_PLACEHOLDER;
            case 'object': {
                if (value === null)
                    return null;
                if (ancestors.has(value))
                    return UNSERIALIZABLE_PLACEHOLDER;
                if (Array.isArray(value)) {
                    ancestors.add(value);
                    const result = walkArray(value, depth, maxArrayItems, state, walk);
                    ancestors.delete(value);
                    return result;
                }
                if (!isPlainObject(value))
                    return UNSERIALIZABLE_PLACEHOLDER;
                ancestors.add(value);
                const result = walkObject(value, depth, sensitiveKeys, state, walk);
                ancestors.delete(value);
                return result;
            }
            default:
                return UNSERIALIZABLE_PLACEHOLDER;
        }
    };
    return {
        value: walk(args, 0),
        redacted: state.redacted,
        truncated: state.truncated,
    };
}
/**
 * Normalize one object key for sensitive-stem matching.
 *
 * @param key - Raw object key.
 * @returns Lowercase key with `-`, `_`, `.`, and whitespace removed.
 */
export function normalizeKey(key) {
    return key.toLowerCase().replace(/[-_.\s]/gu, '');
}
/**
 * Test whether a key stem is sensitive under the configured rules.
 *
 * @param key - Raw object key.
 * @param normalizedKeys - Normalized sensitive stems.
 * @returns `true` when the normalized key contains a configured stem.
 */
export function isSensitiveKey(key, normalizedKeys) {
    if (normalizedKeys.length === 0)
        return false;
    const normalized = normalizeKey(key);
    if (normalized.length === 0)
        return false;
    return normalizedKeys.some(stem => stem.length > 0 && normalized.includes(stem));
}
function walkArray(value, depth, maxArrayItems, state, walk) {
    const result = [];
    const retained = Math.min(value.length, maxArrayItems);
    for (let index = 0; index < retained; index += 1) {
        result.push(walk(value[index], depth + 1));
    }
    const dropped = value.length - retained;
    if (dropped > 0) {
        state.truncated = true;
        result.push(`[… ${dropped} more items]`);
    }
    return result;
}
function walkObject(value, depth, sensitiveKeys, state, walk) {
    const source = value;
    const result = {};
    for (const key of Object.keys(source)) {
        const redact = isSensitiveKey(key, sensitiveKeys);
        if (redact)
            state.redacted = true;
        const projected = redact ? REDACTED_PLACEHOLDER : walk(source[key], depth + 1);
        // Define an own data property instead of assigning: a plain `result['__proto__'] = x`
        // would invoke the prototype setter, dropping the key and mutating the result's
        // prototype. defineProperty preserves `__proto__` as ordinary JSON data.
        Object.defineProperty(result, key, {
            value: projected,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return result;
}
function truncateString(value, maxStringChars, state) {
    if (value.length <= maxStringChars)
        return value;
    state.truncated = true;
    const keep = Math.max(0, maxStringChars - 1);
    return `${value.slice(0, keep)}${ELLIPSIS}`;
}
function normalizeKeyList(redactKeys) {
    if (!Array.isArray(redactKeys))
        return [];
    const normalized = new Set();
    for (const key of redactKeys) {
        if (typeof key !== 'string')
            continue;
        const value = normalizeKey(key.trim());
        if (value.length > 0)
            normalized.add(value);
    }
    return [...normalized];
}
function isPlainObject(value) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function positiveInteger(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const truncated = Math.trunc(value);
    return truncated >= 1 ? truncated : 1;
}
function nonNegativeInteger(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const truncated = Math.trunc(value);
    return truncated >= 0 ? truncated : 0;
}
