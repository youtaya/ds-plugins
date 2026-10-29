/**
 * Shared, dependency-free type contracts for the tool-usage plugin.
 *
 * Everything in this module is either a type or a tiny constant, so importing it
 * never pulls in Node built-ins or the DSH tool runtime. All serializable shapes
 * are declared with `type` aliases (rather than `interface`) so they remain
 * assignable to the canonical lossless-JSON type used by `defineTool`.
 *
 * @module tool-usage/types
 */
/** Version stamped onto every line of the JSONL call log. */
export const CALL_RECORD_VERSION = 1;
/** Version stamped onto the persisted statistics snapshot. */
export const PERSISTED_STATS_VERSION = 1;
