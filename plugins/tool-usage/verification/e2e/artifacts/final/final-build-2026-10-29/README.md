# Final-build E2E evidence (2026-10-29)

Artifacts of the full `verification/e2e/setup-and-run.mjs` run executed on the final
`lib/` after the post-review fixes. Sanitized with the placeholders defined in
`../README.md`; run outcomes, timestamps, numbers and explanations are unmodified.

- Result: `SUMMARY: 23 passed, 0 failed, 23 assertions` (exit 0), 2 model-backed runs
  (main task + failure case), no retry.
- Build under test: `npm run build` → 3,299 lines / 22 files; unit suite 133/133.
- Environment: Node v24.19.0, Darwin arm64, DSH 0.2.2-alpha.2 source execution,
  isolated `<e2e-home>`; live `~/.dsh` untouched.
- See `../../../e2e-report.md` §11 for the assertion-to-requirement mapping.

| File | Contents |
| --- | --- |
| `environment.json` | Harness environment facts (paths replaced) |
| `assertions.log` | All assertions verbatim, ending in the 23/23 summary |
| `main-call-records.jsonl` | Call records from the main task |
| `stats-after-main.json` | Statistics snapshot after the main task |
| `error-call-records.jsonl` | Call records from the failure case |
| `stats-after-error.json` | Statistics snapshot after the failure case |
| `dump-config.stdout.txt` | `--dump-config` layer proof |
| `main.stdout.txt`, `main.stderr.txt`, `error.stdout.txt` | Task answers and stderr |
| `commands.log`, `init-profile.stdout.txt`, `plugin-add.stdout.txt` | Setup transcript |
