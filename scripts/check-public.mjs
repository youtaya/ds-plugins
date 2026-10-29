#!/usr/bin/env node
/**
 * Public-release hygiene check.
 *
 * Scans the files that would be committed (tracked plus untracked-but-not-ignored)
 * for machine-specific home directories and common credential shapes. This is a
 * safety net, not a secret scanner: it complements, and never replaces, a manual
 * review plus GitHub secret scanning.
 *
 * Usage: node scripts/check-public.mjs
 * Exit code: 0 when clean, 1 when a finding is reported.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.gz', '.tgz', '.pdf',
])

/** Files or patterns that may legitimately mention user-home examples or fixtures. */
const ALLOWED_PATHS = [
  /^scripts\/check-public\.mjs$/,
]

/**
 * @typedef {{ name: string, pattern: RegExp }} Rule
 * @type {Rule[]}
 */
const RULES = [
  {
    name: 'macOS user-home path',
    // /Users/me, /Users/you, /Users/example and the CI /Users/runner are placeholders.
    pattern: /\/Users\/(?!me(?:\/|$)|you(?:\/|$)|example(?:\/|$)|runner(?:\/|$))[A-Za-z0-9._-]+\//,
  },
  {
    name: 'Linux user-home path',
    pattern: /\/home\/(?!runner(?:\/|$))[A-Za-z0-9._-]+\//,
  },
  {
    name: 'Windows user-home path',
    pattern: /(?:^|[\s"'=(\[<])[A-Za-z]:[\\/]Users[\\/](?!me[\\/]|you[\\/]|example[\\/])[A-Za-z0-9._-]+/,
  },
  {
    name: 'private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: 'API key (sk-)',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  },
  {
    name: 'AWS access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
]

/** @returns {string[]} workspace-relative paths. */
function listCandidateFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.split('\0').filter((entry) => entry.length > 0)
  } catch {
    return walk(process.cwd()).map((file) => path.relative(process.cwd(), file).split(path.sep).join('/'))
  }
}

/** @param {string} directory @returns {string[]} absolute paths. */
function walk(directory) {
  const skip = new Set(['.git', 'node_modules', '.e2e-home', '.pnpm-store', '.tmp'])
  /** @type {string[]} */
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skip.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** @returns {{ file: string, line: number, rule: string, preview: string }[]} */
function scan() {
  const findings = []
  for (const file of listCandidateFiles()) {
    if (ALLOWED_PATHS.some((pattern) => pattern.test(file))) continue
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    const absolute = path.resolve(file)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue
    let text
    try {
      text = fs.readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue
        const preview = line.trim().slice(0, 160)
        findings.push({ file, line: index + 1, rule: rule.name, preview })
      }
    }
  }
  return findings
}

const findings = scan()
if (findings.length === 0) {
  console.log(`check-public: OK — no machine-specific paths or credentials found in ${listCandidateFiles().length} candidate files`)
  process.exit(0)
}

console.error(`check-public: ${findings.length} finding(s)`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}: ${finding.rule} — ${finding.preview}`)
}
console.error('check-public: replace machine-specific values with placeholders, or allowlist a reviewed example in scripts/check-public.mjs')
process.exit(1)
