// Release guard: the pushed git tag must equal package.json's version (a leading "v" is optional),
// so a tag can never publish a build whose embedded version differs from the tag.
//   node scripts/check-release-version.mjs v1.2.3
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** True when `tag` (with an optional leading "v") is exactly `version`. */
export function matchesTag(tag, version) {
  if (typeof tag !== 'string' || typeof version !== 'string') return false
  const stripped = tag.startsWith('v') ? tag.slice(1) : tag
  return stripped.length > 0 && stripped === version
}

function main() {
  const tag = process.argv[2]
  if (!tag) {
    console.error('Usage: node scripts/check-release-version.mjs <tag>   (for example v1.2.3)')
    return 1
  }
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (matchesTag(tag, version)) {
    console.log(`OK: tag "${tag}" matches package.json version ${version}.`)
    return 0
  }
  console.error(
    `Tag "${tag}" does not match package.json version ${version}. ` +
      'Use `npm version patch|minor|major` so the commit and tag agree.'
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
