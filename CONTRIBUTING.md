# Contributing to dsh-plugins

Thanks for taking a look. This repository holds out-of-tree
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle
plugins. Each package under `plugins/` is independently versioned and installable
with `dsh plugin --profile <profile> add <absolute path>`.

## Development setup

Requirements: Node.js >= 24.9 (`.nvmrc` pins the version used for the committed
build), and a DSH installation for running the plugin. Building from source does
**not** require a DSH checkout when the npm dev dependencies are installed.

```sh
nvm use                       # or any Node >= 24.9
cd plugins/tool-usage
npm install                   # dev dependencies only (typescript, DSH alpha types)
npm run build                 # regenerate lib/ (committed)
npm test                      # node:test suite against lib/
```

If `npm install` is not an option, `scripts/build.mjs` can also build against a
DSH source checkout: set `DSH_CHECKOUT=/path/to/deepseek-harness` and it links the
checkout's `typescript` and `@deepseek-ai/*` packages into `node_modules/`
(dev-only, gitignored).

From the repository root, `npm run verify` builds and tests the plugin, and
`npm run check:public` scans the files that would be committed for
machine-specific paths and credential-shaped strings.

## Conventions

- **`lib/` is committed.** Rebuild it whenever `src/` changes and include the
  output in the same change; CI fails if `lib/` differs from a fresh build.
- **No third-party runtime dependencies.** Runtime imports are limited to
  `node:*` builtins and `@deepseek-ai/dsh-tools`. Configuration validation is
  hand-written. Adding a runtime dependency is a design decision, not a detail.
- **Never change a tool result.** Instrumentation hooks measure and record; they
  do not alter results, signals, or call identity, and recording failures are
  contained.
- **Tests run against built output** (`lib/`), never against `src/` through a
  transpiler. Use `node:test` and `node:assert/strict` only.
- **Documentation is part of the change.** English and Chinese docs are kept in
  parallel (`README.md` / `README.zh.md`, `docs/DETAIL.md` / `docs/DETAIL.zh.md`),
  and the config table must match `src/config.ts`.
- **Behavior changes update the contract first.** `docs/DESIGN.md` is the
  authoritative design document for the plugin; if the implementation must
  deviate, update the document in the same change and say why.
- **Verification evidence is tracked.** Unit and E2E reports live under
  `plugins/*/verification/`; do not add machine-specific paths or secrets to
  them (see `SECURITY.md`).

## Adding a plugin

1. Create `plugins/<name>/` with a `package.json` declaring `dsh.bundle.patch`, a
   `cordis.patch.yml` layer, committed `lib/` output, bilingual README/docs,
   `locale/{en,zh}.json`, and tests.
2. Add it to the package table in the root README (both languages).
3. Describe it in `docs/DESIGN.md` or add a sibling design document under
   `docs/`.
4. Run `npm run verify` and `npm run check:public` before opening a pull request.

## Pull requests

- Keep changes focused; one concern per pull request.
- Describe behavior changes and the verification you ran.
- Add a `CHANGELOG.md` entry under `Unreleased` for user-visible changes.
- CI must pass: install, build, `lib/` freshness, tests, package dry-run, public
  check.

## Reporting issues

Use the repository issue tracker for bugs and feature requests. For security
problems, follow `SECURITY.md` instead of opening a public issue.

## License

By contributing, you agree that your contribution is licensed under the MIT
License (see `LICENSE`).
