# Changelog

All notable changes to the plugins in this repository are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and each package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Plugins are versioned independently; the version in a heading belongs to the
plugin named in that section.

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

[0.1.0]: https://github.com/youtaya/dsh-plugins/releases/tag/v0.1.0
