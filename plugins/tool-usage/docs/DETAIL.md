# Tool usage statistics

`dsh-plugin-tool-usage` keeps a readable record of every tool call an agent makes: what was called, with which arguments (redacted), how long it took, whether it succeeded, and which session it belongs to. It also aggregates call counts and latency per tool. Everything stays on the local machine.

## Features

- **Recording**: wraps `tools/execute` and records the tool name, redacted and truncated arguments, start time, duration, status (`ok` / `error` / `aborted` / `threw`), owning session, and call id — one JSONL line per call.
- **Explanation**: gives every call a deterministic Chinese or English summary, such as "Run shell command: pnpm test" or "Read file /tmp/a.ts (from line 1, up to 200 lines)", so a log line is understandable without the model's arguments.
- **Statistics**: per-tool and per-session call counts, errors, total latency, average/min/max/last latency, and slow-call counts. Aggregates live in memory; queries never scan the log.
- **Web UI dashboard**: in a Web or Desktop profile, a session-wide "Calls" / 「调用看板」 view tab shows totals, per-tool bars, a turn timeline, and recent calls, and a right-Sidebar "Calls stream" tab lists shell commands and tool calls live with a purpose line for each call. The browser half is a plain-JavaScript bundle declared through `dsh.client`; it reads a Host session projection and adds no build step.
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
- Host-side runtime imports are limited to `node:*` built-ins and `@deepseek-ai/dsh-tools`; the browser half requires only the loader-provided `react`, so no third-party runtime dependency is installed or bundled.
- Web / Desktop profiles get the slash command; a headless profile still records calls and exposes the `tool_usage` tool.
- Web / Desktop profiles also load the browser half (`dsh.client` + `client.js`). After upgrading the package, restart the profile and refresh the Web page once so the new client bundle is loaded; a headless profile renders no UI.

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

## Web UI dashboard

The package ships a browser half for Web / Desktop profiles: `client.js` is a hand-written plain-JavaScript module (no JSX, no TypeScript, no build step), declared in `package.json` as `dsh.client: { platform: "web", immediately: true, inject: [...] }` and served by the DSH Web client module system. It registers two entries on top of the host-side recording and statistics.

| Entry | Slot | Id | Order | Renders |
| --- | --- | --- | --- | --- |
| Session dashboard | `conversation.view` | `tool-usage-calls` | 20 | A conversation view tab labelled 「调用看板」/ "Calls": whole-session totals, per-tool table, turn timeline, recent calls. |
| Right-side live stream | `sidebar.right.pane.tab` (tab type `tool-usage-stream`) | `dsh-plugin-tool-usage-stream` | — | A right-Sidebar tab streaming a fixed-length newest-first list (latest 50) of shell commands and tool calls, with running calls pinned on top. |

### Where it renders

- **Right-side live stream.** A right-Sidebar tab opened automatically the first time the current Session starts running on a page load (a ref guard means closing it does not reopen it), and reopenable from the conversation-header 「调用流」 / "Calls" action or the right-Sidebar guide. Its body is a full-height column: a header with the live/idle state, `共 N 次调用`, and the current turn; then a scrollable fixed-length list capped at 50 rows, newest first, that shows a status dot, `HH:MM:SS`, tool badge, a labeled purpose line (`目的` / "Purpose"), the monospace shell command, duration, and turn. The purpose uses the Host explanation summary; when it is empty, the row falls back to a localized tool-class line (shell/read/write/edit/glob/grep/web/other). Running calls stay pinned at the top with a 500 ms ticking elapsed time. When the Host projection is unavailable (an older Host process or a profile without the unit), the tab falls back to the Chat data and derives the same rows from `useChat`'s running list and settled tool-result nodes, so the stream still updates live.
- **Session dashboard.** A scrollable conversation page with a header (title, subtitle, and the projection's `generatedAt` time), a responsive grid of metric cards (calls, failures and failure rate, total latency, average latency, slowest call, distinct tools, shell-command count, turns), a per-tool table (tool / calls / failures / average / slowest / share bar, sorted by calls descending, at most 20 tools), a turn timeline (newest first: turn, outcome, calls, failures, latency, start time; the open turn is highlighted), and a recent-calls list with `All` / `Failed` / `Shell` filters. With no projection or no calls yet, the tab shows an empty state instead of a table.

### What data it reads

The Host registers one session projection with key `toolUsage` and delivers it as whole-value JSON frames (view `v: 1`): `generatedAt`, `language`, `totals`, `byTool`, `turns`, `calls`, and `running`. The unit sets `wire.summary: false`, so the value is not carried in session-list summaries; the client reads it on demand through the framework's `useProjection` prop and receives a new object whenever a tool call starts or settles or a turn opens or closes. An older host without the unit (or a host with `uiEnabled: false`) yields `undefined`: the projection-backed dashboard then renders nothing and the view tab shows its empty state instead of failing, while the right-side stream falls back to the Chat data described below.

The lists are fixed, bounded shapes:

- `calls` contains settled calls only, ascending by end time, at most `uiRecentCalls` (default 60). Running calls are not in this list.
- `turns` contains the most recent turns, ascending, at most `uiRecentTurns` (default 30); `totals.turns` counts every observed turn and may exceed the listed rows.
- `byTool` is sorted by call count descending and capped at 20 tool rows.
- `running` lists currently running calls in start order and carries no duration; the right-side stream computes elapsed time from `startTime` on the client.

The right-Sidebar tab reads the same projection when present; its fallback mode reads only the standard `useChat` data the framework already exposes to session-scoped entries. The browser half never calls a Remote endpoint, never fetches, never reads another plugin's DOM, and only writes DOM through its own effect-owned elements and style sheet. No additional storage is introduced: the view lives in the Web page's memory for the displayed session.

### What the numbers mean

- **Totals** cover the whole session log (the projection folds the committed events from the Session's start): `calls` (started calls, settled + running), `settled`, `errors`, `running`, `totalMs` (sum of settled durations), `avgMs` (`totalMs / settled`, `0` when nothing settled), `maxMs` (slowest settled call), `tools` (distinct tool names), and `turns` (all observed turns, including turns whose calls may have left the window).
- **Turn rows** carry `turn`, `startTime`, `endTime` (`null` while open), `calls`, `errors`, `totalMs`, and an `outcome` of `open`, `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`, or `forked`. The card's pill and the timeline's status column use that outcome.
- **Call rows** carry `tool`, `summary`, `command`, `turn`, `step`, `startTime`, `endTime`, `durationMs`, `status`, and `error`. `status` is one of `ok` (the tool succeeded), `error` (the tool returned an error result or failed at the protocol level), or `aborted` (the caller cancelled). Failures are shown in the error colour; aborted calls are shown as cancelled.
- **Turn grouping.** Every `tool/call` carries its turn and step numbers, so calls are grouped by turn. A turn row opens on `turn/start` and closes on `turn/end`; its `calls`, `errors`, and `totalMs` are incremented as its calls settle. A call whose result never arrives is settled as `aborted` when its turn closes, so no dashboard row spins forever.
- **Timing.** Durations shown by the UI are derived from the committed session-event times (`startTime` / `endTime`) and rounded to 1 decimal; the recorder's own log durations use `performance.now()` deltas. Parallel calls overlap, so `totalMs` is the sum of individual durations and can exceed wall-clock time; `avgMs` is a per-call average, not throughput. A turn's `totalMs` is the sum of its settled call durations while `endTime - startTime` is its wall-clock span, so the two can differ when calls overlap.
- **Status and error text.** A failed call's `error` message is carried on the wire, clipped to `maxStringChars` and not key-redacted (it comes from the tool result), and is displayed in the call list; nothing is retried or recomputed in the browser.
- **Window versus totals.** The session dashboard's totals and failure rate reflect the whole session, but its call list, turn timeline, and per-tool table are built from the bounded projection lists. Older calls are still counted; they are simply not listed.

### Language and explanation behavior

- UI labels come from the client half's locale namespace (`tool-usage-ui`), registered with Chinese and English dictionaries and selected by the Web UI language; they are not taken from the plugin's `language` config.
- Call summaries are generated on the Host when the call is recorded, using the plugin's `language` (`zh` / `en`) and `explain` (`off` / `brief` / `detailed`) config. The dashboard shows the stored one-line `summary`; it does not translate or regenerate it.
- With `explain: off` the summary is empty and every view falls back to the tool name, while the call is still counted and listed. The `details` lines are record-only and never sent to the browser.
- Shell command lines exist for `bash` and its aliases and are truncated to `uiCommandChars` characters (default 240) with `…`; other tools have no command line.
- Sizes and times are formatted in the browser: durations under 1000 ms as `123ms`, otherwise as `1.2s`; timestamps as local `HH:MM:SS`.
- `uiEnabled: false` skips the projection registration; the session dashboard then renders nothing. The right-side stream keeps working from its Chat-data fallback (the same calls the conversation already renders). Recording, statistics, the model tool, and the slash command are unaffected.

### Privacy

The projection is folded on the Host from committed session events and is served over the existing local Web session channel; it adds no file, no network request, and no telemetry. Its wire payload contains only derived data — the one-line explanation summary, the truncated shell command line, statuses, durations, counts, and failure text — and never the recorded raw parameter object. The underlying redaction and truncation rules still apply to what a summary or command can reveal: redaction is key-name based, so a secret embedded in a command line can appear there, bounded by `uiCommandChars`; add `redactKeys`, tighten the caps, or set `uiEnabled: false` to stop the host projection (the right-side stream then only mirrors data the conversation already renders).

### Limitations

- The dashboard is **session-scoped and forward-looking**: it renders the current session's in-memory calls from the point the plugin loaded, does not replay the JSONL history, and starts empty after a plugin restart.
- The lists are bounded by `uiRecentCalls` / `uiRecentTurns` and the tool table by 20 rows; totals cover the whole session, but individual older calls are not listed.
- The turn card cannot switch the conversation view programmatically (the client API exposes no cross-plugin view switch); it points the user to the Calls tab instead.
- The right-side stream's elapsed times tick client-side, so they are approximate; its list is capped at 50 rows, newest first.
- Headless profiles have no UI, and a Web page keeps a previously loaded client bundle until it is refreshed, so an upgrade needs a restart plus a page refresh.
- The UI follows the harness theme and browser language; it does not add its own theme, font, or icon package.

## Configuration

Override by id `tool-usage` in the profile's `cordis.patch.yml` (a patch replaces the whole `config`; the plugin applies defaults to missing keys, so restate only what you change):

```yaml
- id: tool-usage
  config:
    language: en
    explain: brief
    slowThresholdMs: 10000
    uiRecentCalls: 120
    uiCommandChars: 160
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
| `uiEnabled` | `true` | Register the `toolUsage` session projection and render its Web UI dashboard entry; `false` leaves recording and statistics untouched (the right-side stream falls back to Chat data) |
| `uiRecentCalls` | `60` | Integer 1–500; number of most recent settled calls in the projection and the dashboard lists |
| `uiRecentTurns` | `30` | Integer 1–200; number of most recent turns in the projection and the dashboard timeline |
| `uiCommandChars` | `240` | Integer 1–1000; character cap for one shell command line carried to the UI (truncated with `…`) |

## Data and privacy

- Location: `$DSH_HOME/tool-usage/calls-YYYY-MM-DD.jsonl` (one file per local date) and `$DSH_HOME/tool-usage/stats.json`; `$DSH_HOME` defaults to `~/.dsh`.
- Permissions: directory `0o700`, files `0o600`; an existing daily log file with looser permissions is re-tightened to `0o600` once per process on its first append. `stats.json` is written atomically through a per-process unique temporary file (`stats.json.<pid>.<random>.tmp`) plus `rename`; it has last-writer-wins semantics, so it assumes a single DSH process per `$DSH_HOME` (the JSONL appends remain safe with concurrent writers).
- Writes stay inside `outputDir`; no network requests are made and data never leaves the machine.
- Redaction runs before arguments reach records or explanations. Redaction is key-name based, so secret text embedded in a value (for example `--token=...` in a command line) can still be recorded, and structural pair/array shapes (`headers: [["Authorization", "Bearer ..."]]`, `env: ["API_KEY=..."]`) are not inspected. Add `redactKeys`, tighten `maxStringChars` / `maxParamChars`, or use `outputDir: ""` / `persistCalls: false` to keep records in memory only.

## Performance and limitations

- Each call adds one microsecond-scale pure explanation, one O(1) in-memory aggregate update, and one queued asynchronous JSONL append; it never waits on disk or blocks the tool result.
- The Web UI projection adds one bounded derived view per session, recomputed only when a call starts or settles or a turn opens or closes. Its payload is capped by `uiRecentCalls`, `uiRecentTurns`, and the 20-row tool table, so it stays small regardless of session length.
- Aggregates are kept in memory, so statistics queries never scan the JSONL log; `stats.json` writes are debounced (2 s by default) and flushed on dispose.
- Memory is bounded for recorded data: aggregates are counters per tool/session, recent calls are capped at `recentLimit`, and each record field is capped (params, strings, failure messages, explanation summary/details). The one unbounded temporary structure is the queue of pending JSONL lines while the disk is stalled; each queued line is one bounded record and the queue drains when the write completes.
- Parallel calls overlap in time, so `totalMs` can exceed wall-clock elapsed time.
- The `recent` list is memory-only and empty after a restart; cross-restart history comes from the JSONL log.
- JSONL files are split by date but are not cleaned automatically; there is no retention or rotation policy.
- The dashboard is session-scoped, list-bounded, and does not read the JSONL history; see [Web UI dashboard](#web-ui-dashboard) for its own limitations.
- No Prometheus / OTLP export, no sampling, and no LLM-generated explanations.
- A failed write logs one warning and continues in memory; it never blocks a tool call. A failed output-directory creation is retried on a later write, so a transient failure does not disable persistence for the plugin lifetime.

## Repository and license

- Repository: <https://github.com/youtaya/dsh-plugins> — this package lives in `plugins/tool-usage`.
- License: MIT, copyright 2026 youtaya — see [LICENSE](../LICENSE).
- README: [README.md](https://github.com/youtaya/dsh-plugins/blob/main/plugins/tool-usage/README.md) · Design contract: [docs/DESIGN.md](https://github.com/youtaya/dsh-plugins/blob/main/docs/DESIGN.md) · Security policy: [SECURITY.md](https://github.com/youtaya/dsh-plugins/blob/main/SECURITY.md).
