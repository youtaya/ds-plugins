# dsh-plugins

[![CI](https://github.com/youtaya/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/youtaya/dsh-plugins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.9-3c873a.svg)](package.json)

English | [中文](README.zh.md)

Out-of-tree bundle plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Each package under `plugins/` is a normal installable DSH bundle: it ships a `cordis.patch.yml` layer, commits its built `lib/` output, and can be installed into any profile with `dsh plugin add`. The plugins are community-maintained and are not part of the DSH repository.

## Packages

| Package | Version | Description | Documentation |
| --- | --- | --- | --- |
| [`dsh-plugin-tool-usage`](plugins/tool-usage) | 0.2.0 | Records every agent tool call with redacted parameters and a readable explanation, reports per-tool call counts, errors, and latency, and adds a live Web UI dashboard (per-turn cards, session calls view, and a right-side live tool-call stream). | [English](plugins/tool-usage/README.md) · [中文](plugins/tool-usage/README.zh.md) |

Each package has its own README with the full behavior, configuration, and privacy documentation; this file covers the repository as a whole.

## Requirements

- **DSH** `>=0.2.0-0 <0.3.0` — the range is declared in each package's `engines.dsh` and enforced by DSH at install and startup. Verification in this repository was run against DSH `0.2.2-alpha.2`.
- **Node.js** `>=24.9` for development (`.nvmrc` pins `24.19.0`). An installed plugin runs inside the DSH host process and adds no runtime dependency of its own.

Installing a plugin from this repository needs neither a build step nor a DSH source checkout: `lib/` is committed. Building from source uses the npm dev dependencies, or a DSH source checkout when `npm install` is not available.

## Install a plugin

`dsh plugin add` takes an absolute path to the package directory, so clone this repository first (or point at an existing checkout):

```sh
git clone https://github.com/youtaya/dsh-plugins.git
cd dsh-plugins

# Install one bundle into a profile (a profile is initialized on first use).
dsh plugin --profile <profile> add "$PWD/plugins/tool-usage"

# Prove the bundle layer is present, then start the profile.
dsh --profile <profile> --dump-config   # look for "# == dsh-plugin-tool-usage" and a row with id "tool-usage"
dsh --profile <profile>
```

The bundle takes effect after the profile restarts. Remove it with:

```sh
dsh plugin --profile <profile> remove dsh-plugin-tool-usage
```

The packages are not yet published to npm; installing from a local package directory is the supported path. See the package README for configuration overrides and the data directory location.

## Repository layout

```
.
├── .github/workflows/ci.yml     # install → build → lib freshness → tests → package check → public check
├── docs/DESIGN.md               # authoritative design contract for dsh-plugin-tool-usage
├── scripts/check-public.mjs     # scans committable files for home paths and credential shapes
└── plugins/
    └── tool-usage/              # dsh-plugin-tool-usage
        ├── src/                 # TypeScript sources
        ├── lib/                 # committed build output (ESM + .d.ts)
        ├── client.js            # plain-JavaScript Web client bundle (no build step)
        ├── scripts/build.mjs    # deterministic clean build (npm typescript or DSH checkout)
        ├── cordis.patch.yml     # bundle layer: inserts the tool-usage row
        ├── locale/{en,zh}.json  # plugin display metadata
        ├── docs/DETAIL*.md      # plugin detail pages shipped with the package
        ├── tests/               # node:test suite against the built lib/
        └── verification/        # unit/E2E/live-activation/UI reports and harnesses
```

## Development

```sh
cd plugins/tool-usage
npm install          # dev dependencies: typescript, @types/node, DSH alpha type packages
npm run build        # regenerate the committed lib/
npm test             # node:test suite
```

From the repository root:

```sh
npm run verify       # build + test
npm run pack:check   # npm pack --dry-run for the plugin package
npm run check:public # home-path and credential scan over committable files
```

If `npm install` is unavailable, build against a DSH source checkout instead:

```sh
DSH_CHECKOUT=/path/to/deepseek-harness node plugins/tool-usage/scripts/build.mjs
```

`lib/` is committed, and CI fails if it differs from a fresh build, so rebuild and include it whenever `src/` changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for repository conventions.

## Verification

Each package ships its evidence under `plugins/<name>/verification/`:

- [`unit-report.md`](plugins/tool-usage/verification/unit-report.md) — build and test commands, per-file results, and the environment used.
- [`e2e-report.md`](plugins/tool-usage/verification/e2e-report.md) — a real headless DSH process in an isolated `DSH_HOME`, with PASS/FAIL per assertion and the exact commands.
- [`live-activation.md`](plugins/tool-usage/verification/live-activation.md) — activation in a running Web profile, with live JSONL records, `stats.json`, and a real `tool_usage` report.
- [`ui-activation.md`](plugins/tool-usage/verification/ui-activation.md) — the 0.2.0 Web UI evidence: unit/browser-half results, the isolated real-Web-server boot check (boot graph + served client bundle), the upgrade/refresh path, and the remaining visual-verification limit.
- [`e2e/setup-and-run.mjs`](plugins/tool-usage/verification/e2e/setup-and-run.mjs) — reusable E2E harness with `--dry-run`, `--no-llm`, `--skip-error`, and `--error-only` modes; it recreates its own isolated home and never touches the live `~/.dsh`.
- [`ui-boot.mjs`](plugins/tool-usage/verification/ui-boot.mjs) — reusable Web UI packaging check: installs the bundle into an isolated `web` profile, boots the real Web server, and asserts the boot graph advertises the client half and the served bundle registers the three slots.

```sh
DSH_CHECKOUT=/path/to/deepseek-harness node plugins/tool-usage/verification/e2e/setup-and-run.mjs
```

The E2E harness needs a DSH CLI and, for the LLM-backed runs, credentials in `~/.dsh/.credentials.yaml`; it reads them in-process and never writes them to the workspace. On hosts where a child DSH cannot nest a sandbox, run the one-shot task with `DSH_PERMISSION_MODE=danger-full-access` as described in the E2E report.

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) is the authoritative contract for `dsh-plugin-tool-usage`: manifest, bundle patch, runtime behavior, redaction and explanation rules, statistics semantics, storage, build, tests, and the privacy/threat model. Behavior changes update the contract first.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); for security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE) © 2026 youtaya. Each package also declares its own license in its `package.json`.
