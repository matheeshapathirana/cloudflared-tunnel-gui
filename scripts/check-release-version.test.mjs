// Run with Node's built-in runner (`npm run test:scripts`); Vitest only includes src/**.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

test('CLI exits non-zero for a bogus tag', () => {
  const result = spawnSync(process.execPath, [script, 'v999.0.0'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
})

test('CLI exits non-zero when no tag is given', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
})
