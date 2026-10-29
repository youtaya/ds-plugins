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
import type { JsonValue } from './types.js';
/** Placeholder for a redacted sensitive value. */
export declare const REDACTED_PLACEHOLDER = "[REDACTED]";
/** Placeholder for a value that has no lossless JSON representation. */
export declare const UNSERIALIZABLE_PLACEHOLDER = "[unserializable]";
/** Placeholder for a value below the configured depth limit. */
export declare const DEEP_PLACEHOLDER = "[deep]";
/** Appended when a string is truncated. */
export declare const ELLIPSIS = "\u2026";
/**
 * Key stems that are redacted by default. Matching is case-insensitive and
 * ignores `-`, `_`, `.`, and whitespace, so `api_key`, `apiKey`, `API-KEY`,
 * `api.key`, and `"api key"` all match `apikey`.
 */
export declare const SENSITIVE_KEYS: readonly string[];
/** Options controlling redaction and truncation. */
export interface RedactOptions {
    /** Per-string character cap; strings longer than this are cut. */
    maxStringChars: number;
    /** Key stems whose values are replaced with {@link REDACTED_PLACEHOLDER}. */
    redactKeys: readonly string[];
    /** Maximum object/array nesting depth, default 6. */
    maxDepth?: number;
    /** Maximum retained array items, default 50. */
    maxArrayItems?: number;
}
/** Result of redacting one argument object. */
export interface RedactResult {
    /** Lossless-JSON projection of the input. */
    value: JsonValue;
    /** Whether at least one sensitive key was replaced. */
    redacted: boolean;
    /** Whether at least one string, array, or depth cut dropped information. */
    truncated: boolean;
}
/**
 * Redact and truncate one tool-argument value.
 *
 * @param args - Arbitrary parsed tool arguments; any shape is accepted.
 * @param options - String/array/depth limits and sensitive key stems.
 * @returns The JSON-safe value plus `redacted` / `truncated` flags.
 */
export declare function redactArgs(args: unknown, options: RedactOptions): RedactResult;
/**
 * Normalize one object key for sensitive-stem matching.
 *
 * @param key - Raw object key.
 * @returns Lowercase key with `-`, `_`, `.`, and whitespace removed.
 */
export declare function normalizeKey(key: string): string;
/**
 * Test whether a key stem is sensitive under the configured rules.
 *
 * @param key - Raw object key.
 * @param normalizedKeys - Normalized sensitive stems.
 * @returns `true` when the normalized key contains a configured stem.
 */
export declare function isSensitiveKey(key: string, normalizedKeys: readonly string[]): boolean;
