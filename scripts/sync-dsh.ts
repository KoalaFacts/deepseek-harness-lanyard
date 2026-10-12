/**
 * Move `@deepseek-ai/dsh` and the `@deepseek-ai/dsh-*` devDependencies to the
 * release `dsh@latest` ships, so the unit suite runs against what a person installs today.
 *
 * Dependabot cannot do this. It follows a prerelease only within its own base
 * version — 0.2.0-rc.2 to 0.2.0-rc.3, never to 0.2.1-rc.1 — and the library
 * packages' own `latest` tag points at an abandoned 0.0.1 build. The CLI's tag
 * is the one that means something, and dsh publishes every package it depends
 * on at exactly its own version, so that one version is the target for all.
 *
 *   node scripts/sync-dsh.ts           rewrite package.json, then `pnpm install`
 *   node scripts/sync-dsh.ts --check   exit 1 if package.json lags, change nothing
 *
 * Either form exits 2, SKIPPED, when the registry cannot be asked.
 *
 * Only devDependencies move. The peer ranges are the supported window, and
 * with no upper bound a new release already satisfies them.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The package whose `latest` dist-tag names the release to track. */
export const CLI_PACKAGE = '@deepseek-ai/dsh'

/** devDependencies released in lockstep with {@link CLI_PACKAGE}, besides the CLI itself. */
export const LOCKSTEP_PREFIX = '@deepseek-ai/dsh-'

/** Whether a devDependency moves with {@link CLI_PACKAGE}. */
function inLockstep(name: string): boolean {
  return name === CLI_PACKAGE || name.startsWith(LOCKSTEP_PREFIX)
}

/**
 * The range a devDependency should name for `version`: always exact. A caret
 * range would admit a later prerelease — `^0.2.0-rc.2` takes `0.2.0-rc.3` from
 * `next` while `latest` still names rc.2 — so an install could mix release
 * lines while the range strings still read as tracking `latest`.
 * @param version - the release to track.
 * @returns the range to write.
 */
export function syncedRange(version: string): string {
  return version
}

/**
 * Every lockstep devDependency whose range differs from what `version` wants.
 * @param devDependencies - package.json's devDependencies.
 * @param version - the release to track.
 * @returns name, current range and wanted range, for each one that moves.
 */
export function drift(devDependencies: Record<string, string>, version: string): Array<{ name: string; from: string; to: string }> {
  return Object.entries(devDependencies)
    .filter(([name]) => inLockstep(name))
    .map(([name, from]) => ({ name, from, to: syncedRange(version) }))
    .filter(({ from, to }) => from !== to)
}

/** Ask the registry what `dsh@latest` is; any failure is fatal rather than read as "nothing to do". */
function latestVersion(): string {
  const done = spawnSync('npm', ['view', `${CLI_PACKAGE}@latest`, 'version', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (done.status !== 0) throw new Error(`npm view ${CLI_PACKAGE}@latest failed (${String(done.status)}): ${done.stderr}`)
  const version: unknown = JSON.parse(done.stdout)
  if (typeof version !== 'string' || version === '') throw new Error(`npm view ${CLI_PACKAGE}@latest returned no version`)
  return version
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(realpathSync(invoked)).href) {
  const path = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json')
  const text = readFileSync(path, 'utf8')
  const manifest = JSON.parse(text) as { devDependencies: Record<string, string> }
  let version: string
  try {
    version = latestVersion()
  } catch (error) {
    // Not a lag: nothing was compared. Exit 2, as the e2e suites do when they cannot run.
    console.error(`lanyard: SKIPPED — could not ask the registry for ${CLI_PACKAGE}@latest`, error)
    process.exit(2)
  }
  const moves = drift(manifest.devDependencies, version)
  for (const { name, from, to } of moves) console.log(`  ${name}: ${from} -> ${to}`)
  if (moves.length === 0) {
    console.log(`lanyard: devDependencies already track ${CLI_PACKAGE}@latest (${version})`)
  } else if (process.argv.includes('--check')) {
    console.error(`lanyard: devDependencies lag ${CLI_PACKAGE}@latest (${version}); run \`node scripts/sync-dsh.ts && pnpm install\``)
    process.exitCode = 1
  } else {
    for (const { name, to } of moves) manifest.devDependencies[name] = to
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`lanyard: moved ${String(moves.length)} devDependencies to ${version}; now run \`pnpm install\``)
  }
}
