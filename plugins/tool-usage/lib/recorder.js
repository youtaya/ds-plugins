/**
 * The `tools/execute` wrapper: timing, redaction, explanation, aggregation, and logging.
 *
 * Contract (DESIGN §5.2): the wrapper never changes the tool result, `exec.signal`,
 * or any call identity. It measures around `next()`, records in every outcome
 * (including a rejected `next()`), and rethrows rejections unchanged. Recording is
 * best-effort: a stats/log/explain/schema failure is reported once and never
 * affects the caller's result.
 *
 * Record size is bounded: arguments are capped by `maxStringChars` /
 * `maxParamChars`, explanation summaries/details by the caps in `explain.ts`, and
 * failure messages by `maxStringChars`. Failure messages are taken from the tool
 * result and are **not** key-redacted (they are not part of the argument object).
 *
 * @module tool-usage/recorder
 */
import { explainToolCall } from './explain.js';
import { ELLIPSIS, redactArgs } from './redact.js';
import { round1 } from './stats.js';
import { CALL_RECORD_VERSION } from './types.js';
import { createWarnOnce } from './warn.js';
/** Abort codes reported through the normalized failure info. */
const ABORTED_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH']);
/**
 * Smallest serialized form of the whole-params truncation preview,
 * `{"_truncated":"…"}`. A configured `maxParamChars` below this cannot be honoured
 * literally, so the effective cap is raised to this floor (documented in README and
 * DESIGN §7).
 */
export const MIN_TRUNCATED_PARAMS_JSON_CHARS = 18;
/**
 * Wraps `tools/execute` to record every call.
 */
export class ToolUsageRecorder {
    stats;
    log;
    config;
    resolveToolSchema;
    warn;
    seq = 0;
    /**
     * @param options - Store, log, resolved config, logger, and schema resolver.
     */
    constructor(options) {
        this.stats = options.stats;
        this.log = options.log;
        this.config = options.config;
        this.resolveToolSchema = options.resolveToolSchema;
        this.warn = createWarnOnce(options.logger);
    }
    /**
     * Around-dispatch listener body. Must be used exactly once per `tools/execute`
     * invocation and its return value/rejection must be returned unchanged.
     *
     * @param exec - The pending, allowed call.
     * @param next - Dispatch continuation returning the normalized result.
     * @returns The exact result produced by `next()`.
     */
    async wrap(exec, next) {
        const startedAt = new Date();
        const startedAtMs = performance.now();
        let result;
        let thrown;
        let threw = false;
        try {
            result = await next();
        }
        catch (error) {
            threw = true;
            thrown = error;
        }
        try {
            const durationMs = round1(Math.max(0, performance.now() - startedAtMs));
            const record = this.buildRecord(exec, startedAt, durationMs, result, threw, thrown);
            this.commit(record);
        }
        catch (error) {
            this.warn('record', 'failed to record a tool call', error);
        }
        if (threw)
            throw thrown;
        return result;
    }
    /**
     * Flush the log queue and write the final statistics snapshot.
     */
    async dispose() {
        try {
            await this.log.dispose();
        }
        catch (error) {
            this.warn('dispose', 'failed to flush the tool-usage log', error);
        }
    }
    buildRecord(exec, startedAt, durationMs, result, threw, thrown) {
        const toolName = typeof exec.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown';
        // Redacted arguments feed both the record and the explanation.
        const redacted = redactArgs(exec.arguments, {
            maxStringChars: this.config.maxStringChars,
            redactKeys: this.config.redactKeys,
        });
        const explanation = this.explain(toolName, redacted.value, exec.agent);
        const params = this.capParams(redacted.value);
        const status = threw ? 'threw' : statusOf(result);
        const error = threw
            ? errorFromThrown(thrown, this.config.maxStringChars)
            : errorOf(result, status, this.config.maxStringChars);
        const callId = typeof exec.callId === 'string' && exec.callId.length > 0 ? exec.callId : undefined;
        const sessionId = sessionIdOf(exec.agent);
        return {
            v: CALL_RECORD_VERSION,
            seq: (this.seq += 1),
            at: startedAt.toISOString(),
            tool: toolName,
            ...(callId === undefined ? {} : { callId }),
            ...(sessionId === undefined ? {} : { sessionId }),
            durationMs,
            status,
            ...(params.value === undefined ? {} : { params: params.value }),
            paramsTruncated: redacted.truncated || params.truncated,
            redacted: redacted.redacted,
            explanation,
            ...(error === undefined ? {} : { error }),
        };
    }
    explain(toolName, params, agent) {
        if (this.config.explain === 'off')
            return { summary: '' };
        try {
            const schema = this.resolveToolSchema(toolName, agent);
            const explanation = explainToolCall(toolName, params, schema, {
                language: this.config.language,
                level: this.config.explain,
                maxValueChars: this.config.maxStringChars,
            });
            const details = explanation.details ?? [];
            return details.length > 0
                ? { summary: explanation.summary, details }
                : { summary: explanation.summary };
        }
        catch (error) {
            this.warn('explain', 'failed to explain a tool call', error);
            return { summary: toolName };
        }
    }
    capParams(value) {
        try {
            const serialized = JSON.stringify(value);
            if (serialized === undefined)
                return { value: undefined, truncated: false };
            if (serialized.length <= this.config.maxParamChars) {
                return { value, truncated: false };
            }
            return {
                value: { _truncated: truncatedPreview(serialized, this.config.maxParamChars) },
                truncated: true,
            };
        }
        catch (error) {
            this.warn('params', 'failed to serialize tool arguments', error);
            return { value: undefined, truncated: true };
        }
    }
    commit(record) {
        try {
            this.stats.record(record);
        }
        catch (error) {
            this.warn('stats', 'failed to update statistics', error);
        }
        try {
            this.log.append(record);
        }
        catch (error) {
            this.warn('log', 'failed to append the call log', error);
        }
        try {
            this.log.scheduleStats(this.stats.toJSON());
        }
        catch (error) {
            this.warn('stats-write', 'failed to schedule the statistics snapshot', error);
        }
    }
}
function statusOf(result) {
    if (result === undefined || result.isError === false)
        return 'ok';
    const code = result.error?.info?.code;
    if (typeof code === 'string' && ABORTED_CODES.has(code))
        return 'aborted';
    return 'error';
}
function errorOf(result, status, maxStringChars) {
    if (status === 'ok' || result === undefined || result.isError !== true)
        return undefined;
    const raw = typeof result.error?.message === 'string' && result.error.message.length > 0
        ? result.error.message
        : 'tool call failed';
    const message = capMessage(raw, maxStringChars);
    const code = result.error?.info?.code;
    return typeof code === 'string' && code.length > 0
        ? { message, code: capMessage(code, maxStringChars) }
        : { message };
}
function errorFromThrown(thrown, maxStringChars) {
    if (thrown instanceof Error) {
        const codeValue = thrown.code;
        const code = typeof codeValue === 'string' && codeValue.length > 0
            ? capMessage(codeValue, maxStringChars)
            : undefined;
        const raw = thrown.message.length > 0 ? thrown.message : thrown.name;
        const message = capMessage(raw, maxStringChars);
        return code === undefined ? { message } : { message, code };
    }
    if (typeof thrown === 'object' && thrown !== null) {
        const record = thrown;
        const raw = typeof record.message === 'string' && record.message.length > 0
            ? record.message
            : 'tool call threw';
        const message = capMessage(raw, maxStringChars);
        return typeof record.code === 'string' && record.code.length > 0
            ? { message, code: capMessage(record.code, maxStringChars) }
            : { message };
    }
    const raw = typeof thrown === 'string' && thrown.length > 0 ? thrown : 'tool call threw';
    return { message: capMessage(raw, maxStringChars) };
}
/**
 * Cut one failure message to at most `maxStringChars` characters with an ellipsis.
 * Failure messages are not key-redacted (see the module contract).
 */
function capMessage(message, maxStringChars) {
    if (message.length <= maxStringChars)
        return message;
    const keep = Math.max(0, maxStringChars - 1);
    return `${message.slice(0, keep)}${ELLIPSIS}`;
}
/**
 * Build the largest truncation preview whose serialized `{"_truncated": "..."}`
 * form fits in `maxParamChars` characters. The preview envelope itself needs
 * {@link MIN_TRUNCATED_PARAMS_JSON_CHARS} characters, so smaller caps are raised to
 * that floor.
 */
function truncatedPreview(serialized, maxParamChars) {
    const limit = Math.max(maxParamChars, MIN_TRUNCATED_PARAMS_JSON_CHARS);
    const previewLength = (keptBits) => JSON.stringify({ _truncated: `${serialized.slice(0, keptBits)}${ELLIPSIS}` }).length;
    let low = 0;
    let high = Math.min(serialized.length, limit);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (previewLength(middle) <= limit)
            low = middle;
        else
            high = middle - 1;
    }
    return `${serialized.slice(0, low)}${ELLIPSIS}`;
}
function sessionIdOf(agent) {
    if (typeof agent !== 'object' || agent === null)
        return undefined;
    const id = agent.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
}
