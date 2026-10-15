// Run with Node's built-in runner (`npm run test:scripts`); Vitest only includes src/**.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchesTag } from './check-release-version.mjs'

const script = fileURLToPath(new URL('./check-release-version.mjs', import.meta.url))
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
)

test('a v-prefixed tag matches the same version', () => {
  assert.equal(matchesTag('v1.0.0', '1.0.0'), true)
})

test('the leading v is optional', () => {
  assert.equal(matchesTag('1.0.0', '1.0.0'), true)
})

test('a different version does not match', () => {
  assert.equal(matchesTag('v1.0.1', '1.0.0'), false)
})

test('a pre-release tag does not match the stable version', () => {
  assert.equal(matchesTag('v1.0.0-beta.1', '1.0.0'), false)
})

test('an empty tag does not match', () => {
  assert.equal(matchesTag('', '1.0.0'), false)
})

test('CLI exits 0 for the current package.json version', () => {
  const result = spawnSync(process.execPath, [script, `v${pkg.version}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
})

test('CLI exits 1 for a bogus tag', () => {
  const result = spawnSync(process.execPath, [script, 'v999.0.0'], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr + result.stdout)
})

test('CLI exits 1 when no tag is given', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr + result.stdout)
})

test('CLI still enforces the guard when invoked through a junction/symlink path', (t) => {
  // Node's ESM loader resolves symlinks for import.meta.url but process.argv[1] keeps the link path,
  // so the two differ textually. The guard used to silently exit 0 in that case.
  const dir = mkdtempSync(join(tmpdir(), 'release-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const link = join(dir, 'scripts-link')
  try {
    // 'junction' needs no admin rights on Windows and is ignored on other platforms.
    symlinkSync(dirname(script), link, 'junction')
  } catch (err) {
    t.skip(`cannot create a directory link here: ${err.message}`)
    return
  }
  const viaLink = join(link, basename(script))
  assert.notEqual(viaLink, script)

  const bogus = spawnSync(process.execPath, [viaLink, 'v999.0.0'], { encoding: 'utf8' })
  assert.equal(bogus.status, 1, bogus.stderr + bogus.stdout)

  const ok = spawnSync(process.execPath, [viaLink, `v${pkg.version}`], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
})
