# Design contract — `dsh-plugin-tool-usage`

Status: **authoritative** for the current implementation. Code, tests, and
documentation follow this file. If the implementation must deviate, update this
document in the same change and record why; do not let the contract drift
silently.

## 1. Product goal

`dsh-plugin-tool-usage` is a DeepSeek Harness (DSH) **bundle plugin** that
instruments every tool call made by an agent and provides:

1. **Recording** — the tool name and its redacted, truncated arguments are
   recorded for every tool invocation, together with start time, duration,
   outcome, call id, and owning session.
2. **Explanation** — every recorded call carries a deterministic, human-readable
   explanation of what the call does (`执行 Shell 命令：pnpm test`,
   `读取文件 /tmp/a.ts（第 1 行起，最多 200 行）`). A model-callable tool can also
   explain any currently registered tool and its parameters.
3. **Statistics** — per-tool call counts and latency aggregates (total / average
   / min / max / last), error counts, plus per-session and global scopes. Exposed
   through a model-callable `tool_usage` tool and a human `/tool-usage` slash
   command, and persisted so numbers survive a restart.
4. **Live Web UI** — a Host-registered session projection (`toolUsage`) pushes
   the current turn's running calls to the browser. The Web UI renders a
   per-turn dashboard card after a turn closes, contributes a session-wide
   「调用看板 / Calls」 conversation view tab, and adds a right-Sidebar
   「调用流 / Calls stream」 tab that lists shell commands and tool calls live.
   The UI is a read-only window onto the same fold; it registers no tool, prompt
   section, or model input.

Non-goals (v0.2): Prometheus/OTLP export, LLM-generated explanations, sampling,
retention policies, per-agent dashboards, programmatic view switching between
registered conversation tabs, and remote/network rendering.

Everything stays on the local machine: no network requests, no telemetry, no
model calls for recording or explanation.

## 2. Package layout

The package lives under `plugins/tool-usage/` in the
[dsh-plugins](https://github.com/youtaya/dsh-plugins) repository and is a normal
installable DSH bundle:

```
plugins/tool-usage/
  src/index.ts        plugin wiring: name/inject/apply, listeners, tool + command registration
  src/config.ts       hand-rolled config normalization, defaults, and validation warnings
  src/types.ts        shared interfaces (CallRecord, Explanation, snapshots, ...)
  src/redact.ts       pure argument redaction/truncation to lossless JSON
  src/explain.ts      pure deterministic tool-call explainer (zh/en, brief/detailed)
  src/stats.ts        pure in-memory aggregation store, snapshot queries, serialize/restore
  src/log.ts          durable JSONL call log + atomic stats snapshot, serialized async queue
  src/recorder.ts     tools/execute wrapper: timing, explain, stats.record, log.append
  src/warn.ts         shared warn-once diagnostics helper (one warning per failure class)
  src/tool.ts         model-callable `tool_usage` tool (defineTool)
  src/command.ts      optional human `/tool-usage` slash command
  src/projection.ts   `toolUsage` session projection: live, bounded wire view of calls
  client.js           hand-written Web client half (no build): turn card, dashboard tab, stream tab
  scripts/build.mjs   deterministic clean build (npm typescript, else DSH checkout)
  tsconfig.json
  cordis.patch.yml
  locale/{en,zh}.json
  docs/{DETAIL,DETAIL.zh}.md
  icon.svg
  tests/              node:test suite against the built lib/
  verification/       unit / E2E / live-activation reports and the E2E harness
```

Relative imports inside `src/` use explicit `.js` specifiers (for example
`import { x } from './stats.js'`) so the emitted `lib/**.js` runs under plain Node
ESM with no bundler or loader.

## 3. Package manifest

`package.json` highlights:

```json
{
  "name": "dsh-plugin-tool-usage",
  "version": "0.2.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "license": "MIT",
  "engines": { "dsh": ">=0.2.0-0 <0.3.0" },
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": "./client.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ]
    }
  }
}
```

Rules:

- Runtime imports are limited to `node:*` builtins and `@deepseek-ai/dsh-tools`
  (`defineTool` and types). `@deepseek-ai/cordis` and
  `@deepseek-ai/dsh-commands` are **type-only** imports, erased at build, so a
  headless profile without the command runtime still loads the plugin.
- **No third-party runtime dependency.** Configuration validation is hand-written
  in `src/config.ts`; explanation, redaction, and statistics are pure functions;
  logging uses `node:fs`. This keeps installs script-free and the supply-chain
  surface tiny.
- `lib/` is committed (prebuilt) so a clone/tarball install needs no build step
  and no build permission. Rebuild with `npm run build` whenever `src/` changes.
- `@deepseek-ai/*` packages appear in both `peerDependencies` (shared with the
  DSH host instance) and `devDependencies` (type checking and standalone tests).
- The client half is plain JavaScript (`client.js`) loaded through the Web
  module loader; it requires only the loader-provided `react` and declares no
  build step. `dsh.client` makes the installed bundle contribute its browser
  module; `./client` is the module entry.

## 4. Bundle patch

`cordis.patch.yml`:

```yaml
# Applied as this bundle's layer when a profile lists dsh-plugin-tool-usage.
# Defaults live in the plugin; override any of them by id `tool-usage` in your
# profile's cordis.patch.yml.
- insert:
    - id: tool-usage
      name: dsh-plugin-tool-usage
```

No `config` block: the patch stays minimal so a user override only restates the
keys it changes. The full configuration table is documented in the package
README.

## 5. Runtime contract

### 5.1 Plugin entry (`src/index.ts`)

```ts
export const name = 'tool-usage'
export const inject = ['tools']
export function apply(ctx: Context, rawConfig?: unknown): void
```

Behavior:

1. `resolveConfig(rawConfig, { logger })`; if `enabled === false`, log one info
   line and return. No recorder, tool, command, or writes.
2. Construct `StatsStore`, `JsonlCallLog`, and `ToolUsageRecorder`.
3. Restore aggregates without blocking plugin load:
   `void log.restoreStats().then(...)`; the store **merges** the snapshot into the
   live aggregates, so a call recorded while the read is in flight stays counted and
   the recent-calls ring is untouched. Failures only warn.
4. Wrap the dispatch waterfall:
   `ctx.on('tools/execute', (exec, next) => recorder.wrap(exec, next))`.
5. Register the model-facing `tool_usage` tool via `ctx.effect`, with a safe
   registered-schema lookup (`ctx.tools.get` in a try/catch).
6. Register the optional `/tool-usage` command through a **nested**
   `ctx.inject(['commands'], ...)`, so headless profiles without the `commands`
   service still load the plugin. The effect cleanup returns an async function that
   awaits `fiber.dispose()`, so a hot reload cannot overlap the old and new command
   registrations.
7. When `uiEnabled` is true, register the `toolUsage` session projection through
   another **nested** optional `ctx.inject(['sessionProjections'], ...)`, so a
   profile without the projection registry still loads the plugin. Registration
   and release are effect-scoped; failures warn instead of failing the load.
8. On dispose: flush the log queue and write the final statistics snapshot.

All listeners and registrations are effect-scoped, so a hot reload disposes the
previous instance cleanly (including a final flush) and a re-apply creates a
fresh store. Logging goes through `ctx.logger`; the plugin never uses `console.*`.

The projection is registered through a local structural face
(`SessionProjectionsFace`) rather than a type import of
`@deepseek-ai/dsh-session-projection`, preserving the zero-runtime-dependency
rule; the registration contract is covered by the projection unit tests.

### 5.3 Live UI projection (`src/projection.ts`)

`createToolUsageProjectionDefinition(config)` returns a projection unit for key
`toolUsage` (`stateVersion: 1`, `wire.summary: false`). It folds the committed
Session log; it does not observe `tools/execute`, does not write files, and does
not change any tool result. The unit is independent of the recorder: an event
that the recorder sees is also folded here, so a cancelled call settles as
`aborted` when its turn closes even though no result event landed.

Fold semantics:

- `turn/start` opens a turn row (`outcome: 'open'`, `endTime: null`).
- `tool/call` parses the raw arguments, **redacts** them, derives the one-line
  explanation (reusing `explain.ts` in `brief` mode; empty when `explain: 'off'`)
  and, for bash-family tools, the shell command line. It increments whole-session
  and per-tool call counts and opens a running row.
- `tool/result` pairs by `callId`, computes `durationMs` from event times, maps
  `ABORTED` / `ABORTED_BEFORE_DISPATCH` to `aborted`, other `isError` results to
  `error`, and everything else to `ok`. Failures also count in the tool/turn/total
  `errors` fields; aborted calls are tracked but not counted as failures.
- `turn/end` closes the turn row and settles any still-running call as `aborted`
  (no permanently spinning row).
- Any other event returns the same state reference, so the registry's
  `Object.is` gate skips all downstream work.

Bounds and privacy:

- Settled calls are a ring of `uiRecentCalls`; turn rows are a ring of
  `uiRecentTurns`; whole-session totals and per-tool aggregates cover the full
  log; the wire `byTool` table is the top 20 by call count.
- The wire view contains only derived `summary` text, the extracted shell
  command line (`uiCommandChars`), status/duration/turn identifiers, numbers, and
  — for failed calls only — the bounded failure text the recorder already writes
  locally (`maxStringChars`). Raw argument objects and redacted parameter objects
  never cross the wire.
- State is plain JSON because the projection cache checkpoints it; the fold is
  synchronous and deterministic.

### 5.4 Web client half (`client.js`)

`client.js` is hand-written plain JavaScript loaded through
`window.__ModuleLoader__.load` with factory id `dsh-plugin-tool-usage`. It
returns `{ inject: ['slots', 'locale'], apply(ctx) }` and registers, all inside
`ctx.effect`:

1. a per-turn dashboard card in `conversation.chat.turnTail` (id
   `tool-usage-summary`, order 5) after a turn closes: call/error counts, total
   and average duration, per-tool bars, shell-command count, and a collapsed
   call-detail list;
2. a session-wide dashboard in `conversation.view` (id `tool-usage-calls`,
   order 20, label `调用看板` / `Calls`): totals, per-tool table, turn timeline,
   and a filterable recent-call list;
3. a right-Sidebar tab type `tool-usage-stream` (implementation id
   `dsh-plugin-tool-usage-stream`, `multiple: false`, `keepMounted: true`) with
   its body in the keyed `sidebar.right.pane.tab`, a conversation-header action
   (id `tool-usage-stream`), and a guide entry. The body is a full-height,
   scrollable, fixed-length (latest 50) newest-first stream of shell commands
   and tool calls, with running calls pinned and a 500 ms elapsed tick. It is
   auto-opened once per page load when the current Session starts running, using
   a ref guard so a manual close is not undone. The right tab's registration and
   opener live behind an optional nested `ctx.inject(['sidebarRight',
   'sidebarRightTabs'], …)`, so a profile without the right Sidebar keeps the
   other two entries. When the Host projection is unavailable, the tab falls
   back to standard `useChat` data (running calls and settled `tool-result`
   nodes) and derives the same rows locally. This fallback also covers
   `uiEnabled: false`: the other two surfaces render nothing, while the stream
   keeps showing what the conversation already renders.

The components read the projection only through standard props
(`useProjection('toolUsage', selector)`); they never fold Session events and
never call the Host. They register a `tool-usage-ui` locale namespace with
complete zh/en dictionaries and use only `--dsw-alias-*` theme tokens for color.
The client half requires no module other than the loader-provided `react`; it
adds no tool, prompt section, or service.

### 5.2 Recording (`src/recorder.ts`)

For every `tools/execute` invocation:

- Capture `startedAt = new Date()` and `t0 = performance.now()` before `next()`.
- Await `next()` once; capture the normalized `ToolExecutionResult`.
- In every outcome (including a rejected `next()`), compute
  `durationMs = round(performance.now() - t0, 1)`, build a `CallRecord`, update
  the in-memory aggregates, append to the JSONL log (fire-and-forget), and
  schedule a statistics snapshot.
- **The wrapper never changes the tool result, `exec.signal`, or call identity.**
  The result object is returned as-is and a rejection is rethrown unchanged.
- Explanation and recording run on the **redacted** arguments.
- **Record size is bounded.** Arguments are capped by `maxStringChars` /
  `maxParamChars`, the explanation `summary` at 2,000 characters and `details` at
  50 lines / 8,000 characters, and a failure `error.message`/`error.code` at
  `maxStringChars`. Failure text is recorded up to that cap and is **not**
  key-redacted (it comes from the tool result, not from the argument object).
- Recording is best-effort: a stats/log/explain/schema failure is reported once
  per failure class and never affects the caller's result.

Status mapping:

| Status | Meaning |
| --- | --- |
| `ok` | `isError === false` |
| `error` | `isError === true`, error code is not an abort |
| `aborted` | error code `ABORTED` or `ABORTED_BEFORE_DISPATCH` |
| `threw` | `next()` threw/rejected (protocol-level failure) |

## 6. Record format

One `CallRecord` per call, one JSON object per line in the JSONL log:

```ts
interface CallRecord {
  v: 1                        // record format version
  seq: number                 // monotonically increasing per plugin lifetime
  at: string                  // ISO-8601 call start time
  tool: string                // tool name
  callId?: string             // execution call id when present
  sessionId?: string          // exec.agent?.id when present
  durationMs: number          // rounded to 1 decimal
  status: 'ok' | 'error' | 'aborted' | 'threw'
  params?: JsonValue          // redacted + truncated arguments; always present
                              // (empty arguments serialize as {})
  paramsTruncated: boolean    // any string/array/depth/whole-params cut
  redacted: boolean           // at least one value replaced by [REDACTED]
  explanation: { summary: string; details?: string[] }
  error?: { message: string; code?: string }  // message/code capped at maxStringChars,
                                              // not key-redacted
}
```

## 7. Configuration (`src/config.ts`)

Raw Cordis config is `unknown`; it is normalized with defaults, unknown keys are
tolerated, and invalid values warn once instead of failing the load.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` logs one line and registers nothing. |
| `outputDir` | `"$DSH_HOME/tool-usage"` | Data directory; expands a leading `~` and `$DSH_HOME` and resolves to an absolute path. `""` disables persistence. |
| `persistCalls` | `true` | Append records to `calls-YYYY-MM-DD.jsonl`. |
| `persistStats` | `true` | Write the aggregate snapshot to `stats.json`. |
| `restoreStats` | `true` | Restore aggregates on startup; needs `persistStats: true`. |
| `explain` | `"detailed"` | `off` / `brief` / `detailed`. |
| `language` | `"zh"` | `zh` / `en` for explanations and reports. |
| `maxParamChars` | `500` | Character cap on the whole serialized parameter JSON (1–10,000,000). Above it the value becomes a `{ "_truncated": … }` preview that fits the cap; the preview envelope needs 18 characters, so smaller caps are raised to that floor. |
| `maxStringChars` | `200` | Character cap on one string value and on failure `error.message`/`error.code` text (1–1,000,000). |
| `redactKeys` | built-in `SENSITIVE_KEYS` | Additional sensitive key stems; matching is case-insensitive and ignores `-`, `_`, `.`, and whitespace; built-ins cannot be removed. |
| `recentLimit` | `200` | In-memory recent-calls ring-buffer capacity. |
| `slowThresholdMs` | `5000` | Slow-call threshold for `slowCalls` / `slow` markers. |
| `toolName` | `"tool_usage"` | Model tool name. |
| `commandName` | `"tool-usage"` | Slash-command name without `/`; lowercased, leading `/` stripped, must match `[a-z][a-z0-9_-]*`. |
| `statsWriteDebounceMs` | `2000` | Debounce for `stats.json` writes; disposal flushes immediately. |
| `includeParamsInReport` | `true` | Include redacted parameters in the `recent[]` entries of the canonical snapshot returned by the tool/command; the Markdown renderers never show parameters. |
| `uiEnabled` | `true` | Register the client-facing `toolUsage` session projection. `false` keeps the recorder/tool/command and makes the two projection-backed UI surfaces render nothing; the right-side stream falls back to Chat data. |
| `uiRecentCalls` | `60` | Recent settled calls carried in the projection wire view (1–500). Whole-session totals are unaffected. |
| `uiRecentTurns` | `30` | Recent turn rows carried in the projection wire view (1–200). `totals.turns` still counts every observed turn. |
| `uiCommandChars` | `240` | Character cap on the shell command line carried in the projection wire view (1–1000), ellipsized. |

Validation semantics: type errors fall back to the default, numeric values are
truncated and clamped into range, enum values are case-insensitive, and
`outputDir: ""` forces both persist flags off. `$DSH_HOME` comes from
`process.env.DSH_HOME` (trimmed), else `~/.dsh`.

## 8. Redaction and truncation (`src/redact.ts`)

Output must always be lossless JSON.

- Non-JSON values become `"[unserializable]"` (`undefined`, functions, symbols,
  class instances, circular references, `NaN`, `±Infinity`); `bigint` becomes a
  decimal string.
- **Key matching:** a key is sensitive when its normalized form (lowercase; `-`,
  `_`, `.`, and whitespace stripped) **contains** any configured sensitive stem.
  Matched values become `"[REDACTED]"` and set `redacted = true`. An own
  `__proto__` key is preserved as an ordinary own data property and never mutates
  the result's prototype.
- Built-in sensitive stems: `token`, `password`, `passwd`, `secret`, `apikey`,
  `authorization`, `cookie`, `credential`, `privatekey`, `accesskey`,
  `secretkey`, `clientsecret`, `sessiontoken`.
- Strings longer than `maxStringChars` are cut to `maxStringChars - 1` characters
  plus `…`. Arrays over 50 items are cut with a trailing
  `"[… N more items]"`. Nesting deeper than 6 levels becomes `"[deep]"`.
- The whole serialized parameter object is capped by `maxParamChars`; when
  exceeded it is replaced with a `{ "_truncated": "<prefix>…" }` preview that fits
  within the cap (the envelope needs at least 18 characters, so smaller configured
  caps are raised to that floor). Any cut sets `paramsTruncated`.
- Redaction is **key-name based**. A secret embedded in a value (for example
  `--token=...` inside a command line) can still be recorded, and structural
  pair/array shapes (`headers: [["Authorization", "Bearer ..."]]`,
  `env: ["API_KEY=..."]`) are not inspected because only object keys are matched.
  Both are documented limitations; users can extend `redactKeys`, tighten caps, or
  disable persistence.

## 9. Explanation (`src/explain.ts`)

`explainToolCall(tool, args, schema, options)` is a pure function: no I/O, no
clock, no model call. The same input always produces the same text. Safe for any
input.

- `level: 'brief'` produces `summary` only; `'detailed'` also adds the registered
  tool description and a per-parameter line to `details`; `off` is handled by the
  recorder (empty summary).
- `language: 'zh' | 'en'` selects phrasing.
- **Output size is bounded:** `summary` is capped at `MAX_SUMMARY_CHARS` (2,000
  characters, one line), `details` at `MAX_DETAIL_LINES` (50) and
  `MAX_DETAIL_CHARS` (8,000 characters including newline separators), and the
  registered tool/parameter descriptions are clipped with the per-value cap.
  Excess detail lines/characters are dropped (not marked).
- Built-in phrasings cover `bash`, `read`, `write`, `edit`, `glob`, `grep`,
  `web_search`, `web_fetch`, `read_image`, `todo_write`, `subagent`,
  `subagent_fork`, `workflow`, `working_directory`, `ask_user_question`,
  `job_output`, `job_kill`, and `job_list`, reading arguments defensively.
- Tool-name resolution: exact name first, then a small alias map
  (`shell`→`bash`, `read_file`/`readfile`→`read`, `write_file`/`writefile`→`write`,
  `edit_file`/`editfile`→`edit`, `search_web`/`websearch`→`web_search`,
  `fetch_url`/`webfetch`→`web_fetch`, `todo`/`todos`→`todo_write`), then the last
  namespace segment (`mcp__server__bash`, `functions.read`). Hyphens are normalized
  to `_` before matching, so hyphenated variants resolve too. No character-prefix
  matching: `bash2` stays on the generic fallback.
- Unknown tools fall back to `Call tool <name>: <compact params>` (en) or
  `调用工具 <name>：<参数摘要>` (zh), with values JSON-stringified and clipped to
  `maxValueChars`.
- `summary` is always a single line; `details` may contain newlines.

## 10. Statistics (`src/stats.ts`)

`StatsStore` keeps aggregates in memory; queries never scan the JSONL log.

- Per tool: `calls`, `errors` (status `error` or `threw`; `aborted` is not a
  failure), `errorRate` (4 decimals), `totalMs`, `avgMs`, `minMs`, `maxMs`,
  `lastMs`, `lastAt`, `slowCalls`, and persisted `statusCounts`.
- Totals: `calls`, `errors`, `totalMs`, `avgMs`, `maxMs`, `slowCalls`,
  `sessionCount`.
- **Scope:** `session` filters by `exec.agent?.id`; `all` spans every recorded
  session. Calls without a session id live in a no-session bucket: included in
  `all` and selected by `session` only when the caller itself has no session id.
  `sessionCount` is `1` for a selected session scope (the no-session bucket
  included) and the number of distinct session ids for `all` (the no-session
  bucket excluded).
- **Slow calls:** `durationMs >= slowThresholdMs`.
- **Recent calls:** a ring buffer of `recentLimit`, returned newest first and
  capped by the query `limit` (1–100 for the tool).
- **Parallel calls overlap:** durations are `performance.now()` deltas, so
  `totalMs` can exceed wall-clock elapsed time and `avgMs` is a per-call average,
  not throughput.
- Milliseconds in snapshots are rounded to 1 decimal.

Canonical snapshot JSON:

```ts
{
  generatedAt: string
  scope: { kind: 'session' | 'all'; sessionId?: string }
  totals: { calls, errors, totalMs, avgMs, maxMs, slowCalls, sessionCount }
  tools: Array<{ name, calls, errors, errorRate, totalMs, avgMs, minMs, maxMs, lastMs, lastAt, slowCalls }>
  recent: Array<{ seq, at, tool, durationMs, status, slow, explanation, params?, sessionId? }>
}
```

Tool rows are sorted by call count descending, then by name using code-point
comparison (deterministic on every host, unlike locale-dependent collation).

`PersistedStats` is `{ v: 1, updatedAt, totals, byTool, bySession, sessionCount }`
(no recent calls: the JSONL log is the source of history). `restore` validates
defensively and ignores malformed shapes, then **merges additively** into the live
store: totals are added, per-tool `min`/`max`/`last` are combined, and the
recent-calls ring is left untouched. Calls recorded while the asynchronous restore
is in flight are therefore preserved. Because the merge is additive, `restore` is
called once per snapshot; restoring the same snapshot twice adds it twice.

## 11. Storage (`src/log.ts`)

Files under `outputDir`:

- `calls-YYYY-MM-DD.jsonl` — one append-only file per local date, one record per
  line.
- `stats.json` — aggregate snapshot, written atomically through a per-process
  unique temporary file (`stats.json.<pid>.<random>.tmp` + `rename`; the temporary
  file is removed if the write fails).

Semantics:

- Directories are created with `0o700`; files are created with `0o600`. An existing
  daily log file that is looser (for example an old `0644` file) is re-tightened to
  `0o600` once per process on its first append (best-effort).
- Appends go through a promise chain: ordered, non-blocking, never throw; failures
  log once and the queue continues.
- `stats.json` writes are debounced; disposal flushes pending appends and the
  snapshot, then marks the log closed (later appends are dropped).
- `stats.json` is a single aggregate snapshot with last-writer-wins semantics, so it
  assumes one DSH process per `$DSH_HOME`; the append-only JSONL log remains safe
  with concurrent writers.
- A failed `mkdir` is not cached: a later write retries directory creation, while the
  warning stays one per failure class.
- `restoreStats` returns `undefined` for `ENOENT` or malformed JSON.
- The plugin writes nowhere outside `outputDir` and makes no network requests.

## 12. Model-facing tool `tool_usage` (`src/tool.ts`)

Read-only tool registered for every agent (`isConcurrencySafe: () => true`).

| Parameter | Type | Values | Notes |
| --- | --- | --- | --- |
| `view` | string | `summary` / `tools` / `recent` / `explain` | Defaults to `summary`. |
| `tool` | string | tool name | Required for `explain`; optional filter otherwise. |
| `scope` | string | `session` / `all` | Defaults to `session`. |
| `limit` | integer | 1–100 | Max recent calls; defaults to 20; clamped. |

The output value is the canonical snapshot JSON (or explain JSON). `render`
produces compact Markdown in `language`, for example:

```markdown
Tool call statistics (scope: current session)

Totals: 12 calls / 1 failed / 3.2s total / 267ms avg / 1.4s slowest

| Tool | Calls | Errors | Avg | Slowest | Last |
| --- | --- | --- | --- | --- | --- |
| bash | 8 | 0 | 210ms | 1.4s | 12:31:05 |
| read | 3 | 1 | 400ms | 620ms | 12:30:58 |

Recent calls:
1. [12:31:05] bash — Run shell command: pnpm test (1.4s)
```

`summary` includes both sections; `tools` keeps the header, totals, and table;
`recent` keeps the header, totals, and recent list; `explain` returns the target
tool's registered description and parameter table. For an unknown or unregistered
tool, `execute` throws; the DSH executor converts that into a normal tool-error
(`isError`) result, so the process does not crash and README-level behavior is a
tool error.

## 13. Slash command `/tool-usage` (`src/command.ts`)

Registered only when the `commands` service exists (Web/Desktop profiles).
Headless profiles simply have no command; recording, statistics, and the model
tool still work.

| Command | Behavior |
| --- | --- |
| `/tool-usage` | Current-session summary (totals, per-tool table, recent calls). |
| `/tool-usage all` | Summary across all sessions. |
| `/tool-usage recent [N]` | The N most recent current-session calls; default 10, clamped 1–100. |
| `/tool-usage reset` | Clear statistics for all sessions and rewrite `stats.json` from the cleared state (a pending pre-reset snapshot is replaced), so a restart does not restore pre-reset counts; the persisted JSONL is untouched. |
| Anything else | Error plus usage text. |

The command output uses the same Markdown renderer as the model tool.

## 14. Build

`npm run build` runs `scripts/build.mjs`:

1. Locate a TypeScript compiler: local `node_modules/typescript` (npm dev
   dependencies) first, else the `DSH_CHECKOUT` DSH source checkout. The checkout
   fallback also ensures dev-only `node_modules` symlinks for
   `@deepseek-ai/{cordis,dsh-tools,dsh-commands}` and `@types/node` (idempotent;
   recreate broken links).
2. Remove `lib/` first so the output tree is exact.
3. Run `tsc -p tsconfig.json` with `noEmitOnError`.
4. Assert `lib/index.js` and `lib/types/index.d.ts` exist, then print a one-line
   summary.

`tsconfig.json`: `target es2024`, `module esnext`, `moduleResolution bundler`,
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`declaration: true`, `declarationDir: "lib/types"`, `noEmitOnError: true`,
`declarationMap: false`, `sourceMap: false`, `outDir: lib`, `rootDir: src`,
`skipLibCheck: true`, `types: ["node"]`, `include: ["src/**/*.ts"]`.

`lib/types/index.d.ts` must exist because `package.json#types` points there;
without `declarationDir`, tsc would emit `lib/index.d.ts` instead.

`client.js` is deliberately outside this build: it is committed plain
JavaScript, syntax-checked by the test suite and served directly by the Web
module loader. `npm pack --dry-run` and the package tests assert that it exists,
parses, and is listed in `files`.

## 15. Tests

`node --test 'tests/*.test.mjs'` from the package directory (`node:test` and
`node:assert/strict` only). Tests import the **built** `lib/` ESM files, never
`src/` through a transpiler. Required coverage:

1. `redact` — sensitive-key families, case-insensitive normalized matching,
   nested objects/arrays, string/array/depth caps, circular and non-JSON input,
   lossless JSON, `redacted`/`truncated` flags.
2. `explain` — zh and en for the special-cased tools, brief vs detailed, unknown
   argument shapes, single-line summary, schema description included when
   detailed.
3. `stats` — counts/errors/total/min/max/avg, session vs all scope, recent order
   and limit, params/explanation inclusion, serialize→restore round-trip,
   additive restore after a live record (race), deterministic tie-break, reset,
   malformed restore ignored.
4. `log` — ordered one-JSON-line appends, temp output directory, created
   `0o700`/`0o600` modes and re-tightening of a pre-existing `0o644` file,
   parseable `stats.json` written through a unique temporary file (no leftovers,
   concurrent writers), restore round-trip, no throw on an unwritable directory,
   retry after a transient `mkdir` failure, dispose drops later appends.
5. `recorder` — status `ok`/`error`/`aborted`/`threw`, result identity preserved,
   recording never throws, both sessions counted.
6. `plugin` (integration, fake Cordis context) — registration, tool execution,
   listener recording, disabled config, optional command registration, disposal
   flush.
7. `package` (static) — `dsh.bundle.patch`, `main` exists, `engines.dsh` admits
   the supported DSH version, patch inserts the expected row, locale files parse,
   every `files` entry exists, the `dsh.client` block and `./client` export are
   present, and `client.js` parses as plain JavaScript with `react` as its only
   module-table require.
8. `projection` — turn grouping, call/report pairing, `ok`/`error`/`aborted`
   mapping, turn-end settling of unsettled calls, whole-session vs bounded-ring
   totals, top-20 tool rows, redaction/non-leakage of argument values, explain
   off, command clipping, JSON-serializable state, and identity-preserving
   unknown events.
9. `client` (browser module, stub React) — the module-loader registration shape,
   the three slot entries and ids/orders/locale namespace, and rendered output
   (live command, per-turn counts, dashboard totals) against synthetic
   projection frames.

## 16. End-to-end verification

The package ships a reusable harness,
`verification/e2e/setup-and-run.mjs`, that proves the plugin in a real DSH
process without touching the live `~/.dsh`:

1. Use an isolated home (`.e2e-home/`, gitignored) recreated from scratch.
2. Initialize the shipped headless profile, install the bundle with
   `dsh plugin --profile headless add <abs path>`, and prove the layer with
   `--dump-config`.
3. Run a one-shot headless task that calls `bash` and then `tool_usage`, and
   assert the JSONL record, explanation, status, `stats.json`, and rendered
   output.
4. Assert the failure path with a genuine `isError` result (for example `read` of
   a missing file). On this DSH a non-zero bash exit is a normal `ok` result, not
   an infrastructure error.
5. Credentials are read in-process from `~/.dsh/.credentials.yaml` and passed to
   child processes only through the environment; they are never printed or
   written to the workspace.

Host note recorded from the actual run: when the harness itself runs inside a
sandboxed agent session, a child DSH cannot start a nested `sandbox-exec` and
fails closed with `SANDBOX_UNAVAILABLE`. Run the one-shot task with
`DSH_PERMISSION_MODE=danger-full-access` (the outer workspace sandbox still
confines it); this is an environment constraint, not a plugin defect.

The Web UI packaging path has its own reusable check,
`verification/ui-boot.mjs`. It creates an isolated `web` profile, installs the
bundle, boots the real Web server on a loopback port, reads the boot graph the
server serves, and downloads the client bundle URL it advertises. It asserts
that the `dsh-plugin-tool-usage` entry is present with `immediately: true`, the
declared inject edges, and a `./client` URL whose body is the package's client
half registering all three slots. It needs `DSH_CHECKOUT` and `pnpm` but no model
credentials, and it removes its isolated home and package stores afterwards. It
does not replace browser-level visual verification of layout, theme, or
interaction.

## 17. Compatibility and versioning

- `engines.dsh: ">=0.2.0-0 <0.3.0"` is declared and enforced by DSH at install
  and startup. DSH evaluates it with semver `includePrerelease: true`, so alpha
  builds such as `0.2.2-alpha.2` are admitted.
- `@deepseek-ai/dsh-tools`, `-commands`, and `cordis` peer ranges follow the same
  compatible release line.
- The plugin version follows Semantic Versioning; record-format changes bump
  `v` in `CallRecord`, and projection shape changes bump
  `TOOL_USAGE_PROJECTION_STATE_VERSION`; both are documented in `CHANGELOG.md`.
- `0.2.0` adds the Web client half and the `toolUsage` projection. Existing
  configs and records remain valid; a page refresh is required after upgrading a
  running Web profile so the new browser module is loaded.
- The `lib/` output is committed and CI checks it matches a fresh build, so a
  clone is always installable without a build step.

## 18. Privacy and threat model

The plugin is local-only instrumentation; the full user-facing statement lives in
`SECURITY.md` and the package README. The design guarantees:

- Writes are confined to `outputDir`, with `0o700` directories and `0o600` files;
  pre-existing daily log files with looser permissions are re-tightened once per process.
- No network access, no telemetry, no model calls.
- Arguments are redacted and truncated before any record or explanation is built.
- Recording never changes a tool result or affects the caller's outcome.
- The JSONL log is append-only with no automatic rotation; operators own its
  lifecycle.

Redaction is key-name based by design; value-embedded secrets and structural
pair/array shapes (`headers: [["Authorization", "Bearer ..."]]`,
`env: ["API_KEY=..."]`) are documented limitations, mitigated by `redactKeys`,
tighter caps, or disabling persistence. Failure `error.message`/`error.code` text is
recorded up to `maxStringChars` and is not key-redacted.

The Web UI widens the exposure surface only with derived data. The `toolUsage`
projection is folded from committed Session events, and its wire view carries the
redacted-argument-derived explanation summary, the extracted bash command line
(already visible in the chat transcript), status/duration/turn identifiers, and
aggregates. It does not carry raw argument objects or redacted parameter objects;
for a failed call it carries the same bounded failure text the recorder already
writes to its local log (`maxStringChars`). The browser module has no network
access and no Host RPC; it reads the projection only. `uiEnabled: false` removes
the projection entirely, leaving the previous host-only behavior: the live
strip, per-turn card, and session dashboard render nothing, while the right-side
stream falls back to Chat data (the calls the conversation already renders) and
sends nothing new off the machine.

## 19. Change process

1. Behavior changes update this document first (or in the same change), then the
   implementation, tests, and bilingual package docs.
2. `src/` changes rebuild `lib/` and include the output in the same commit.
3. Run `npm run verify` from the repository root and `npm run check:public`
   before opening a pull request.
4. Verification evidence under `plugins/*/verification/` is refreshed when the
   behavior it proves changes; never fabricate or hand-edit results.

## 20. Web UI view contract (appendix)

The projection wire view is the single interface between the Host fold and the
browser half. It is whole-value JSON, pushed by the session-projection seam;
`undefined` means the Host has no registered `toolUsage` unit (or the session has
no baseline yet), and every client component must render nothing (or the view
tab's empty state) in that case.

```ts
interface ToolUsageView {
  v: 1
  generatedAt: number              // epoch ms of the last folded event; 0 when empty
  language: 'zh' | 'en'
  totals: {
    calls: number                  // started (settled + running)
    settled: number
    errors: number                 // status === 'error' (aborted is not a failure)
    running: number
    totalMs: number
    avgMs: number                  // totalMs / settled, 0 when settled === 0
    maxMs: number
    tools: number                  // distinct tools over the whole session
    turns: number                  // turns observed over the whole session
  }
  byTool: Array<{                  // top 20 by calls, then name
    tool: string
    calls: number
    errors: number
    totalMs: number
    avgMs: number
    maxMs: number
    lastMs: number
    lastAt: number
  }>
  turns: Array<{                   // most recent uiRecentTurns, ascending
    turn: number
    startTime: number
    endTime: number | null         // null while open
    calls: number
    errors: number
    totalMs: number
    outcome: 'open' | 'completed' | 'aborted' | 'blocked' | 'error'
      | 'max-tokens' | 'interrupted' | 'forked'
  }>
  calls: Array<{                   // most recent uiRecentCalls, ascending by endTime
    callId: string
    tool: string
    summary: string                // '' when explain: 'off'
    command: string | null         // bash-family command line, capped by uiCommandChars
    turn: number
    step: number
    startTime: number
    endTime: number
    durationMs: number
    status: 'ok' | 'error' | 'aborted'
    error: string | null           // bounded failure text for 'error'
  }>
  running: Array<{                 // start order
    callId: string
    tool: string
    summary: string
    command: string | null
    turn: number
    step: number
    startTime: number
  }>
}
```

UI behavior contract:

- **Turn card** (`conversation.chat.turnTail`, id `tool-usage-summary`): rendered
  after the owning turn closes and only when that turn made calls. It shows the
  outcome, call/error counts, total and average duration, top-five tool bars, the
  shell-command count, and a collapsed `查看 N 次调用明细` list. It points the
  reader at the session dashboard tab; it does not switch views itself (the
  Client API exposes no cross-plugin view selection).
- **Dashboard tab** (`conversation.view`, id `tool-usage-calls`, label
  `调用看板` / `Calls`): session-wide metric cards, per-tool table with share
  bars, recent turn timeline, and a recent-call list filterable by
  `全部 / 失败 / Shell`.
- **Right-side stream** (`sidebar.right.pane.tab`, tab kind `tool-usage-stream`,
  id `dsh-plugin-tool-usage-stream`): opened automatically once per Session per
  page load when the Session starts running, and reopenable from the
  conversation-header 「调用流」 / "Calls" action or the right-Sidebar guide. A
  full-height header plus a scrollable fixed-length list (50 rows, newest first)
  of status, time, tool, explanation, shell command, duration, and turn; running
  calls stay pinned with a ticking elapsed time. When the Host projection is
  missing, the body derives rows from `useChat` (legacy running calls + settled
  tool-result nodes) instead of failing.
- All three use the `tool-usage-ui` locale namespace (complete `zh` + `en`) and
  `--dsw-alias-*` theme tokens for color; no other Client package is imported
  at runtime beyond the loader-provided React.
- Bounded lists mean a very long session shows aggregate totals for the whole
  log while call/turn detail covers the recent window; the turn card notes when
  older calls were omitted.
