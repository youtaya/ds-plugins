# dsh-plugin-tool-usage

[中文](README.zh.md)

Records every tool call an agent makes, gives each call a deterministic human-readable explanation, and reports per-tool and per-session call counts and latency. Everything stays on the local machine.

| Item | Value |
| --- | --- |
| Package | `dsh-plugin-tool-usage` 0.1.0 — a DSH bundle plugin (Cordis plugin name `tool-usage`) |
| Model tool | `tool_usage` (rename with `toolName`) |
| Slash command | `/tool-usage` (rename with `commandName`) |
| Data directory | `$DSH_HOME/tool-usage/` (default `~/.dsh/tool-usage/`) |
| Runtime imports | `node:*` built-ins plus the host-provided `@deepseek-ai/dsh-tools`; the package installs no third-party runtime dependency |
| License | MIT — copyright 2026 youtaya |

The plugin wraps `tools/execute`: it starts a timer before each call and records the call when it finishes. It only measures and records — it never changes the tool result, `exec.signal`, or the call identity. Each class of recording failure emits one warning and leaves the executing tool untouched.

## What is recorded

Every `tools/execute` produces one `CallRecord`, appended to the JSONL file for the current local date:

| Field | Meaning |
| --- | --- |
| `v` | Record format version, currently `1` |
| `seq` | Monotonically increasing sequence number per plugin lifetime |
| `at` | Call start time (ISO-8601) |
| `tool` | Tool name, e.g. `bash`, `read`, `grep` |
| `callId` | Execution call id, when present |
| `sessionId` | Owning session id (`exec.agent?.id`), when present |
| `durationMs` | Duration in milliseconds, rounded to 1 decimal |
| `status` | `ok` / `error` / `aborted` / `threw` |
| `params` | Redacted and truncated call arguments; values with no JSON representation become `"[unserializable]"` |
| `paramsTruncated` | Whether arguments were cut by a string, array, depth, or whole-params cap |
| `redacted` | Whether at least one value was replaced by `[REDACTED]` |
| `explanation` | `{ summary, details? }`, see below |
| `error` | `{ message, code? }`, present on every non-`ok` record; `message` and `code` are capped at `maxStringChars` and are not key-redacted |

Status mapping:

- `ok`: the tool succeeded (`isError` is `false`).
- `error`: the tool returned an error result (`isError` is `true`, and the error code is not an abort).
- `aborted`: the result code is `ABORTED` or `ABORTED_BEFORE_DISPATCH`.
- `threw`: `next()` threw (protocol-level failure); the original error is rethrown unchanged.

One line of the JSONL log (wrapped here for readability; the file stores one compact object per line):

```json
{
  "v": 1,
  "seq": 42,
  "at": "2026-10-28T08:31:05.412Z",
  "tool": "bash",
  "callId": "call_7f3a91",
  "sessionId": "ses_01J8ZK",
  "durationMs": 1402.7,
  "status": "ok",
  "params": { "command": "pnpm test", "cwd": "/srv/project" },
  "paramsTruncated": false,
  "redacted": false,
  "explanation": { "summary": "Run shell command: pnpm test" }
}
```

Arguments are redacted and truncated before they are written; see [Data, permissions, and privacy](#data-permissions-and-privacy).

## Explanation

Explanations come from a pure function: no I/O, no clock, no model call. The same input always produces the same text. `language` selects Chinese or English, and `explain` selects off, brief, or detailed.

`summary` examples with `language: en` and `explain: detailed`:

```text
Run shell command: pnpm test
Read file /tmp/a.ts (from line 1, up to 200 lines)
Search text: TODO (in /srv/project/src) (glob *.ts)
Search the web: deepseek harness plugin
```

With `language: zh`:

```text
执行 Shell 命令：pnpm test
读取文件 /tmp/a.ts（第 1 行起，最多 200 行）
搜索文本：TODO（目录 /srv/project/src）（glob *.ts）
网络搜索：deepseek harness plugin
```

- `brief`: produce `summary` only.
- `detailed`: also add the registered tool description and one line per declared parameter to `details` (`Parameter <name>: <description> = <value>`, Chinese: `参数 <name>：<说明> = <值>`; a parameter that was not passed renders as `(not provided)`), followed by any extra argument keys.
- `off`: do not generate an explanation.
- Built-in phrasings cover `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_search`, `web_fetch`, `read_image`, `todo_write`, `subagent`, `subagent_fork`, `workflow`, `working_directory`, `ask_user_question`, `job_output`, `job_kill`, and `job_list`. Common aliases (for example `shell` → `bash`, `read_file` → `read`), hyphenated variants, and namespaced names (the last `__`, `.`, `:`, `/`, or `\` segment is matched, as in `mcp__server__bash`) resolve to the same phrasings. Unknown tools fall back to `Call tool <name>: <compact params>` (English) or `调用工具 <name>：<参数摘要>` (Chinese).
- `summary` is always a single line: whitespace, including newlines, is collapsed before it is stored.
- Explanation size is bounded so a record cannot grow without limit: `summary` is capped at 2,000 characters, `details` at 50 lines / 8,000 characters, and registered tool/parameter descriptions are clipped like any other value; excess detail lines/characters are dropped, not marked.

The model can also ask for the explanation of any registered tool:

```json
{ "view": "explain", "tool": "bash" }
```

That view returns the tool's registered description and parameter table. A missing or unknown tool fails with an error: the implementation throws, and the runtime reports it as a normal tool error result instead of a crash.

## Statistics

Aggregates live in memory; a query never scans the JSONL log.

**Per tool** (one row in the `tools` view, sorted by call count descending): `calls`, `errors` (failures: status `error` or `threw`; `aborted` means the caller cancelled and is not counted as a failure), `errorRate` (4 decimal places), `totalMs`, `avgMs`, `minMs`, `maxMs`, `lastMs`, `lastAt`, `slowCalls`. The persisted aggregates also keep `statusCounts` per tool.

**Totals**: `calls`, `errors`, `totalMs`, `avgMs`, `maxMs`, `slowCalls`, and `sessionCount` (for `all` scope, the number of distinct real sessions — the no-session bucket is not counted; for a session-scope query, `1` when that scope has recorded calls, otherwise `0`).

Semantics:

- **Scope**: `session` counts the current session only (by `exec.agent?.id`); `all` counts every session recorded since the plugin started. Both read the same in-memory aggregate; neither recomputes from disk. Calls without a session id go into a no-session bucket: the `all` scope includes it, and the session scope selects it when the caller itself has no session id.
- **Slow calls**: any call with `durationMs >= slowThresholdMs` (default 5000 ms) increments `slowCalls`, and the matching `recent[].slow` snapshot field is `true`.
- **Recent calls**: the last `recentLimit` calls (default 200) are kept in a ring buffer; queries return newest first, capped by `limit` (1–100 for the tool).
- **Parallel calls overlap**: durations are `performance.now()` deltas, so `totalMs` is the sum of individual durations and can exceed wall-clock elapsed time when calls run in parallel. `avgMs` is a per-call average, not throughput.
- **Persistence**: aggregates are written to `stats.json` and restored on restart when `restoreStats: true` and `persistStats: true`, so counts continue across restarts. Restoration merges additively into the live store, so calls recorded while the startup read is in flight are not lost. The `recent` list is memory-only and starts empty after a restart; the JSONL log is the source of history.
- All millisecond values in snapshots are rounded to 1 decimal.

## Install and remove

`lib/` is committed in the package, so installation needs no build script and no extra build permission. The package is not yet published to npm; install it from a checkout of the repository.

From the repository root:

```sh
git clone https://github.com/youtaya/dsh-plugins.git
cd dsh-plugins

# install the plugin into a profile (the profile is created on first use)
dsh plugin --profile <profile> add "$PWD/plugins/tool-usage"

# confirm the layer is present
dsh --profile <profile> --dump-config    # expect a "# == dsh-plugin-tool-usage" layer and a row with id tool-usage

# start that profile
dsh --profile <profile>
```

If you already have a checkout, pass its package path directly instead: `dsh plugin --profile <profile> add <abs path to>/plugins/tool-usage`.

The plugin takes effect after restarting the profile (HMR in development sessions may apply it too, but a restart is authoritative).

Removal:

```sh
dsh plugin --profile <profile> remove dsh-plugin-tool-usage
```

Removing the plugin does not delete recorded calls or statistics; clean the data directory yourself if needed.

### Overriding configuration

The bundle patch inserts a single row with no `config`; all defaults live in the plugin. Override by id `tool-usage` in the profile's own `cordis.patch.yml` (or any later patch layer):

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: tool-usage
  config:
    language: en
    explain: brief
    slowThresholdMs: 10000
```

A patch **replaces** the targeted row's whole `config`; it does not merge key by key. The plugin applies defaults to missing keys, so restating only the keys you change is enough. Restate any non-default value you want to keep.

## Compatibility

- DSH `>=0.2.0-0 <0.3.0` (declared as `engines.dsh`); verified against DSH `0.2.2-alpha.2`.
- Node.js `>=24.9` for building and testing this repository (`.nvmrc` pins `24.19.0`, the version used for verification); the installed plugin runs inside the DSH host process and adds no separate Node runtime.
- Peer packages supplied by the DSH profile: `@deepseek-ai/cordis >=4.0.0-0 <5.0.0`, `@deepseek-ai/dsh-tools >=0.2.0-0 <0.3.0`, and `@deepseek-ai/dsh-commands >=0.2.0-0 <0.3.0`.
- Runtime imports are limited to `node:*` built-ins and `@deepseek-ai/dsh-tools`; nothing else is installed or bundled.
- Web / Desktop profiles get the `/tool-usage` command; a headless profile still records calls and exposes the `tool_usage` tool.
- Node ESM only. The plugin is not yet published to npm; install from a local checkout as shown above.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` logs one info line and returns: no recording, no tool, no command. |
| `outputDir` | `"$DSH_HOME/tool-usage"` | Data directory; expands a leading `~` and `$DSH_HOME`, and a relative value is resolved against the working directory. `""` means "do not persist" (both persist flags are effectively off). |
| `persistCalls` | `true` | Append call records to `calls-YYYY-MM-DD.jsonl`. |
| `persistStats` | `true` | Write the aggregate snapshot to `stats.json`. |
| `restoreStats` | `true` | Restore aggregates from `stats.json` on startup; requires `persistStats: true`, otherwise there is no snapshot to read. |
| `explain` | `"detailed"` | Explanation level: `off` / `brief` / `detailed`. With `off`, the recorded `explanation.summary` is an empty string and is omitted when rendered. |
| `language` | `"zh"` | Language for explanations and reports: `zh` / `en`. |
| `maxParamChars` | `500` | Character cap for the whole serialized parameter JSON. When exceeded, params are replaced with a `{ "_truncated": "<prefix>…" }` preview sized to fit the cap; the preview envelope itself needs 18 characters, so caps below 18 are effectively raised to that floor. `paramsTruncated` is set to `true`. |
| `maxStringChars` | `200` | Character cap for one string value (and for failure `error.message` text); longer strings are cut to `maxStringChars - 1` characters plus `…`. |
| `redactKeys` | built-in `SENSITIVE_KEYS` + user additions | Sensitive key list; matching is case-insensitive, and a key is sensitive when its normalized form (lowercase, `-`/`_`/`.` and whitespace stripped) **contains** any configured entry. User entries are additions only; built-ins cannot be removed. |
| `recentLimit` | `200` | Capacity of the in-memory recent-calls ring buffer. |
| `slowThresholdMs` | `5000` | Slow-call threshold in milliseconds, used for `slowCalls` and the `slow` marker. |
| `toolName` | `"tool_usage"` | Model tool name. |
| `commandName` | `"tool-usage"` | Slash command name without `/`; lowercased automatically, a leading `/` is stripped, and it must match `[a-z][a-z0-9_-]*` (otherwise the default is used). |
| `statsWriteDebounceMs` | `2000` | Debounce window for `stats.json` writes; disposal flushes immediately. |
| `includeParamsInReport` | `true` | Whether `recent[]` entries in tool/command snapshot output carry the redacted parameters. The Markdown reports never show parameters. |

`$DSH_HOME` comes from `process.env.DSH_HOME` (trimmed); when unset, `~/.dsh` is used. Invalid values do not fail plugin loading: wrong types, unknown enum values, and invalid command names fall back to their defaults, out-of-range numbers are clamped to the allowed interval, and a warning is logged.

## The `tool_usage` model tool

A read-only tool registered for every agent (`isConcurrencySafe: () => true`). It never mutates state.

| Parameter | Type | Values | Notes |
| --- | --- | --- | --- |
| `view` | string | `summary` / `tools` / `recent` / `explain` | What to return. Defaults to `summary`. |
| `tool` | string | tool name | Required for `view: "explain"`; with the other views it filters the per-tool table and the recent calls by exact tool name. |
| `scope` | string | `session` / `all` | Statistics scope. Defaults to `session`. |
| `limit` | integer | `1`–`100` | Maximum number of recent calls returned. Defaults to `20`; out-of-range values are clamped to this interval. |

Example calls:

```json
{ "view": "summary" }
```

```json
{ "view": "recent", "limit": 5, "scope": "all" }
```

```json
{ "view": "explain", "tool": "bash" }
```

The tool's **output value** is the canonical snapshot JSON; the text **rendered for the model** is compact Markdown (English when `language: en`, Chinese when `zh`). Example Markdown output:

```markdown
Tool call statistics (scope: current session)

Totals: 12 calls / 1 failed / 3.2s total / 267ms avg / 1.4s slowest

| Tool | Calls | Errors | Avg | Slowest | Last |
| --- | --- | --- | --- | --- | --- |
| bash | 8 | 0 | 210ms | 1.4s | 12:31:05 |
| read | 3 | 1 | 400ms | 620ms | 12:30:58 |
| grep | 1 | 0 | 320ms | 320ms | 12:30:41 |

Recent calls:
1. [12:31:05] bash — Run shell command: pnpm test (1.4s)
2. [12:30:58] read — Read file /tmp/a.ts (from line 1, up to 200 lines) (620ms, failed)
3. [12:30:41] grep — Search text: TODO (320ms)
```

With `scope: "all"` the header says "scope: all sessions"; the session count lives in the snapshot JSON as `totals.sessionCount` (the Markdown does not show it). The `tools` view keeps only the header, totals line, and per-tool table; `recent` keeps only the header, totals line, and recent-call list; `summary` includes both sections; `explain` returns the target tool's registered description and parameter table.

## The `/tool-usage` slash command

The command is registered only in profiles that provide the `commands` service (Web / Desktop). In a headless profile it is absent; everything else works.

| Command | Behavior |
| --- | --- |
| `/tool-usage` | Summary for the current session (totals + per-tool table + recent calls). |
| `/tool-usage all` | Summary across all sessions. |
| `/tool-usage recent [N]` | The N most recent calls in the current session (for example `/tool-usage recent 5`); default 10, clamped to 1–100. |
| `/tool-usage reset` | Clear statistics for all sessions and rewrite `stats.json` from the cleared state, so a restart does not restore pre-reset counts (the persisted JSONL call log is untouched). |
| Anything else | Error plus usage text. |

The command output uses the same Markdown renderer as the model tool.

## Data, permissions, and privacy

Written under `outputDir` (default `$DSH_HOME/tool-usage/`, i.e. `~/.dsh/tool-usage/`):

- `calls-YYYY-MM-DD.jsonl`: one file per local date, one call record per line, append-only.
- `stats.json`: aggregate snapshot (totals, per tool, per session) used to restore on restart, merged into the in-memory aggregates at startup. It is written atomically through a per-process unique temporary file (`stats.json.<pid>.<random>.tmp` + `rename`, cleaned up on failure) and has last-writer-wins semantics.

Read today's records with:

```sh
tail -n 5 ~/.dsh/tool-usage/calls-$(date +%F).jsonl
```

Permissions: the directory is created with `0o700`, files with `0o600` — readable by the current user only. An existing daily log file that is looser (for example a `0644` file left by an older version) is re-tightened to `0o600` once per process on its first append. The plugin writes nowhere outside `outputDir` and makes no network requests: data never leaves the machine.

Redaction and truncation happen before a record or explanation is built:

- The default sensitive key set (`SENSITIVE_KEYS`) is `token`, `password`, `passwd`, `secret`, `apikey`, `authorization`, `cookie`, `credential`, `privatekey`, `accesskey`, `secretkey`, `clientsecret`, and `sessiontoken`. Matching is case-insensitive; a key matches when its normalized form (lowercase, `-`/`_`/`.` and whitespace stripped) **contains** any sensitive key, so `api.key` and `"api key"` match `apikey`.
- Matched values become `[REDACTED]` and `redacted` is set to `true`.
- Strings longer than `maxStringChars` are truncated with `…`; arrays longer than 50 items are cut with a trailing `[… N more items]`; nesting deeper than 6 levels becomes `[deep]`.
- Non-JSON values (`undefined`, functions, symbols, class instances, circular references, `NaN`/`±Infinity`) become `"[unserializable]"`; `bigint` becomes a decimal string.
- When the whole parameter JSON exceeds `maxParamChars`, it is replaced by a truncation preview sized to fit the cap (minimum 18 characters), so a record is always valid JSON.
- Failure `error.message` text and `error.code` are taken from the tool result, capped at `maxStringChars`, and are **not** key-redacted (they are not part of the argument object).
- Any of those cuts (string, array, depth, or whole-params cap) also sets `paramsTruncated` to `true`.
- Extra keys can be added with `redactKeys` (for example `["sessionToken", "idCard"]`); built-ins cannot be removed.

Note: redaction is key-name based. A secret embedded in a value (for example `--token=...` inside a command line) can still be recorded, and structural pair/array shapes are not inspected — `headers: [["Authorization", "Bearer ..."]]` and `env: ["API_KEY=..."]` keep their string contents because only object keys are matched. For sensitive projects, add project-specific key names, tighten `maxStringChars` / `maxParamChars`, or set `outputDir: ""` / `persistCalls: false` so records stay in memory only.

## Performance

- One redaction + explanation pass per call (pure functions, microseconds), one in-memory aggregate update (O(1)), and one **asynchronously queued** JSONL append. The append does not block the tool result; slow disk only delays the log queue.
- Aggregates are maintained in memory, so `tool_usage` queries and the `/tool-usage` command never scan the JSONL log.
- `stats.json` writes are debounced (default 2 s) and flushed on dispose, keeping write amplification low.
- Memory is bounded for recorded data: aggregates are counters per tool/session, recent calls are capped at `recentLimit` (default 200), and every record field is capped (params, strings, failure message/code, explanation summary/details). The one unbounded temporary structure is the queue of pending JSONL lines while the disk is stalled: each queued line is one bounded record and the queue drains when the write completes.
- No sampling, no network, no model calls.

## Disabling

- Temporarily stop recording without uninstalling: override `{ id: tool-usage, config: { enabled: false } }` in the profile's `cordis.patch.yml` and restart.
- Remove entirely: `dsh plugin --profile <profile> remove dsh-plugin-tool-usage`, then delete the data directory if desired.

## Design notes

**Why wrap `tools/execute` instead of listening to session events.** Tool execution has exactly one entry point. `tools/execute` provides the original `exec.arguments`, the normalized `ToolExecutionResult` (with `isError` and `error.info.code`), and exact start/end timing, and it covers built-in tools, plugin tools, and calls made inside subagents and workflows. Session events do not reliably carry per-call arguments or timing and can miss non-session execution paths. The wrapper only measures and records: the result and `exec.signal` are returned unchanged, and every error raised inside recording is swallowed.

**Why no third-party runtime dependencies.** Configuration validation is hand-written (no Schemastery), the explainer is a pure function, and logging uses `node:fs`. Installing from a local package directory therefore never runs a build step or needs build permission, the dependency surface is small, loading is fast, and supply-chain risk is low. `lib/` is committed; `node scripts/build.mjs` is a development-time command.

**Cost per call.** One wrapper function invocation, one microsecond-scale pure explanation, one hash-map aggregate update, and one JSONL append queued in the background; no disk wait, no network request, no copy of the tool result. Snapshots are written periodically, and queries never scan. The overhead is negligible next to the tool itself, and recording degrades silently on failure without affecting the call.

## Limitations (v1)

- No browser UI: no statistics card or chart page. Data is available through the tool, the command, the JSONL log, and `stats.json`.
- No Prometheus / OTLP export, no sampling, no LLM-generated explanations.
- JSONL files are split by date but are **not rotated or cleaned automatically**: there is no retention policy, so archive or delete old files yourself for long-running use.
- `stats.json` is one aggregate snapshot with last-writer-wins semantics, so it assumes a single DSH process per `$DSH_HOME`; the append-only JSONL log stays safe with concurrent writers.
- The `recent` list is memory-only and starts empty after a plugin restart; cross-restart history comes from the JSONL log.
- Parallel calls overlap in time, so `totalMs` can exceed wall-clock elapsed time; statistics do not measure concurrency.
- Statistics attribute calls to sessions by `exec.agent?.id`; calls without a session id go into a no-session bucket that belongs to no specific session.
- Recording is best-effort: a failed write logs one warning and keeps counting in memory; it never blocks or retries the tool call. A failed output-directory creation is retried on a later write instead of disabling persistence for the plugin lifetime.
- Redaction matches key names only: it does not scan values for sensitive text, nor structural pair/array shapes such as `headers: [["Authorization", "Bearer ..."]]` / `env: ["API_KEY=..."]`.
- `tool_usage` `explain` depends on the tool being registered; an unknown or unregistered tool fails with a tool error result.
- Failure messages are recorded (capped, but not key-redacted); avoid letting tools print secrets in their error text.

## Repository, license, and documentation

- Repository: <https://github.com/youtaya/dsh-plugins> — this package lives in `plugins/tool-usage`.
- License: MIT, copyright 2026 youtaya — see [LICENSE](LICENSE).
- Detail document (shipped with the package): [docs/DETAIL.md](docs/DETAIL.md).
- Design contract: [docs/DESIGN.md](https://github.com/youtaya/dsh-plugins/blob/main/docs/DESIGN.md) (repo-relative path `docs/DESIGN.md`).
- Security policy: [SECURITY.md](https://github.com/youtaya/dsh-plugins/blob/main/SECURITY.md).
