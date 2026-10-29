# Changelog

All notable changes to the plugins in this repository are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and each package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Plugins are versioned independently; the version in a heading belongs to the
plugin named in that section.

## [0.2.0] - 2026-10-29

### Added

- `dsh-plugin-tool-usage` 0.2.0 — Web UI dashboard release.
  - Host-registered session projection `toolUsage` that folds tool-call and turn
    events into one derived view: session totals, per-tool aggregates, a turn
    timeline, a bounded window of recent settled calls, and the currently
    running calls. The projection declares `wire.summary: false`, so it is not
    carried in session-list summaries, and its wire payload contains only
    derived data — the one-line explanation summary, the shell command line,
    aggregate numbers, and bounded failure text for failed calls — never the
    recorded raw parameter object.
  - Two Web UI surfaces served by a plain-JavaScript client bundle
    (`client.js`, declared through `dsh.client`, no build step): a session-wide
    "Calls" / 「调用看板」 conversation view tab (`conversation.view`), and a
    right-Sidebar "Calls stream" / 「调用流」 tab that auto-opens once when the
    current Session starts running and shows a scrollable fixed-length
    newest-first list of shell commands and tool calls (latest 50, running calls
    pinned with a ticking elapsed time) with a labeled purpose line per call.
    Both surfaces carry Chinese/English copy and theme-token styling; the right
    tab falls back to Chat data when the Host projection is unavailable.
  - New optional config fields: `uiEnabled` (default `true`), `uiRecentCalls`
    (default `60`, 1–500), `uiRecentTurns` (default `30`, 1–200), and
    `uiCommandChars` (default `240`, 1–1000). Override them by id `tool-usage`
    in `cordis.patch.yml`. The views reuse the existing `language` and
    `explain` settings for call explanations.
  - Projection unit tests and client bundle tests covering the three slot
    registrations, the rendered dashboard content, and the bounded wire view.

## [0.1.0] - 2026-10-29

### Added

- `dsh-plugin-tool-usage` 0.1.0 — first public release.
  - Records every `tools/execute` call to a per-day JSONL file with redacted and
    truncated parameters, timing, status (`ok` / `error` / `aborted` / `threw`),
    call id, session id, and a deterministic human-readable explanation
    (Chinese or English, brief or detailed).
  - In-memory per-tool and per-session aggregation with an atomic, debounced
    `stats.json` snapshot and optional restore on restart.
  - Model-facing read-only `tool_usage` tool (`summary`, `tools`, `recent`,
    `explain` views; session/all scopes).
  - Optional `/tool-usage` slash command for Web/Desktop profiles; the plugin
    still loads in headless profiles.
  - Zero third-party runtime dependencies; installation needs no build step
    because `lib/` is committed.
  - Bounded records: arguments, failure messages, and explanations are all capped
    before they are stored, and statistics restored from disk are merged into the
    live in-memory store instead of replacing it.
  - Unit suite (133 tests), a real headless DSH end-to-end run in an isolated
    `DSH_HOME`, and live Web-profile activation evidence under
    `plugins/tool-usage/verification/`.

[0.2.0]: https://github.com/youtaya/dsh-plugins/releases/tag/v0.2.0
[0.1.0]: https://github.com/youtaya/dsh-plugins/releases/tag/v0.1.0
