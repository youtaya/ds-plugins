#!/usr/bin/env node
/**
 * Standalone runner for DESIGN §10 assertion 5 — the deliberate failure path.
 *
 * It re-runs ONLY the failure-case headless task against the isolated host
 * created by `setup-and-run.mjs` (`.e2e-home` with `dsh-plugin-tool-usage`
 * installed in the headless profile). The task forces a `read` of a nonexistent
 * path (a real `isError` result) plus a failing `bash` (`exit 3`); the harness
 * asserts that an `error`-status record exists in `calls-*.jsonl`. It makes
 * exactly one LLM run.
 *
 * Prerequisite: one full `setup-and-run.mjs` run (or at least `--skip-error`).
 * Credentials are read from `~/.dsh/.credentials.yaml` in-process and passed to
 * the child only through the environment; they are never printed.
 *
 * Usage:
 *   node plugins/tool-usage/verification/e2e/run-error-case.mjs
 *   node plugins/tool-usage/verification/e2e/run-error-case.mjs --help
 *
 * Exit code: 0 only when the failure-path assertions pass.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SETUP_SCRIPT = fileURLToPath(new URL('./setup-and-run.mjs', import.meta.url))

// Delegate to the single implementation so both entrypoints share one code
// path (`--error-only` reuses the isolated home instead of recreating it).
const child = spawn(process.execPath, [SETUP_SCRIPT, '--error-only', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

child.on('error', (error) => {
  process.stderr.write(`run-error-case: failed to start harness: ${error.message}\n`)
  process.exit(1)
})
child.on('close', (code) => {
  process.exit(code ?? 1)
})
