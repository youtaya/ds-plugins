# E2E evidence (sanitized, final passing evidence only)

This directory holds the committed evidence for the DESIGN §10 end-to-end verification
of `dsh-plugin-tool-usage` 0.1.0 (see `../../../e2e-report.md`). It contains two curated
sets, both sanitized:

- the files directly in this directory: the **pre-fix build** run of 2026-10-28
  (retained for history; see `../../../e2e-report.md` §3–§10);
- `final-build-2026-10-29/`: the **authoritative final-build re-run** after the review
  fixes — 23/23 assertions PASS (see `../../../e2e-report.md` §11).

Intermediate attempt artifacts produced during troubleshooting
(`run-1-workspace-write/`, `run-2-main-danger-full-access/` and the top-level per-run
logs) were removed from the release tree on 2026-10-29.

## Sanitization placeholders

Every machine-specific absolute path was replaced with a placeholder so the evidence is
portable and carries no personal paths:

| Placeholder | Replaced path |
| --- | --- |
| `<workspace>` | the `ds-plugins` checkout that contained `plugins/tool-usage` |
| `<dsh-checkout>` | the DSH source checkout used to run the harness |
| `<e2e-home>` | the isolated `DSH_HOME` (`<workspace>/.e2e-home`) |
| `<home>` | the user home directory, only where a path outside the checkout appeared (e.g. `~/.dsh`) |

Only path strings were changed. Run outcomes, timestamps, assertion results, numbers
and explanations are unmodified.

## Files and provenance

| File | Contents / provenance |
| --- | --- |
| `environment.json` | Harness environment facts of the passing main run (2026-10-28T09:07:21Z, `danger-full-access`). Path values replaced by placeholders. |
| `assertions-main-run.log` | 16/16 PASS assertions of the passing main run (setup, install, `--dump-config`, `bash` + `tool_usage` task). |
| `assertions-failure-case.log` | 6/6 PASS assertions of the deliberate failure path (`read` of a nonexistent path → `status: "error"`; failing `bash exit 3` recorded). |
| `calls-2026-10-28.jsonl` | Consolidated `calls-*.jsonl` records (7 records, 3 sessions) from the isolated home, including the two environment-failed `bash` attempts retained for honesty. |
| `stats.json` | `stats.json` snapshot from the same isolated home (cumulative over the verification runs; includes the two environment-failed attempts above). |
| `dump-config.stdout.txt` | Full `pnpm dsh --profile headless --dump-config` output proving the `# == dsh-plugin-tool-usage` layer and the `id: tool-usage` row. |
| `main.stdout.txt` | Model final answer of the passing main task, showing the `tool_usage` statistics table. |
| `error-call-records.jsonl` | JSONL records appended by the passing failure-case run (`read` → `FS_NOT_FOUND` `status: "error"`; `bash exit 3`). |
| `final-build-2026-10-29/README.md` | Provenance of the final-build re-run evidence set. |
| `final-build-2026-10-29/environment.json` | Harness environment facts of the final-build re-run (paths replaced by placeholders). |
| `final-build-2026-10-29/assertions.log` | 23/23 PASS assertions of the final-build re-run (`SUMMARY: 23 passed, 0 failed, 23 assertions`). |
| `final-build-2026-10-29/main-call-records.jsonl` | Call records appended by the main task of the final-build re-run. |
| `final-build-2026-10-29/stats-after-main.json` | Statistics snapshot after the main task of the final-build re-run. |
| `final-build-2026-10-29/error-call-records.jsonl` | Call records appended by the failure case of the final-build re-run. |
| `final-build-2026-10-29/stats-after-error.json` | Statistics snapshot after the failure case of the final-build re-run. |
| `final-build-2026-10-29/dump-config.stdout.txt` | `--dump-config` proof of the final-build re-run. |
| `final-build-2026-10-29/main.stdout.txt`, `main.stderr.txt`, `error.stdout.txt` | Task answers/stderr of the final-build re-run. |
| `final-build-2026-10-29/commands.log`, `init-profile.stdout.txt`, `plugin-add.stdout.txt` | Setup transcript of the final-build re-run. |

A fresh harness run (`node verification/e2e/setup-and-run.mjs`) writes new run artifacts
under `verification/e2e/artifacts/`; move the relevant ones into a new subdirectory here
(and re-apply the placeholder substitutions) before committing updated evidence. The
`final-build-2026-10-29/` set is exactly that: a genuine full run, not a hand-edited one.
