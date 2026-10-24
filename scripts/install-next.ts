/**
 * Install upstream's `next` line over the lockfile pins, for the nightly
 * contract job, telling an incomplete upstream publish apart from a real
 * failure the same way the e2e suites do.
 *
 * dsh publishes as a wave of packages pinned to each other, so for a while
 * after `next` moves its graph does not resolve. That exits 2, SKIPPED — not a
 * verdict on this plugin. A missing version of a package this asked for by
 * name is a bad spec, and stays a real failure.
 */

import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { ROOT, run, unresolvedDependency } from './dsh-harness.ts'

/** What the contract job tests against: the CLI's whole surface, plus the three contracts the unit suite reads. */
export const NEXT_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-connection',
]

/**
 * Whether an install failure is upstream mid-publish: something the requested
 * packages depend on is missing, rather than one of the packages themselves.
 * @param reported - the failing command's combined output.
 * @param requested - the packages this install asked for by name.
 */
export function isWaveIncomplete(reported: string, requested: readonly string[]): boolean {
  const unresolved = unresolvedDependency(reported)
  return unresolved !== undefined && !requested.includes(unresolved)
}

const invoked = process.argv[1]
if (invoked !== undefined && invoked !== '-' && import.meta.url === pathToFileURL(realpathSync(invoked)).href) {
  try {
    run('pnpm', ['add', '-D', ...NEXT_PACKAGES.map(name => `${name}@next`)], { cwd: ROOT })
  } catch (error) {
    const reported = String(error)
    if (!isWaveIncomplete(reported, NEXT_PACKAGES)) throw error
    console.error(`lanyard contract: next does not currently install — the registry has no ${String(unresolvedDependency(reported))} it depends on.`)
    console.error('lanyard contract: that is an upstream publish state, not a verdict on this plugin. Nothing was tested.')
    console.error('lanyard contract: SKIPPED (not passed).')
    process.exit(2)
  }
}
