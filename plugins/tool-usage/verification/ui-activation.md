# Web UI verification report — `dsh-plugin-tool-usage`

Status: **PASS (automated)** — the v0.2.0 Host projection and browser half pass the
unit/integration suite and a real isolated Web-server boot check. Browser-level
visual rendering (layout, theme, animations, interaction) was not visually
inspected because this environment has no browser control; that limit is
recorded in §6 instead of being claimed.

| Item | Value |
| --- | --- |
| Maintained by | the plugin maintainers |
| Date | 2026-10-29 (Asia/Shanghai) |
| Node.js | `v24.19.0` |
| OS | Darwin arm64 (macOS) |
| Package | `dsh-plugin-tool-usage` 0.2.0 |
| Package dir | `<workspace>/plugins/tool-usage` |
| DSH checkout | `<dsh-checkout>` at `0.2.2-alpha.2` |
| Design contract | `docs/DESIGN.md` §5.3, §5.4, §20 (authoritative) |
| Isolated harness | `verification/ui-boot.mjs` (isolated `DSH_HOME`, no model credentials) |

> Placeholder: `<workspace>` is the `ds-plugins` checkout root; `<dsh-checkout>` is a
> DSH source checkout. Machine-specific absolute paths were removed for the public
> release.

---

## 1. What was verified

The 0.2.0 change adds two cooperating halves:

- **Host** — `src/projection.ts` registers the `toolUsage` session projection
  (key `toolUsage`, `stateVersion: 1`, `wire.summary: false`) and folds committed
  `turn/start` / `tool/call` / `tool/result` / `turn/end` events into a bounded,
  redacted wire view. `src/index.ts` registers it through a nested optional
  `sessionProjections` injection, so profiles without the registry still load.
- **Client** — `client.js` (plain JavaScript, no build) is served by the DSH Web
  module loader through the bundle's `dsh.client` declaration and registers four
  surfaces: the live strip, the per-turn dashboard card, the session calls view
  tab, and a right-Sidebar live stream tab (type `tool-usage-stream`) with a
  conversation-header reopen action and a right-Sidebar guide entry. The
  right-Sidebar registrations live behind an optional nested
  `ctx.inject(['sidebarRight', 'sidebarRightTabs'], …)`, so a composition without
  that Sidebar keeps the three conversation entries.

## 2. Unit + integration suite

From `<workspace>/plugins/tool-usage`:

```console
$ npm run build
build: compiling with <workspace>/plugins/tool-usage/node_modules/typescript/bin/tsc
built 3978 line(s) to lib/
$ npm test
ℹ tests 178
ℹ pass 178
ℹ fail 0
ℹ skipped 0
```

Per-file results (each run with `node --test tests/<file>.test.mjs`):

| File | Tests | Result |
| --- | --- | --- |
| `client.test.mjs` | 21 | PASS — module-loader shape, five registrations/ids/orders/locale namespace plus the right-Sidebar tab type, zh/en key parity, live ticking, null states, per-turn card content and disclosure, dashboard tables/filters/empty state, `viewRequest` acknowledgement, right-side stream (50-row cap, projection and Chat fallback, auto-open once), English rendering |
| `config.test.mjs` | 13 | PASS — including `uiEnabled`/`uiRecentCalls`/`uiRecentTurns`/`uiCommandChars` defaults, clamping, and invalid-value warnings |
| `explain.test.mjs` | 16 | PASS |
| `log.test.mjs` | 17 | PASS |
| `package.test.mjs` | 11 | PASS — including `dsh.client` (`platform: "web"`, `immediately: true`, inject edges), `./client` export, `client.js` in `files`, and `client.js` parsing as a plain-JS bundle whose only module-table require is `react` |
| `plugin.test.mjs` | 18 | PASS — including four new projection-wiring tests: default registration and release, `uiEnabled: false`, missing registry, and registration-failure tolerance |
| `projection.test.mjs` | 17 | PASS — turn grouping, pair/normalize statuses, orphan settling, ring bounds vs whole-session totals, top-20 tool rows, redaction/non-leakage, explain off, command clipping, JSON-safe state, identity-preserving unknown events |
| `recorder.test.mjs` | 18 | PASS |
| `redact.test.mjs` | 17 | PASS |
| `stats.test.mjs` | 16 | PASS |
| `tool.test.mjs` | 14 | PASS |

## 3. Isolated real Web-server boot check

The reusable harness installs the package into a fresh isolated `web` profile,
boots the real `dsh web` server on loopback, reads the boot graph the server
serves, and downloads the client bundle URL it advertises. It never touches
`~/.dsh` and needs no model credentials.

```console
$ DSH_CHECKOUT=<dsh-checkout> node plugins/tool-usage/verification/ui-boot.mjs
ui-boot: isolated DSH_HOME <workspace>/.tmp/ui-boot-home
ui-boot: checkout <dsh-checkout>
PASS fresh web profile composes
PASS bundle installs into the isolated web profile
PASS composed profile contains the tool-usage row
ui-boot: server http://127.0.0.1:<port>/?token=<redacted>
PASS authorized page is served
PASS page carries a parseable client boot graph
PASS boot graph lists the package client half
PASS client bundle URL points at the package ./client
PASS client half is prefetched immediately
PASS client half declares its activation edges
PASS served client bundle responds 200
PASS served bundle carries the module-loader id
PASS served bundle registers conversation.input.dock
PASS served bundle registers conversation.chat.turnTail
PASS served bundle registers conversation.view
PASS served bundle registers sidebar.right.pane.tab
PASS served bundle registers conversation.session.header.actions
PASS served bundle declares the right-Sidebar stream tab type
PASS served bundle recommends the right-Sidebar activation edge
PASS served bundle requires only React from the module table

ui-boot: 19 passed, 0 failed
```

Observed boot-graph entry (shape; the revision hash changes with every build):

```json
{
  "id": "dsh-plugin-tool-usage",
  "url": "plugins/??dsh-plugin-tool-usage/client.js&rev=<hash>",
  "rev": "<hash>",
  "inject": [
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-sidebar-right"
  ],
  "immediately": true
}
```

The served bundle body is the package's `client.js` plus the server's
`sourceMappingURL` comment; it contains `window.__ModuleLoader__.load` with the
package id and all three slot registrations. The isolated home, pnpm store, and
cache are removed at the end of a passing run.

## 4. Package contents

```console
$ npm pack --dry-run --cache <workspace>/.tmp/npm-cache --ignore-scripts
npm notice name: dsh-plugin-tool-usage
npm notice version: 0.2.0
npm notice package size: 97.8 kB
npm notice unpacked size: 333.5 kB
npm notice total files: 35
```

The tarball contains `client.js` (62.5 kB), `lib/projection.js`, the projection
declarations, `cordis.patch.yml`, `locale/*.json`, and the docs — no `src/`,
`tests/`, or `verification/` files. Public-release hygiene passed:
`node scripts/check-public.mjs` → `OK — no machine-specific paths or credentials
found in 105 candidate files`.

## 5. Upgrade path on the maintainer's running profile

The `web` profile on the verification machine already had the package installed
as a directory link from 0.1.0. The 0.2.0 files therefore live in place, but:

- the running Host process must be restarted to load the new `lib/` (the
  projection and the client bundle declaration are only read at boot);
- the open Web page must be refreshed so the browser loads the new client module
  from the new boot graph.

The isolated harness above proves that a freshly booted profile serves the new
client half. It does not and cannot prove that an already-open page picked it up.

## 6. Limits and residual risks

- **No browser control.** Visual verification (CSS layout inside the composer
  dock and chat flow, light/dark theme, scroll behavior, pulse animation) was not
  performed. The semantic component tests and the real bundle download are the
  evidence; do not treat them as a screenshot-equivalent check.
- **Snapshot timing.** The projection updates when a call starts/settles or a turn
  opens/closes. A call still streaming its arguments before its `tool/call` event
  is committed is not visible yet; the live strip covers the execution window.
- **Bounded detail.** Session totals and per-tool aggregates cover the complete
  log, but the call/turn lists are the recent `uiRecentCalls` / `uiRecentTurns`
  window (defaults 60 / 30) and the per-tool table is top-20. Per-turn shell
  counts and per-turn tool bars derive from that window, so a very long session
  can undercount those per-turn UI figures while the session metrics stay exact.
  The turn card says so when older calls were omitted.
- **Dashboard access is a tab.** The Client API exposes no cross-plugin
  `selectView`, so the turn card points at the session dashboard tab instead of
  switching to it. This is a deliberate scope decision, not a missing handler.
- **Right-side stream auto-opens once per page load.** A per-mount ref guard
  opens the right-Sidebar tab when the current Session first starts running; if
  the user closes it during that page life it stays closed, and it is reopened
  from the header action or the right-Sidebar guide. The body falls back to
  `useChat` data when the Host projection is unavailable, so the stream works
  against an older Host process too; projection-backed rows are richer (host
  explanations, turn ids, bounded error text).
- **The right-Sidebar panel's rendered layout was not visually inspected.** The
  full-height flex/scroller structure and token-only styling are covered by the
  browser-half tests and the served-bundle check, not by a screenshot.
- **No visual theme screenshot in either theme.** Token-only styling is asserted
  statically (no hex/rgb literals; only the documented `--dsw-alias-*` tokens),
  but rendered contrast remains unverified here.

## 7. Verdict

- 178/178 unit + integration tests pass, 0 skipped, exit 0, on a clean rebuild of
  `lib/` against the final `src/` (2026-10-29).
- The reusable `ui-boot.mjs` harness reports 19/19 PASS against a real, freshly
  booted isolated DSH Web server: the profile composes, the bundle installs, the
  boot graph advertises the client half with the correct edges, and the served
  bundle is the package's client module registering all three slots.
- `npm pack --dry-run` is release-ready (35 files, 0.2.0, client half and
  projection included, no source/tests/verification).
- Remaining work for a human: restart the profile, refresh the page, and inspect
  the three surfaces in light and dark themes. The visual check is the only
  outstanding verification item.
