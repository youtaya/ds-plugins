/**
 * Shared "warn at most once per failure class" diagnostics helper.
 *
 * Recording is best-effort: a repeated failure (a stalled disk, an unwritable
 * output directory) must not flood the host log. Every module that can fail while
 * recording uses this helper instead of keeping its own bookkeeping.
 *
 * The logger is optional because `JsonlCallLog` can be constructed without one;
 * when it is absent the warning is simply dropped.
 *
 * @module tool-usage/warn
 */
/**
 * Build a warn-once function bound to one logger.
 *
 * @param logger - Host logger, or `undefined` to drop diagnostics.
 * @returns A function that logs the first message for each key and ignores repeats.
 */
export function createWarnOnce(logger) {
    const warned = new Set();
    return (key, message, error) => {
        if (warned.has(key))
            return;
        warned.add(key);
        const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error);
        logger?.warn(`tool-usage: ${message}${detail.length > 0 ? `: ${detail}` : ''}`);
    };
}
