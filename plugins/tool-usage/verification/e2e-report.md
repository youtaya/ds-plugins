# E2E verification report — `dsh-plugin-tool-usage`

Status: **PASS** — the final build re-run on 2026-10-29 passed **23/23 assertions**
(§11); the earlier pre-fix run history is retained below and in §3.

Verified inside a real DSH process (source checkout, headless profile) with a fully
isolated `DSH_HOME`. The plugin was not modified during E2E; every FAIL below has a
root cause in the host environment, not in the plugin, and is resolved or explicitly
explained.

> **Evidence scope (2026-10-29):** the pre-fix build was verified on 2026-10-28 (sections
> §3–§10 below, quoted exactly as collected). After the review fixes (bounded
> failure/explanation text, additive statistics restore, log-file permission tightening,
> unique `stats.json` temp file, persisted `/tool-usage reset`) the full harness was re-run
> on the final build on 2026-10-29 and passed **23/23 assertions** with no retry. That run
> is the authoritative model-backed evidence for the shipped `lib/` and is documented with
> its sanitized artifacts in **§11** and `verification/e2e/artifacts/final/final-build-2026-10-29/`.

- Date: 2026-10-28 (Asia/Shanghai); harness/evidence re-checked 2026-10-29 after
  release sanitization
- Node: `v24.19.0`, platform: `darwin arm64`
- DSH checkout: `<dsh-checkout>` (DSH `0.2.2-alpha.2`, source execution; its vendored
  `@deepseek-ai/cordis` is `4.0.6-alpha.1`)
- Plugin under test: `plugins/tool-usage` (`dsh-plugin-tool-usage` 0.1.0), `lib/` built
  2026-10-28T09:04:57.668Z (rebuilt byte-identically from a clean `npm install` tree on
  2026-10-29, see `unit-report.md` §1.1)
- Isolated home: an isolated `<e2e-home>` directory inside the workspace (live `~/.dsh`
  and the running Web server untouched)
- Scratch agent workspace: `<e2e-home>/workspace`
- Harness: `plugins/tool-usage/verification/e2e/setup-and-run.mjs` (+ `run-error-case.mjs`
  wrapper)

> Sanitization: every machine-specific absolute path in this report and in the retained
> artifacts is replaced by a placeholder — `<workspace>` (the `ds-plugins` checkout),
> `<dsh-checkout>` (the DSH source checkout) and `<e2e-home>` (the isolated `DSH_HOME`).
> Only path strings were changed; run outcomes and numbers are unmodified.

## 1. Exact commands (no secrets)

Everything is driven by the harness; it resolves the workspace, checkout and built bundle,
recreates the isolated home, boots/installs/runs, asserts, and prints PASS/FAIL.
`DSH_CHECKOUT` is required (there is no machine-specific default in the harness).

```bash
cd <workspace>
export DSH_CHECKOUT=<dsh-checkout>

# Full verification (2 LLM runs: main task + failure case)
node plugins/tool-usage/verification/e2e/setup-and-run.mjs

# What actually produced the passing evidence (retry after the environment fix):
node plugins/tool-usage/verification/e2e/setup-and-run.mjs --keep-home --skip-error

# Loadability proof only, no credentials / no LLM run:
node plugins/tool-usage/verification/e2e/setup-and-run.mjs --no-llm

# Failure path only (1 LLM run, reuses the isolated home):
node plugins/tool-usage/verification/e2e/run-error-case.mjs
```

Underlying DSH commands the harness executes (useful for manual reproduction):

```bash
cd <dsh-checkout>
export DSH_HOME=<e2e-home>

pnpm dsh --profile headless --help                       # initializes the shipped headless profile
pnpm dsh plugin --profile headless add \
  <workspace>/plugins/tool-usage
pnpm dsh --profile headless --dump-config                # layer proof

# one-shot task (harness runs the same CLI directly from <e2e-home>/workspace,
# with DSH_PERMISSION_MODE=danger-full-access and DEEPSEEK_API_KEY in the env):
node --import <dsh-checkout>/node_modules/.pnpm/tsx@*/node_modules/tsx/dist/esm/index.mjs \
  <dsh-checkout>/apps/cli/src/bin.ts --profile headless "<task>"
```

The harness reads `DEEPSEEK_API_KEY` from `~/.dsh/.credentials.yaml` **in-process** and
hands it to child processes only through the environment. It is never printed and never
written to a file. Independent audit: the key value appears in **0** files under the
workspace (excluding `node_modules`/`.pnpm-store`), and the only runtime log copies kept in
the repository are the sanitized files under `verification/e2e/artifacts/final/`.

## 2. Permission-mode configuration (environment fact)

The e2e headless tasks run with `DSH_PERMISSION_MODE=danger-full-access` by default
(override with `E2E_PERMISSION_MODE`). This is required because the harness itself runs
inside a sandboxed DSH agent session:

- The outer session is already confined (`workspace-write` via `sandbox-exec`).
- The child DSH then tries to start **nested** `sandbox-exec` for its own `bash` tool.
  That is not permitted on this host, so a default `workspace-write` bash call fails
  closed with:

  ```
  SANDBOX_UNAVAILABLE: sandbox mode "workspace-write" is requested but no sandbox
  backend is usable on this host; refusing to run the command unconfined.
  Runner failure: sandbox-exec: sandbox_apply: Operation not permitted
  ```

- With `danger-full-access` the child's bash tool runs unconfined *inside* the outer
  OS-level workspace sandbox; no approval channel is needed. The e2e commands are
  fixed and side-effect-free (`echo hello-tool-usage`, `exit 3`, reading a nonexistent
  path) and the DSH home is isolated, so this is safe for verification.
- This is a host/nesting limitation, **not a plugin defect**. The failed first attempt
  under default `workspace-write` is the only reason for the retry; its intermediate
  artifact tree was removed from the release tree during evidence sanitization (see §8).

## 3. Pre-fix run history (3 model-backed runs, 2026-10-28)

| Run | LLM run | Config | Task | Result |
| --- | --- | --- | --- | --- |
| A | 1 | default `workspace-write` | main: `bash echo hello-tool-usage` + `tool_usage summary` | 9/10 main assertions PASS; only `LOG-2` (bash status `ok`) failed because the sandbox backend was unavailable — environment |
| B | 2 | default `workspace-write` | failure case: `read` nonexistent path + `bash exit 3` | 6/6 failure-path assertions PASS (`RUN-2`, `ERR-1..5`) |
| C | 3 | `danger-full-access` | main task retried on the same isolated home | **16/16 PASS** (setup + main assertions), bash recorded `status: "ok"` |

The first harness invocation (runs A+B) printed **22/23 PASS, 1 FAIL** overall; that one FAIL
is the environmental `LOG-2`. Run C's 16 passing assertions are retained verbatim in
`e2e/artifacts/final/assertions-main-run.log`; run B's 6 passing assertions are retained in
`e2e/artifacts/final/assertions-failure-case.log`.

Run C evidence (stderr) contains no plugin/import/activation errors — only the DeepSeek
model-listing notice and one reasoning line.

## 4. PASS/FAIL per DESIGN §10 requirement (pre-fix build)

The final-build re-run in §11 repeated every assertion below against the shipped build
(23/23 PASS). The table records the original pre-fix evidence.

| # | DESIGN §10 requirement | Assertions | Result |
| --- | --- | --- | --- |
| 1 | Isolated home, live `~/.dsh` untouched | `HOME-1` | **PASS** |
| 2 | Profile boots; bundle installs and the patch layer loads | `PROFILE-1/2`, `INSTALL-1/2`, `DUMP-1/2` | **PASS** |
| 3 | One-shot headless task calls `bash` then `tool_usage` | `RUN-1`, `LOG-1`, `LOG-6`, `OUT-1` | **PASS** |
| 4 | JSONL has a `bash` record whose `params.command` matches, with human-readable Chinese explanation, `status: "ok"`, `durationMs >= 0` | `LOG-1..5` | **PASS** (run C) |
| 5 | `stats.json` exists with `totals.calls >= 1` | `STATS-1` | **PASS** |
| 6 | Model final answer shows the statistics/tool result | `OUT-1` | **PASS** |
| 7 | Deliberate failure path produces an `error`-status record | `RUN-2`, `ERR-1..5` | **PASS** (run B) |
| 8 | Plugin loads/imports/activates without exceptions | `LOAD-1`, `ERR-5` | **PASS** |

Failure-path runs also assert `stats.json` reflects the failures (`ERR-4`: `totals.errors >= 1`).

## 5. Evidence excerpts

### 5.1 Loaded-layer proof — `--dump-config`

`e2e/artifacts/final/dump-config.stdout.txt`, lines 389–391:

```yaml
# == dsh-plugin-tool-usage
- id: tool-usage
  name: dsh-plugin-tool-usage
```

Profile after install (`<e2e-home>/profiles/headless/package.json`):

```json
{
  "dependencies": {
    "dsh-plugin-tool-usage": "link:<workspace>/plugins/tool-usage"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-headless",
    "dsh-plugin-tool-usage"
  ] } }
}
```

`dsh plugin add` exited 0. pnpm only printed an informational peer-dependency note for the
`link:` install; the plugin has no third-party runtime dependencies and loads fine (no
runtime/import errors in either headless run).

### 5.2 Main task: successful `bash` call + `tool_usage` call

`calls-2026-10-28.jsonl` (consolidated JSONL, full copy in
`e2e/artifacts/final/calls-2026-10-28.jsonl`; `details` arrays elided here for brevity).
The two records from the passing session:

```json
{"v":1,"seq":1,"at":"2026-10-28T09:07:27.856Z","tool":"bash","durationMs":50,"status":"ok",
 "params":{"command":"echo hello-tool-usage","description":"Run the exact echo command"},
 "paramsTruncated":false,"redacted":false,
 "explanation":{"summary":"执行 Shell 命令：echo hello-tool-usage","details":["…"]}}
{"v":1,"seq":2,"at":"2026-10-28T09:07:28.644Z","tool":"tool_usage","durationMs":9.2,"status":"ok",
 "params":{"view":"summary","scope":"session"},
 "explanation":{"summary":"调用工具 tool_usage：view=summary，scope=session","details":["…"]}}
```

- `params.command` contains `hello-tool-usage` — matches the requested command.
- `status: "ok"`; `durationMs: 50` (>= 0); `explanation.summary` is Chinese.
- The plugin's own `tool_usage` invocation is also recorded (it goes through the same
  `tools/execute` wrapper).

Main run: exit code 0, 5515 ms; stderr has no load/import/activation errors:

```text
[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
dsh: reasoning:
Now call tool_usage.
```

### 5.3 Model final answer (stdout) shows the statistics

`e2e/artifacts/final/main.stdout.txt`:

```markdown
Done. I ran exactly `echo hello-tool-usage` (output: `hello-tool-usage`), then called
`tool_usage` with the requested parameters.

**Tool statistics (session scope):**
- **Total calls:** 1
- **Failed calls:** 0
- **Total elapsed:** 50 ms / average 50 ms / slowest 50 ms

**Per-tool call counts:**

| Tool | Calls | Failures | Average | Slowest | Most recent |
| --- | --- | --- | --- | --- | --- |
| bash | 1 | 0 | 50 ms | 50 ms | 17:07:27 |
```

### 5.4 `stats.json`

`e2e/artifacts/final/stats.json` — cumulative over the three runs in the isolated home
(7 calls, 3 sessions; the four `error` records are the four environment/tool failures:
3 environment-blocked bash calls from run A/B plus the deliberate `read` failure):

```json
{
  "v": 1,
  "updatedAt": "2026-10-28T09:07:28.654Z",
  "totals": { "calls": 7, "errors": 4, "totalMs": 189.4, "maxMs": 50,
              "slowCalls": 0, "statusCounts": { "ok": 3, "error": 4, "aborted": 0, "threw": 0 } },
  "byTool": {
    "bash":       { "calls": 4, "errors": 3, "totalMs": 135.1, "minMs": 8.4, "maxMs": 50,  "lastMs": 50,  "lastAt": "2026-10-28T09:07:27.856Z" },
    "tool_usage": { "calls": 2, "errors": 0, "totalMs": 23.8,  "minMs": 9.2, "maxMs": 14.6, "lastMs": 9.2, "lastAt": "2026-10-28T09:07:28.644Z" },
    "read":       { "calls": 1, "errors": 1, "totalMs": 30.5,  "minMs": 30.5, "maxMs": 30.5, "lastMs": 30.5, "lastAt": "2026-10-28T09:06:10.343Z" }
  },
  "sessionCount": 3
}
```

The `bySession` breakdown in the same file shows the three sessions separately:
`session-b61a…` (run A: 3 calls, 2 environment errors), `session-f583…` (run B: 2 calls,
2 errors — the deliberate `read` failure plus the environment-blocked `bash exit 3`) and
`session-b7c3…` (run C: 2 calls, 0 errors — the passing `bash` + `tool_usage` pair).
`stats.json` was written and flushed by plugin dispose in every run — **no debounce
workaround was needed**.

### 5.5 Deliberate failure path (run B)

`e2e/artifacts/final/error-call-records.jsonl`:

```json
{"v":1,"seq":1,"tool":"read","durationMs":30.5,"status":"error",
 "params":{"file_path":"/nonexistent-e2e-error-case/file.txt"},
 "explanation":{"summary":"读取文件 /nonexistent-e2e-error-case/file.txt"},
 "error":{"message":"cannot read \"/nonexistent-e2e-error-case/file.txt\": not found","code":"FS_NOT_FOUND"}}
{"v":1,"seq":2,"tool":"bash","durationMs":29,"status":"error","params":{"command":"exit 3"},
 "explanation":{"summary":"执行 Shell 命令：exit 3"},
 "error":{"message":"sandbox mode \"workspace-write\" … Runner failure: sandbox-exec: sandbox_apply: Operation not permitted",
          "code":"SANDBOX_UNAVAILABLE"}}
```

- A genuine `isError` record (`FS_NOT_FOUND`) proves the failure path is recorded with
  status `error`, matching `explanation`, duration and error details.
- The failing `bash exit 3` call is also recorded. Because run B executed under the
  default `workspace-write` mode of the environment-limited host, its status is `error`
  with `SANDBOX_UNAVAILABLE` rather than the command's own exit status (see §6).
- Failure-case task exit code 0 (the agent run completes and reports the failures).
- The six passing failure-path assertions are retained verbatim in
  `e2e/artifacts/final/assertions-failure-case.log`.

## 6. `bash` non-zero-exit nuance (contract vs. DSH behavior)

DESIGN §10 item 5 words the failure case as `bash false` → `status: "error"`. In this DSH
version a **non-zero exit is a normal tool result** — `@deepseek-ai/dsh-tool-bash`'s
`render.ts` documents that "only infrastructure failures (spawn errors, aborts) surface
as isError results". Therefore `bash exit 3`/`false` records `status: "ok"` (with the
output/exit marker) in a working sandbox — it does not produce `status: "error"`.

The harness therefore forces the required **genuine** error-status record with a
`read` of a path that cannot exist (`FS_NOT_FOUND` → `isError: true` → `status: "error"`),
and records/asserts the failing `bash exit 3` call separately (`ERR-3`). No status is
faked and the plugin was not weakened. In a full reproduction run (both tasks under
`danger-full-access`) `ERR-3` will report the bash record's actual status (`"ok"`),
which is the correct DSH semantics.

## 7. Pre-fix model-backed run history

| Run | Purpose | Outcome |
| --- | --- | --- |
| 1 | main task, default `workspace-write` | environment-blocked bash (run A) |
| 2 | failure case | PASS (run B) |
| 3 | main task retry, `danger-full-access` | PASS (run C) |

Pre-fix model-backed runs: **3** (runs A/B/C). The evidence sanitization on 2026-10-29
did not run any model-backed task; it only removed path strings and deleted intermediate
artifacts. A separate full re-run on the final build was made later that day (§11).

## 8. Artifacts

All paths are relative to `plugins/tool-usage/verification/e2e/artifacts/`. Per the
release decision "sanitize + keep only final passing evidence", the intermediate
`run-1-workspace-write/`, `run-2-main-danger-full-access/` and top-level per-run logs were
deleted from the release tree on 2026-10-29; only the curated `final/` set is committed.
The 2026-10-28 files below are the pre-fix evidence; the 2026-10-29 final-build re-run is
committed under `final/final-build-2026-10-29/` and indexed in §11.

| Path | Contents |
| --- | --- |
| `final/README.md` | Provenance of each evidence file and the placeholder substitution rules |
| `final/environment.json` | Harness environment facts of the passing main run (path values replaced by placeholders) |
| `final/assertions-main-run.log` | Run C assertions: 16/16 PASS (setup + install + dump proof + main task) |
| `final/assertions-failure-case.log` | Run B assertions: 6/6 PASS (deliberate failure path) |
| `final/calls-2026-10-28.jsonl` | Consolidated 7-record `calls-*.jsonl` evidence (3 sessions, includes the 4 retained error records) |
| `final/stats.json` | Consolidated `stats.json` snapshot (7 calls / 4 errors / 3 sessions) |
| `final/dump-config.stdout.txt` | Full `--dump-config` output proving the `# == dsh-plugin-tool-usage` layer and the `id: tool-usage` row |
| `final/main.stdout.txt` | Model final answer of the passing main task with the `tool_usage` statistics table |
| `final/error-call-records.jsonl` | JSONL records appended by the passing failure-case run |
| `final/final-build-2026-10-29/` | Sanitized artifacts of the final-build re-run: 23/23 assertions, environment facts, JSONL/stats after both tasks, dump proof, commands (§11) |

A fresh harness run writes new per-run files directly under
`verification/e2e/artifacts/` (all path values are machine-specific). Move the relevant
files into `final/`, re-apply the placeholder substitutions, and delete the per-run files
before committing updated evidence.

## 9. Rerun & cleanup for the user

From the workspace root (`<workspace>`):

```bash
export DSH_CHECKOUT=<dsh-checkout>   # required; the harness has no machine-specific default

# Requires a real DEEPSEEK_API_KEY under refs in ~/.dsh/.credentials.yaml.
# Recreates <e2e-home>, installs the bundle, proves the layer, runs both headless
# tasks (2 LLM runs) and prints PASS/FAIL; exit code 1 on any failure.
node plugins/tool-usage/verification/e2e/setup-and-run.mjs

# Equivalent one-liners:
node plugins/tool-usage/verification/e2e/setup-and-run.mjs --no-llm    # install + dump proof only
node plugins/tool-usage/verification/e2e/run-error-case.mjs            # failure path only (1 LLM run)

# Clean up the isolated home / scratch workspace (gitignored):
rm -rf .e2e-home .pnpm-store
```

Expected on a clean run: 23/23 assertions PASS, `exit 0`, new artifacts written under
`plugins/tool-usage/verification/e2e/artifacts/`.

Harness sanity re-check (2026-10-29, after removing the hard-coded checkout default and
sanitizing artifacts): `DSH_CHECKOUT=<dsh-checkout> node
plugins/tool-usage/verification/e2e/setup-and-run.mjs --no-llm` →
**7/7 PASS** (`HOME-1`, `PROFILE-1/2`, `INSTALL-1/2`, `DUMP-1/2`), exit 0, no machine paths
in the harness.

## 10. Caveats / limitations of the pre-fix verification

- The four environment-failed `bash` attempts from runs A/B remain in the retained
  consolidated JSONL/stats because the checks are cumulative over the same isolated home
  (`--keep-home` retry); they are explicitly labelled `SANDBOX_UNAVAILABLE`. A clean
  reproduction run starts from an empty home and yields only the passing records.
- The failure case (run B) ran before the `danger-full-access` retry, so its bash
  `exit 3` record is an environment error rather than a normal non-zero-exit result.
  The failure-path *assertions* are mode-independent, and the genuine error record
  (`read`/`FS_NOT_FOUND`) is unaffected.
- `danger-full-access` was used only to work around nested sandbox unavailability inside
  the agent session that drove the harness; the outer OS sandbox still confined the child
  process. On a plain shell where `sandbox-exec` can start, the default
  `workspace-write` mode works and can be selected with `E2E_PERMISSION_MODE=workspace-write`.
- Numbers in `stats.json` are wall-clock and cumulative across the three runs; parallel
  calls would overlap, but this verification ran calls sequentially.
- The retained evidence is sanitized: machine paths were replaced by placeholders, and the
  intermediate run directories were removed on 2026-10-29. No PASS/FAIL result, timestamp,
  call record or statistic was altered.

## 11. Final-build re-run (2026-10-29)

After the post-review fixes (bounded failure/explanation text, additive statistics
restore, log-file permission tightening, unique `stats.json` temp file, persisted
`/tool-usage reset`) the full harness was re-run **on the final build** from a clean
isolated home. This is the authoritative model-backed evidence for the shipped `lib/`.

- Command: `DSH_CHECKOUT=<dsh-checkout> node plugins/tool-usage/verification/e2e/setup-and-run.mjs`
- Result: **23/23 assertions PASS**, exit 0 — 2 model-backed runs (main task and
  failure case); no retry was needed. `danger-full-access` was used for the
  nested-sandbox reason explained in §2.
- Build under test: `npm run build` — 3,299 lines / 22 files, `lib/index.js` and
  `lib/types/index.d.ts` present; the same tree runs `npm test` → 133/133.
- Environment: Node `v24.19.0`, Darwin arm64, DSH `0.2.2-alpha.2` source execution,
  isolated `<e2e-home>`; the live `~/.dsh` was untouched.

Sanitized evidence: `verification/e2e/artifacts/final/final-build-2026-10-29/`

| Path | Contents |
| --- | --- |
| `environment.json` | Harness environment facts of this run (paths replaced by placeholders) |
| `assertions.log` | All 23 assertions verbatim, ending `SUMMARY: 23 passed, 0 failed, 23 assertions` |
| `main-call-records.jsonl` | `calls-*.jsonl` records from the main task (`bash echo hello-tool-usage` + `tool_usage`) |
| `stats-after-main.json` | `stats.json` after the main task |
| `error-call-records.jsonl` | Records from the failure case (`read` → `status: "error"`, `bash exit 3` → `ok`) |
| `stats-after-error.json` | `stats.json` after the failure case |
| `dump-config.stdout.txt` | Full `--dump-config` proof of the `# == dsh-plugin-tool-usage` layer and `tool-usage` row |
| `main.stdout.txt` / `main.stderr.txt` | Main task answer / stderr (no plugin load or activation errors) |
| `error.stdout.txt` | Failure-case answer |
| `commands.log`, `init-profile.stdout.txt`, `plugin-add.stdout.txt` | Setup transcript for reproducibility |

Observed in this run: the failure case records the `read` of a nonexistent path as
`status: "error"` (`FS_NOT_FOUND`), while `bash exit 3` is a normal `ok` result in this
DSH; `stats-after-error.json` reflects the error with `totals.errors = 1`. No credentials
or machine-specific paths are present in the evidence.

