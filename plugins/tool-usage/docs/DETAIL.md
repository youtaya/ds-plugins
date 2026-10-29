# Tool usage statistics

`dsh-plugin-tool-usage` keeps a readable record of every tool call an agent makes: what was called, with which arguments (redacted), how long it took, whether it succeeded, and which session it belongs to. It also aggregates call counts and latency per tool. Everything stays on the local machine.

## Features

- **Recording**: wraps `tools/execute` and records the tool name, redacted and truncated arguments, start time, duration, status (`ok` / `error` / `aborted` / `threw`), owning session, and call id — one JSONL line per call.
- **Explanation**: gives every call a deterministic Chinese or English summary, such as "Run shell command: pnpm test" or "Read file /tmp/a.ts (from line 1, up to 200 lines)", so a log line is understandable without the model's arguments.
- **Statistics**: per-tool and per-session call counts, errors, total latency, average/min/max/last latency, and slow-call counts. Aggregates live in memory; queries never scan the log.
- **Two entry points**: the read-only model tool `tool_usage` (`summary` / `tools` / `recent` / `explain` views) and the human `/tool-usage` slash command.
- **Persistence**: call records are written per day to `calls-YYYY-MM-DD.jsonl`, aggregate snapshots to `stats.json` and restored on restart.

The plugin only measures and records. It never changes the tool result, `exec.signal`, or call identity; each class of recording failure logs one warning and leaves the executing tool untouched.

## Quick start

The package is not yet published to npm; install it from a local checkout of the repository.

```sh
git clone https://github.com/youtaya/dsh-plugins.git
cd dsh-plugins

# install into a profile (created on first use)
dsh plugin --profile <profile> add "$PWD/plugins/tool-usage"

# confirm the layer is active: expect "# == dsh-plugin-tool-usage" and a row with id tool-usage
dsh --profile <profile> --dump-config

# start
dsh --profile <profile>
```

If you already have a checkout, pass its package path instead: `dsh plugin --profile <profile> add <abs path to>/plugins/tool-usage`. Restart the profile for the layer to take effect. `lib/` is committed, so installation needs no build script or extra permission.

Remove:

```sh
dsh plugin --profile <profile> remove dsh-plugin-tool-usage
```

Removal does not delete recorded calls or statistics; clean the data directory (default `~/.dsh/tool-usage/`) yourself if needed.

## Compatibility

- DSH `>=0.2.0-0 <0.3.0` (declared as `engines.dsh`); verified against DSH `0.2.2-alpha.2`.
- Node.js `>=24.9` for building and testing this repository (`.nvmrc` pins `24.19.0`, the version used for verification); the installed plugin runs inside the DSH host process.
- Peer packages supplied by the DSH profile: `@deepseek-ai/cordis >=4.0.0-0 <5.0.0`, `@deepseek-ai/dsh-tools >=0.2.0-0 <0.3.0`, and `@deepseek-ai/dsh-commands >=0.2.0-0 <0.3.0`.
- Runtime imports are limited to `node:*` built-ins and `@deepseek-ai/dsh-tools`; no third-party runtime dependency is installed or bundled.
- Web / Desktop profiles get the slash command; a headless profile still records calls and exposes the `tool_usage` tool.

## What is recorded

One JSON line per tool call:

```json
{"v":1,"seq":42,"at":"2026-10-28T08:31:05.412Z","tool":"bash","callId":"call_7f3a91","sessionId":"ses_01J8ZK","durationMs":1402.7,"status":"ok","params":{"command":"pnpm test"},"paramsTruncated":false,"redacted":false,"explanation":{"summary":"Run shell command: pnpm test"}}
```

`status` is one of `ok` (succeeded), `error` (tool returned an error result), `aborted` (result code `ABORTED` or `ABORTED_BEFORE_DISPATCH`), or `threw` (protocol-level throw; the original error is rethrown). In statistics, `errors` counts only `error` and `threw`; `aborted` calls are not failures, and per-status totals live in `statusCounts`.

Arguments are redacted before they are written: values of sensitive keys (such as token, password, apiKey, authorization, cookie) become `[REDACTED]`, long strings are truncated, and when the whole parameter JSON exceeds `maxParamChars` it is replaced by a preview sized to fit that cap (minimum 18 characters). Any string, array, depth, or whole-params cut sets `paramsTruncated: true`. `redacted: true` marks at least one replaced value. A failure `error.message`/`error.code` is taken from the tool result, capped at `maxStringChars`, and is not key-redacted.

Explanations are bounded as well: the one-line `summary` is capped at 2,000 characters and `details` at 50 lines / 8,000 characters; registered tool and parameter descriptions are clipped like any other value.

## Reading statistics

### The `tool_usage` model tool

| Parameter | Type | Values | Notes |
| --- | --- | --- | --- |
| `view` | string | `summary` / `tools` / `recent` / `explain` | What to return; default `summary` |
| `tool` | string | tool name | Required for `view: "explain"`; with the other views it filters the per-tool table and the recent calls by exact tool name |
| `scope` | string | `session` / `all` | Statistics scope; default `session` |
| `limit` | integer | `1`–`100` | Max recent calls returned; default `20` |

Examples:

```json
{ "view": "summary" }
{ "view": "recent", "limit": 5 }
{ "view": "explain", "tool": "bash" }
```

The tool's output value is the canonical snapshot JSON; the text rendered for the model is compact Markdown:

```markdown
Tool call statistics (scope: current session)

Totals: 12 calls / 1 failed / 3.2s total / 267ms avg / 1.4s slowest

| Tool | Calls | Errors | Avg | Slowest | Last |
| --- | --- | --- | --- | --- | --- |
| bash | 8 | 0 | 210ms | 1.4s | 12:31:05 |
| read | 3 | 1 | 400ms | 620ms | 12:30:58 |

Recent calls:
1. [12:31:05] bash — Run shell command: pnpm test (1.4s)
2. [12:30:58] read — Read file /tmp/a.ts (from line 1, up to 200 lines) (620ms, failed)
```

The `explain` view returns the target tool's registered description and parameter table, so the model can understand other tools. A missing or unregistered tool fails with a tool error result.

### The `/tool-usage` slash command

| Command | Behavior |
| --- | --- |
| `/tool-usage` | Summary for the current session |
| `/tool-usage all` | Summary across all sessions |
| `/tool-usage recent [N]` | The N most recent calls in the current session (for example `/tool-usage recent 5`); default 10 |
| `/tool-usage reset` | Clear statistics for all sessions and rewrite `stats.json` from the cleared state, so a restart does not restore pre-reset counts (the persisted JSONL log is untouched) |

The command is registered only in profiles that provide the `commands` service (Web / Desktop). A headless profile still records calls and exposes the model tool.

## Configuration

Override by id `tool-usage` in the profile's `cordis.patch.yml` (a patch replaces the whole `config`; the plugin applies defaults to missing keys, so restate only what you change):

```yaml
- id: tool-usage
  config:
    language: en
    explain: brief
    slowThresholdMs: 10000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` records nothing |
| `outputDir` | `"$DSH_HOME/tool-usage"` | Data directory; expands `~` / `$DSH_HOME`, and a relative value is resolved against the working directory; `""` disables persistence |
| `persistCalls` | `true` | Write the JSONL call log |
| `persistStats` | `true` | Write the `stats.json` aggregate snapshot |
| `restoreStats` | `true` | Restore aggregates on startup (requires `persistStats`) |
| `explain` | `"detailed"` | `off` / `brief` / `detailed` |
| `language` | `"zh"` | `zh` / `en` |
| `maxParamChars` | `500` | Character cap for the whole parameter JSON; the truncation preview fits the cap (minimum envelope is 18 characters) |
| `maxStringChars` | `200` | Character cap for one string value and for failure `error.message` text |
| `redactKeys` | built-in keys + additions | Sensitive key list; matching strips `-`/`_`/`.`/whitespace; additions only |
| `recentLimit` | `200` | Capacity of the recent-calls ring buffer |
| `slowThresholdMs` | `5000` | Slow-call threshold in milliseconds |
| `toolName` | `"tool_usage"` | Model tool name |
| `commandName` | `"tool-usage"` | Slash command name |
| `statsWriteDebounceMs` | `2000` | Debounce window for `stats.json` writes |
| `includeParamsInReport` | `true` | Whether `recent[]` entries in snapshot output carry redacted parameters (the Markdown reports never show parameters) |

## Data and privacy

- Location: `$DSH_HOME/tool-usage/calls-YYYY-MM-DD.jsonl` (one file per local date) and `$DSH_HOME/tool-usage/stats.json`; `$DSH_HOME` defaults to `~/.dsh`.
- Permissions: directory `0o700`, files `0o600`; an existing daily log file with looser permissions is re-tightened to `0o600` once per process on its first append. `stats.json` is written atomically through a per-process unique temporary file (`stats.json.<pid>.<random>.tmp`) plus `rename`; it has last-writer-wins semantics, so it assumes a single DSH process per `$DSH_HOME` (the JSONL appends remain safe with concurrent writers).
- Writes stay inside `outputDir`; no network requests are made and data never leaves the machine.
- Redaction runs before arguments reach records or explanations. Redaction is key-name based, so secret text embedded in a value (for example `--token=...` in a command line) can still be recorded, and structural pair/array shapes (`headers: [["Authorization", "Bearer ..."]]`, `env: ["API_KEY=..."]`) are not inspected. Add `redactKeys`, tighten `maxStringChars` / `maxParamChars`, or use `outputDir: ""` / `persistCalls: false` to keep records in memory only.

## Performance and limitations

- Each call adds one microsecond-scale pure explanation, one O(1) in-memory aggregate update, and one queued asynchronous JSONL append; it never waits on disk or blocks the tool result.
- Aggregates are kept in memory, so statistics queries never scan the JSONL log; `stats.json` writes are debounced (2 s by default) and flushed on dispose.
- Memory is bounded for recorded data: aggregates are counters per tool/session, recent calls are capped at `recentLimit`, and each record field is capped (params, strings, failure messages, explanation summary/details). The one unbounded temporary structure is the queue of pending JSONL lines while the disk is stalled; each queued line is one bounded record and the queue drains when the write completes.
- Parallel calls overlap in time, so `totalMs` can exceed wall-clock elapsed time.
- The `recent` list is memory-only and empty after a restart; cross-restart history comes from the JSONL log.
- JSONL files are split by date but are not cleaned automatically; there is no retention or rotation policy.
- v1 has no browser statistics page, no Prometheus / OTLP export, no sampling, and no LLM-generated explanations.
- A failed write logs one warning and continues in memory; it never blocks a tool call. A failed output-directory creation is retried on a later write, so a transient failure does not disable persistence for the plugin lifetime.

## Repository and license

- Repository: <https://github.com/youtaya/dsh-plugins> — this package lives in `plugins/tool-usage`.
- License: MIT, copyright 2026 youtaya — see [LICENSE](../LICENSE).
- README: [README.md](https://github.com/youtaya/dsh-plugins/blob/main/plugins/tool-usage/README.md) · Design contract: [docs/DESIGN.md](https://github.com/youtaya/dsh-plugins/blob/main/docs/DESIGN.md) · Security policy: [SECURITY.md](https://github.com/youtaya/dsh-plugins/blob/main/SECURITY.md).
