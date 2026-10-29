/**
 * Static package / bundle checks for dsh-plugin-tool-usage.
 *
 * These tests never import the compiled modules; they validate the installable
 * bundle shape described in docs/DESIGN.md §3, §4, §7, and §15.7. They run from
 * plugins/tool-usage and read the package manifest, the Cordis bundle patch,
 * the locale metadata and the published `files` list on disk.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import vm from 'node:vm'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const manifestPath = join(packageDir, 'package.json')

/** Read and parse a JSON file inside the package. */
async function readJson(relativePath) {
  return JSON.parse(await readFile(join(packageDir, relativePath), 'utf8'))
}

/** Stat a path, returning undefined when it does not exist. */
async function statOrUndefined(absolutePath) {
  try {
    return await stat(absolutePath)
  } catch {
    return undefined
  }
}

/** Convert one glob path segment (no '/') into an anchored RegExp. */
function segmentToRegExp(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Minimal glob expansion for the conservative patterns used by `files`:
 * literal segments, single-`*` segments, and `**` segments. Returns package
 * relative file paths (directories never match a `**` leaf).
 */
async function expandGlob(pattern) {
  const parts = pattern.split('/')
  const matches = []

  async function walk(relativeDir, index) {
    if (index === parts.length) return
    const part = parts[index]
    const absoluteDir = relativeDir ? join(packageDir, relativeDir) : packageDir
    const isLast = index === parts.length - 1

    if (part === '**') {
      // `**` can match zero path segments ...
      if (!isLast) await walk(relativeDir, index + 1)
      // ... or one or more directories.
      const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nextDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
          await walk(nextDir, index)
        }
      }
      return
    }

    if (part.includes('*')) {
      const matcher = segmentToRegExp(part)
      const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!matcher.test(entry.name)) continue
        const nextRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        if (isLast) {
          if (entry.isFile()) matches.push(nextRelative)
        } else if (entry.isDirectory()) {
          await walk(nextRelative, index + 1)
        }
      }
      return
    }

    const nextRelative = relativeDir ? `${relativeDir}/${part}` : part
    if (isLast) {
      const entryStat = await statOrUndefined(join(packageDir, nextRelative))
      if (entryStat?.isFile()) matches.push(nextRelative)
      return
    }
    const entryStat = await statOrUndefined(join(packageDir, nextRelative))
    if (entryStat?.isDirectory()) await walk(nextRelative, index + 1)
  }

  await walk('', 0)
  return matches
}

/** Parse a semver string into comparable parts. Throws on invalid input. */
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  assert.ok(match, `invalid semver version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** Compare two prerelease identifier arrays per semver §11. */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1 // release > prerelease
  if (right.length === 0) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b)
      if (delta !== 0) return delta
      continue
    }
    if (aNumeric) return -1 // numeric identifiers sort before alphanumeric
    if (bNumeric) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Compare two parsed versions; returns -1, 0 or 1. */
function compareVersions(left, right) {
  const coreLeft = [left.major, left.minor, left.patch]
  const coreRight = [right.major, right.minor, right.patch]
  for (let index = 0; index < 3; index += 1) {
    if (coreLeft[index] !== coreRight[index]) return coreLeft[index] < coreRight[index] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** Minimal semver range evaluator for `>= > <= < =` comparators. */
function rangeIncludes(range, version) {
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  assert.ok(comparators.length > 0, 'semver range must not be empty')
  const target = parseVersion(version)
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator)
    assert.ok(match, `unsupported semver comparator: ${comparator}`)
    const operator = match[1] ?? '='
    const bound = parseVersion(match[2])
    const delta = compareVersions(target, bound)
    switch (operator) {
      case '>=': return delta >= 0
      case '>': return delta > 0
      case '<=': return delta <= 0
      case '<': return delta < 0
      case '=': return delta === 0
      default: assert.fail(`unsupported semver operator: ${operator}`)
    }
  })
}

// NOTE: node:test discovers fresh processes per file; top-level awaits are fine here.
const manifest = await readJson('package.json')

test('package.json declares the expected plugin identity and module format', () => {
  assert.equal(manifest.name, 'dsh-plugin-tool-usage')
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.icon, './icon.svg')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.types, 'lib/types/index.d.ts')
})

test('package.json exposes the bundle patch, locale and package.json subpaths', () => {
  assert.equal(typeof manifest.dsh, 'object')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['.'].types, './lib/types/index.d.ts')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./package.json'], './package.json')
})

test('package.json declares the Web client half for the installed bundle', () => {
  assert.equal(typeof manifest.dsh.client, 'object', 'dsh.client block is required for the browser half')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(Array.isArray(manifest.dsh.client.inject), 'dsh.client.inject must be an array')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
  assert.ok(manifest.files.includes('client.js'), 'client.js must ship in the package files list')
})

test('client.js is a parseable plain-JS module-loader bundle with no harness imports', async () => {
  const source = await readFile(join(packageDir, 'client.js'), 'utf8')
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'client.js' }), 'client.js must parse as a script')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, /id:\s*['"]dsh-plugin-tool-usage['"]/)
  assert.match(source, /factory\(require\)/)
  // The only module-table require allowed is React; Harness Client packages are
  // not a stable API for out-of-tree plugins.
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
  assert.doesNotMatch(source, /\bimport\s+[^;]*from\s+['"]/)
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-client-/)
})

test('engines.dsh admits the pinned DSH 0.2.2-alpha.2 and rejects other minors', () => {
  const range = manifest.engines?.dsh
  assert.equal(typeof range, 'string')
  assert.equal(range, '>=0.2.0-0 <0.3.0')
  assert.equal(rangeIncludes(range, '0.2.2-alpha.2'), true)
  assert.equal(rangeIncludes(range, '0.2.0'), true)
  assert.equal(rangeIncludes(range, '0.1.9'), false)
  assert.equal(rangeIncludes(range, '0.3.0'), false)
})

test('peer/dev dependencies match DESIGN §3 and there are no runtime dependencies', () => {
  const required = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-commands']
  for (const dependency of required) {
    assert.equal(typeof manifest.peerDependencies?.[dependency], 'string', `missing peer dependency ${dependency}`)
    assert.equal(typeof manifest.devDependencies?.[dependency], 'string', `missing dev dependency ${dependency}`)
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '>=0.2.0-0 <0.3.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '>=4.0.0-0 <5.0.0')
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {})
  assert.deepEqual(runtimeDependencies, [], 'the plugin must ship with zero runtime dependencies')
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'] !== undefined, true)
})

test('cordis.patch.yml inserts the tool-usage plugin under the expected id and name', async () => {
  const patch = await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /-\s*insert:/, 'patch must contain an insert row')
  assert.match(patch, /-\s*id:\s*tool-usage\b/, 'patch must insert id `tool-usage`')
  assert.match(patch, /name:\s*dsh-plugin-tool-usage\b/, 'patch must insert name `dsh-plugin-tool-usage`')
  // §4: keep the patch minimal so user overrides only restate changed keys.
  assert.doesNotMatch(patch, /^\s+config:/m, 'patch must not pin a config block')
})

test('locale/en.json and locale/zh.json parse and carry non-empty metadata', async () => {
  for (const [locale, detailFile] of [['en', 'docs/DETAIL.md'], ['zh', 'docs/DETAIL.zh.md']]) {
    const metadata = await readJson(`locale/${locale}.json`)
    assert.equal(typeof metadata.meta, 'object', `${locale}.json needs a meta object`)
    assert.equal(typeof metadata.meta.title, 'string')
    assert.ok(metadata.meta.title.trim().length > 0, `${locale}.json meta.title must be non-empty`)
    assert.equal(typeof metadata.meta.description, 'string')
    assert.ok(metadata.meta.description.trim().length > 0, `${locale}.json meta.description must be non-empty`)
    assert.equal(metadata.meta.detail, detailFile)
    const detailStat = await statOrUndefined(join(packageDir, detailFile))
    assert.ok(detailStat?.isFile(), `${detailFile} must exist because locale/${locale}.json references it`)
  }
})

test('every path listed in package.json `files` exists on disk', async () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  const missing = []
  for (const entry of manifest.files) {
    const exact = await statOrUndefined(join(packageDir, entry))
    if (exact !== undefined) continue // literal file or directory (e.g. "docs")
    if (!entry.includes('*')) {
      missing.push(entry)
      continue
    }
    const matches = await expandGlob(entry)
    if (matches.length === 0) missing.push(`${entry} (glob matched no files)`)
  }
  assert.deepEqual(missing, [], `package.json files entries missing from the package: ${missing.join(', ')}`)
})

test('the main entry and the types entry exist after a build', async () => {
  const mainStat = await statOrUndefined(join(packageDir, manifest.main))
  assert.ok(mainStat?.isFile(), `${manifest.main} must exist (run \`node scripts/build.mjs\`)`)
  const typesStat = await statOrUndefined(join(packageDir, manifest.types))
  assert.ok(typesStat?.isFile(), `${manifest.types} must exist (run \`node scripts/build.mjs\`)`)
  // Every emitted lib module must be importable by bare ESM: `.js` specifiers only.
  const emitted = await expandGlob('lib/**/*.js')
  assert.ok(emitted.length >= 5, `expected at least 5 emitted lib modules, found ${emitted.length}`)
  for (const relativePath of emitted) {
    assert.match(relativePath, /\.js$/u)
  }
})

test('compiled lib modules only import node builtins, relative modules, or dsh-tools', async () => {
  const emitted = await expandGlob('lib/**/*.js')
  const offenders = []
  for (const relativePath of emitted) {
    const source = await readFile(join(packageDir, relativePath), 'utf8')
    const specifiers = [...source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1])
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('node:')
        || specifier.startsWith('./')
        || specifier.startsWith('../')
        || specifier === '@deepseek-ai/dsh-tools'
        || specifier.startsWith('@deepseek-ai/dsh-tools/')
      if (!allowed) offenders.push(`${relativePath} -> ${specifier}`)
    }
    assert.doesNotMatch(source, /\bprocess\.exit\s*\(/, `${relativePath} must not call process.exit()`)
  }
  assert.deepEqual(offenders, [], `unexpected runtime imports: ${offenders.join(', ')}`)
})
