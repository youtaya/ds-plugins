# Unit verification report — `dsh-plugin-tool-usage`

Status: **PASS** — the built plugin (v0.2.0) passes the full unit + integration suite.
See §0.1 for the 0.2.0 Web UI addendum; the v0.1.0 evidence below is retained as
history and remains reproducible on that release.

| Item | Value |
| --- | --- |
| Maintained by | the plugin maintainers |
| Date | 2026-10-29 (Asia/Shanghai) |
| Post-review fixes | 2026-10-29: bounded records (`M1`/`M2`), additive stats restore (`M3`), redaction/permission/durability fixes, and doc alignment; `lib/` rebuilt and the suite expanded from 112 to 133 tests |
| Node.js | `v24.19.0` |
| OS | Darwin arm64 (macOS) |
| Package dir | `<workspace>/plugins/tool-usage` |
| Design contract | `docs/DESIGN.md` §5–§13 and §15 (authoritative) |
| Test framework | `node:test` + `node:assert/strict` only (zero third-party test deps) |
| Modules under test | built `lib/*.js` ESM (not `src/`) |

> Placeholder: `<workspace>` is the `ds-plugins` checkout root; `<dsh-checkout>` is a DSH
> source checkout. Machine-specific absolute paths were removed for the public release.

---

## 0.1 v0.2.0 addendum (2026-10-29)

The Web UI release adds a Host session projection (`src/projection.ts`), the
plain-JavaScript browser half (`client.js`), four `ui*` config fields, and the
`dsh.client` declaration. The final suite on this build:

```console
$ cd <workspace>/plugins/tool-usage
$ npm ci
$ npm run build
build: compiling with <workspace>/plugins/tool-usage/node_modules/typescript/bin/tsc
built 3978 line(s) to lib/
$ npm test
ℹ tests 178
ℹ pass 178
ℹ fail 0
ℹ skipped 0
ℹ duration_ms ~370
```

| File | Tests | Scope added in 0.2.0 |
| --- | --- | --- |
| `client.test.mjs` | 21 | browser bundle: module-loader shape, five slot registrations + right-Sidebar tab type, locale parity, live ticking, null states, turn card, dashboard filters, right-side stream (projection and Chat fallback, 50-row cap), auto-open once, English |
| `config.test.mjs` | 13 | `ui*` defaults, clamping, invalid-value warnings |
| `package.test.mjs` | 11 | `dsh.client`, `./client`, `client.js` in `files`, plain-JS parse/no Harness imports |
| `plugin.test.mjs` | 18 | projection registration/release, `uiEnabled: false`, missing registry, registration-failure tolerance |
| `projection.test.mjs` | 17 | fold semantics, bounded rings vs whole-session totals, privacy, JSON state |
| others (`explain`, `log`, `recorder`, `redact`, `stats`, `tool`) | 98 | unchanged contracts, still green |

`npm pack --dry-run --cache <workspace>/.tmp/npm-cache --ignore-scripts` reports
`dsh-plugin-tool-usage-0.2.0.tgz` with 35 files (97.8 kB packed / 333.5 kB
unpacked), including `client.js` (62.5 kB), `lib/projection.js`, and the
projection declarations, and no `src/`, `tests/`, or `verification/` entries.
`node scripts/check-public.mjs` passes (105 candidate files).

The browser half was also checked against a real freshly booted isolated DSH Web
server (boot graph + served bundle). See `verification/ui-activation.md` for the
15/15 PASS harness run, the observed boot-graph entry, the upgrade/refresh path,
and the remaining visual-verification limit.

---

## 0. Reproduce from a clean checkout

```console
$ cd <workspace>/plugins/tool-usage
$ npm ci                 # or `npm install`; installs the pinned devDependencies
$ npm run build          # node scripts/build.mjs
$ npm run check          # node --check lib/index.js
$ npm test               # node --test tests/*.test.mjs
```

- `--legacy-peer-deps` is **not** required: with the pinned devDependencies the plain
  `npm install`/`npm ci` resolves (23 packages) and the build type-checks against the
  npm-installed `@deepseek-ai/dsh-tools`/`dsh-commands` packages. Its peers are installed
  automatically by npm (npm ≥ 7); no extra devDependency is needed.
- The pinned `@deepseek-ai/cordis` devDependency is `4.0.6-alpha.1` — the cordis version
  vendored by the DSH `0.2.2-alpha.2` checkout and the version the published
  `dsh-tools@0.2.2-alpha.2`/`dsh-commands@0.2.2-alpha.2` declare as a peer
  (`~4.0.6-alpha.1`). Pinning `4.0.5` (the current npm `latest` tag) makes the plain
  install unresolvable and leaves the published `ToolDefinition` types without their
  `dsh-llm` peer, so the build fails with `TS2339` on `description`/`parameters`.
  The plugin's own `peerDependencies` ranges are unchanged and admit `4.0.6-alpha.1`
  (the DSH compatibility check uses `{ includePrerelease: true }`).
- `scripts/build.mjs` resolves TypeScript as: local `node_modules/typescript` →
  `DSH_CHECKOUT` env (source-checkout fallback, dev symlinks recreated) → actionable
  error. Both paths were verified to emit a byte-identical `lib/`.

---

## 1. Commands and results

### 1.1 Build (fresh, portable)

`scripts/build.mjs` locates a TypeScript compiler (local npm install first, DSH checkout
fallback) and always builds from a clean `lib/`. The build was re-run after the review
fixes on 2026-10-29 from the npm-installed tree:

```console
$ cd <workspace>/plugins/tool-usage
$ npm run build
build: compiling with <workspace>/plugins/tool-usage/node_modules/typescript/bin/tsc
built 3292 line(s) to lib/
$ npm run check
$ echo $?
0
```

- `lib/` regenerated 2026-10-29 after the review fixes (`src/` changed: bounded records,
  additive restore, redaction/permission/durability fixes, new `src/warn.ts`).
- Exit code **0**; every emitted module parses (`node --check` over `lib/**/*.js`).
- Two consecutive clean builds after the fixes produced a byte-identical `lib/`
  (sha1 comparison of all 22 files), so the post-fix build stays deterministic.
- The post-fix build used the portable npm-installed TypeScript path. The pre-fix
  clean-tree build and the `DSH_CHECKOUT` fallback were verified to emit
  byte-identical `lib/` output; the build script and `tsconfig.json` did not change
  in the fixes, so both compiler paths still produce the same tree.
- Without either compiler source the script fails with an actionable message
  (`build: TypeScript compiler not found` + the two fixes) instead of a stack trace.
- Emitted layout: 11 JS modules (`lib/index.js` + 10, including `lib/types.js` and the
  new `lib/warn.js`) and 11 declaration files under `lib/types/*.d.ts`, including
  `lib/types/index.d.ts` (the package `types` entry) — 22 committed `lib/` files total.

### 1.2 Unit + integration tests

```console
$ cd plugins/tool-usage
$ npm test
… 133 test cases …
ℹ tests 133
ℹ suites 0
ℹ pass 133
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ≈ 250
$ echo $?
0
```

Run on 2026-10-29 after the review fixes, from the npm-installed tree (exit 0):
`tests 133 / pass 133 / fail 0 / cancelled 0 / skipped 0 / todo 0`. That is the
pre-review 112 tests plus 21 regression tests for the fixed behaviors (§2, §5).

> **Node 24.19 invocation note:** `node --test tests/` (a positional directory) is **broken** on Node v24.19.0 — the runner resolves the directory as a module and fails with `Cannot find module .../tests`. Use a glob instead:
> `node --test 'tests/*.test.mjs'` (quoted, works with either Node-side or shell-side expansion) or `node --test 'tests/**/*.test.mjs'`.
> Both forms are green (133/133). `npm test` runs the quoted glob.

### 1.3 Smoke checks

```console
$ node -e "import('./lib/index.js').then(m=>console.log('name=', m.name, '| inject=', JSON.stringify(m.inject), '| apply=', typeof m.apply))"
name= tool-usage | inject= ["tools"] | apply= function

$ for f in lib/*.js lib/types.js; do node --check "$f" || echo "FAIL $f"; done
# (no output — every emitted module parses)
```

`package.test.mjs` additionally imports nothing from `lib/index.js` but statically verifies the manifest, bundle patch, locale metadata, `engines.dsh` semver admission of `0.2.2-alpha.2`, and that every `files` entry exists on disk after the build.

---

## 2. Per-file results (133/133 passing)

Per-file counts below add up to the combined 133-case run; each file also passes when run alone with `node --test tests/<file>`.

| File | Tests | Pass | Fail | Area (DESIGN §15) |
| --- | ---: | ---: | ---: | --- |
| `tests/redact.test.mjs` | 17 | 17 | 0 | §15.1 redaction/truncation |
| `tests/explain.test.mjs` | 16 | 16 | 0 | §15.2 explanation |
| `tests/stats.test.mjs` | 16 | 16 | 0 | §15.3 statistics |
| `tests/log.test.mjs` | 17 | 17 | 0 | §15.4 JSONL log + atomic stats.json |
| `tests/recorder.test.mjs` | 18 | 18 | 0 | §15.5 `tools/execute` wrapper |
| `tests/tool.test.mjs` | 14 | 14 | 0 | §15.6a `tool_usage` tool |
| `tests/plugin.test.mjs` | 14 | 14 | 0 | §15.6b plugin wiring (fake Cordis ctx) |
| `tests/package.test.mjs` | 9 | 9 | 0 | §15.7 static package checks |
| `tests/config.test.mjs` | 12 | 12 | 0 | §7 config normalization (bonus) |
| **Total** | **133** | **133** | **0** | 0 skipped, 0 todo |

### Coverage highlights

- **redact** — `SENSITIVE_KEYS` families (token/password/apiKey/authorization/cookie/…), case-insensitive `-`/`_`-stripped *contains* matching (`x-api-key`, `tokensPerSecond`), nested objects/arrays, long-string cut to `maxStringChars - 1` + `…`, >50-item array cap with `[… N more items]`, depth > 6 → `[deep]`, circular/class-instance/function/symbol/`undefined` → `[unserializable]`, `bigint` → decimal string, `redacted`/`truncated` flags, lossless-JSON guarantee.
- **explain** — zh + en for `bash`/`read`/`grep`/`web_search`/`web_fetch`/`read_image` + generic unknown tool; brief vs detailed (description + `参数 …` lines); alias map (`shell`→bash, `read_file`→read); newline-free summaries even when values contain newlines; malformed/circular/non-object args safe; `maxValueChars` bound; total caps `MAX_SUMMARY_CHARS`/`MAX_DETAIL_LINES`/`MAX_DETAIL_CHARS` (`explain` sum/detail/description clipping).
- **stats** — per-tool `calls/errors/total/min/max/avg/last/lastAt/errorRate/slowCalls/statusCounts`, session vs all scope (including unscoped calls), recent newest-first + limit, ring buffer, params/explanation inclusion flags, `slowThresholdMs` classification, `toJSON`→`restore` aggregate round-trip, `reset()`/`reset({sessionId})`, malformed restore ignored, ms rounding to 1 decimal.
- **log** — one JSON line per append in order, recursive dir creation in fresh `mkdtemp`, atomic `stats.json` (`.tmp` renamed away, parseable), debounce coalescing, `restoreStats` round-trip, missing/corrupt stats → `undefined`, unwritable directory (file-as-dir) never throws and warns once, unserializable record does not break the queue, `dispose` flushes and drops later appends, `persistCalls/persistStats: false` respected.
- **recorder** — `next()` timing via ~20 ms sleep (asserted as a range), result-object identity preserved, statuses `ok`/`error`/`aborted` (both `ABORTED` and `ABORTED_BEFORE_DISPATCH`)/`threw` (rejection rethrown unchanged), monotonic seq, session attribution, redacted params feed explanation, whole-params cap, `explain: 'off'`, schema-lookup failure fallback, **recording never throws when stats/log/scheduleStats/dispose throw** (warn-once per failure class).
- **bounded records (M1/M2, added 2026-10-29)** — a 100 KB failure `error.message` is capped at `maxStringChars` in both structured-error and thrown paths; a 500-argument unknown tool yields a summary capped at 2,000 chars and details capped at 50 lines / 8,000 chars; registered descriptions are clipped; `maxParamChars` is a true upper bound for the serialized params preview (with the documented 18-char envelope floor).
- **restore race (M3)** — `StatsStore.restore` merges additively into live aggregates, keeps the live recent-calls ring, and a plugin-level test records a call while the startup restore is in flight and proves it is counted and retained.
- **redaction/permissions/durability (added 2026-10-29)** — `.`/whitespace key normalization, documented pair/array-shape limitation, own `__proto__` preserved as data without prototype pollution, pre-existing `0644` log re-tightened to `0600`, `stats.json` unique temp + no leftovers + concurrent writers, transient `mkdir` failure retried on a later append, `/tool-usage reset` persists the cleared snapshot while keeping the JSONL, awaited command-fiber disposal.
- **tool** — definition name/parameter schema (view/tool/scope/limit enums, integer limit), concurrency-safe, `summary` default session scope + `scope=all`, `tools`, `recent` (default 20, clamp 1000→100), `explain` (description + parameter table), unknown tool explain → error result, invalid view rejected by schema, zh/en Markdown render, params inclusion flag.
- **plugin** — fake Cordis ctx (`logger`, `on`, `tools.register/get`, `effect`, `inject` Fiber-shaped) → `apply()`; execute listener records a call and writes exactly one JSONL line with timing/redaction/explanation/session; status mapping through the real plugin; disabled config registers/writes nothing; headless (no `commands`) load; optional `/tool-usage` command registered when `inject` provides `commands` and all documented forms handled (`''`, `all`, `recent 2`, `reset`, bogus → usage error); dispose flushes JSONL + `stats.json`; stats restored on re-apply and keep counting; two-session attribution; log-persistence failure never changes the tool result.
- **package** — identity/manifest fields, `dsh.bundle.patch`, exports map, `engines.dsh` literal range + tiny semver evaluator (`0.2.2-alpha.2` admitted, 0.1.9/0.3.0 rejected), peer/dev deps + zero runtime `dependencies`, `cordis.patch.yml` inserts `id: tool-usage` / `name: dsh-plugin-tool-usage` with no `config` block, `locale/{en,zh}.json` parse with non-empty `meta.title`/`meta.description` + referenced detail docs exist, every `files` entry/glob resolves, main/types exist, compiled modules only import `node:*`/relative/`@deepseek-ai/dsh-tools` and never call `process.exit`.
- **config** — documented defaults, `$DSH_HOME/tool-usage` default, `$DSH_HOME`/`~` expansion to absolute paths, `outputDir: ''` disables persistence, valid overrides, `redactKeys` default merge, invalid values warn instead of throwing, unknown keys ignored, `null`/missing config, missing logger.

---

## 3. Isolation and determinism

- Every test that persists writes only into `mkdtemp(os.tmpdir())` directories created per test (`tool-usage-log-*`, `tool-usage-plugin-*`) and removes them afterwards. No test writes `calls-*.jsonl`, `stats.json`, or any other file inside the repository.
- `stats`/`explain`/`config` use injected fixed records, timestamps and options — deterministic.
- `recorder`/`plugin` timing assertions use ranges only (`durationMs >= 15` for a ~20 ms sleep, `< 2000` sanity ceiling) and poll with a bounded 3 s timeout for the fire-and-forget JSONL append/restore instead of sleeping fixed amounts.
- Log file-name tests accept any `calls-YYYY-MM-DD.jsonl`, so a local-midnight boundary cannot flake them.
- The runner is single-process per file; no cross-file state leaks (`config.test.mjs` restores `DSH_HOME` via `t.after`).
- POSIX file-mode assertions (created `0700`/`0600`, pre-existing `0644` re-tightened) skip on Windows, where mode bits are not meaningful.

---

## 4. Contract-vs-implementation decisions reflected in the tests

These were confirmed against `src/` during authoring and are asserted as documented behavior; none is a contract violation, they fill gaps the DESIGN leaves open:

1. **Statistics error semantics** — `errors` counts real failures only: `status === 'error'` **and** `status === 'threw'`. `aborted` calls are tracked in `statusCounts.aborted` but are **not** failures (caller cancelled). `errorRate` is rounded to 4 decimal places; all millisecond fields round to 1 decimal.
2. **Config clamping** — out-of-range numbers are clamped to their documented bounds (`maxParamChars: -1` → `1`, `maxStringChars: 0` → `1`, `statsWriteDebounceMs: -5` → `0`) and warn; non-numeric/invalid types fall back to defaults and warn. `outputDir: ''` forces `persistCalls`/`persistStats` to `false`.
3. **`explain: 'off'`** — recorder still records the call but with `explanation = { summary: '' }` and no schema lookup.
4. **`explain.ts` name resolution** — exact known names first, then an explicit alias map (`shell`→bash, `read_file`→read, `web_search` from `search_web`, …), then the last namespace segment (`mcp__server__bash`, `functions.read`). A character prefix alone (`bash2`) is deliberately *not* classified. "Prefix-tolerant" is therefore namespace-segment based, not string-prefix based.
5. **`StatsStore` constructor** — accepts optional `slowThresholdMs` in addition to `{ recentLimit }`, because §10 requires slow classification inside snapshots.
6. **`tool_usage` explain errors** — an unknown tool throws from the tool body; the DSH executor normalizes that into a normal `isError` result. Tests assert the rejection at the direct `execute()` unit level, and plugin-level behavior through the wrapper.
7. **Optional command registration** — `index.ts` wraps `ctx.inject(['commands'], …)` in `ctx.effect` and returns an async cleanup that awaits `fiber.dispose()`; the fake context models a Fiber-shaped `inject()` result so the awaited disposal is exercised.
8. **Startup restore is additive** — `StatsStore.restore` merges persisted aggregates into the live store and leaves the recent-calls ring alone; calls recorded while the asynchronous read is in flight stay counted (DESIGN §10).
9. **Record size is bounded** — failure messages are capped at `maxStringChars` and are not key-redacted; explanation summaries/details have named total caps (DESIGN §5.2, §9); a sub-18 `maxParamChars` is raised to the preview-envelope floor.
10. **`/tool-usage reset` persists the cleared state** — the command rewrites `stats.json` from the cleared aggregates (replacing a pending pre-reset snapshot) while leaving the append-only JSONL untouched, so a restart does not restore pre-reset counts.
11. **Pre-existing loose file modes are tightened** — the log chmods an existing `calls-*.jsonl` to `0600` once per process; the test environment must support POSIX modes (skipped on Windows).

---

## 5. Defects found

The original 2026-10-28 verification found **0 genuine source defects**; four
**test-authoring** mistakes were corrected then (all test-side, no product change):
1. `log.test.mjs` ordering fixture reused a module-level sequence counter → explicit `seq` values keep the ordering assertion stable.
2. `stats.test.mjs` asserted `errorRate` as the full fraction `1/3` → the implementation correctly rounds to `0.3333`.
3. `stats.test.mjs` treated `aborted`/`threw` as "errors" inconsistently → aligned with decision 4.1 (error + threw are failures; aborted is not).
4. `recorder.test.mjs` expected `threw` not to increase `totals.errors` → aligned with decision 4.1 (it does).

The independent 2026-10-29 review then found three MAJOR and several MINOR issues
(unbounded/unredacted failure messages, unbounded explanation text, restore clobbering
live calls, plus smaller redaction/permission/durability items). All were fixed in
`src/` with 21 regression tests listed in §2. A final pass after the re-review also
capped failure `error.code` (record-size bound) and persists the merged restore view so
a pre-merge snapshot cannot overwrite restored history. No defect was left unaddressed
or hidden by weakening a test.

## 6. Notes for the E2E harness

- Use an isolated `DSH_HOME` (`<workspace>/.e2e-home`), never the live `~/.dsh`. Default plugin `outputDir` is `$DSH_HOME/tool-usage`, i.e. `<workspace>/.e2e-home/tool-usage/{calls-YYYY-MM-DD.jsonl,stats.json}`.
- `stats.json` writes are **debounced 2000 ms** and flushed on plugin dispose; a one-shot headless run should flush at teardown, so `stats.json` is expected to exist. **If the E2E report shows a missing `stats.json`, the fix is profile config `statsWriteDebounceMs: 0` in the `tool-usage` row — not a code change.**
- JSONL appends are per-call and ordered; `durationMs` is wall-clock (parallel calls overlap), and `status` is one of `ok`/`error`/`aborted`/`threw`. Sensitive arguments (`token`, `password`, `apiKey`, `authorization`, `cookie`, …) appear as `[REDACTED]`; long values are truncated and `paramsTruncated`/`redacted` flags are set.
- `/tool-usage` slash command is registered only when the `commands` service exists (headless profiles usually lack it); the model-facing `tool_usage` tool is always registered.
- `node --test tests/` is broken on Node v24.19; use the glob form in §1.2 if re-running locally.

## 7. Residual risks

- **Build freshness only:** the suite is green against the `lib/` rebuilt on 2026-10-29 after the review fixes. Any later `src/` change requires a re-run of `node scripts/build.mjs` + the suite; the repository CI runs the build + tests, but there is no local watch gate.
- **E2E evidence:** the pre-fix model-backed run in `e2e-report.md` (§3–§10) was collected before these fixes; after the fixes the full harness was re-run on the final build on 2026-10-29 and passed 23/23 assertions (`e2e-report.md` §11, evidence under `e2e/artifacts/final/final-build-2026-10-29/`). Together they cover activation/wiring plus the record-format caps and restore/reset semantics.
- **npm install needs the registry:** `npm ci`/`npm install` fetch the five pinned devDependencies (23 packages incl. npm-resolved peers) from npmjs.org. The committed `package-lock.json` fixes the resolved tree; the source-checkout fallback (`DSH_CHECKOUT`) builds without a package install.
- **Timing tolerances:** recorder/plugin tests assert duration ranges, not exact values; a heavily loaded machine could exceed the `< 2000 ms` ceiling only if the ~20 ms stub itself stalls for ~2 s.
- **Static package checks assume the build ran first** (`main`/`types`/`files` globs). Running the suite without `lib/` fails the package + all lib imports, as intended.
- **No test boots a real Cordis runtime** — that is deliberately the E2E harness's job (fake ctx only, per DESIGN §15.6).

## 8. Verdict

- 178/178 unit + integration tests pass for v0.2.0, 0 skipped, exit code 0 — run
  on 2026-10-29 after the Web UI change (v0.1.0's 133/133 run remains in §0.1–§7).
- The v0.2.0 browser half additionally passed the isolated real-Web-server boot
  check (15/15 assertions, `verification/ui-activation.md`).
- `npm run build` exits 0 and emits the complete ESM + types layout (22 committed files, including the new `src/warn.ts` output).
- Package manifest is release-ready (`repository`/`homepage`/`bugs`/`author`/`keywords`/`publishConfig`/`scripts`, pinned devDependencies, committed `package-lock.json`), and `npm pack --dry-run` contains no junk (32 files, including `lib/warn.js` + `lib/types/warn.d.ts`, no `src/`, `tests/`, or `verification/`).
- E2E activation/wiring passed on the pre-fix build and again on the final build (23/23 assertions; see `e2e-report.md` §3–§11); the record-format and restore/reset changes are additionally covered by this suite.
