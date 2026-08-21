/**
 * Telling an incomplete upstream publish apart from a real install failure.
 *
 * The fixture below is the verbatim failure from CI run 32482765633, where
 * `dsh-base@0.1.1-rc.2` reached the registry ahead of its own dependency. Two
 * jobs in that run did the same install a minute apart; one passed. Reporting
 * that as a test failure sends someone hunting a regression that never existed.
 */
import { describe, expect, it } from 'vitest'
import { CLI_PACKAGE, isUpstreamGraphIncomplete, unresolvedDependency } from '../scripts/dsh-harness.ts'

const MID_PUBLISH = `Error: pnpm add @deepseek-ai/dsh@0.1.1-rc.1 failed (1)
 ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @deepseek-ai/dsh-skill-badge@^0.1.1-rc.2 while fetching it from https://registry.npmjs.org/
This error happened while installing the dependencies of @deepseek-ai/dsh@0.1.1-rc.1
 at @deepseek-ai/dsh-base@0.1.1-rc.2`

const BAD_SPEC = `Error: pnpm add @deepseek-ai/dsh@99.99.99 failed (1)
 ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @deepseek-ai/dsh@99.99.99 while fetching it from https://registry.npmjs.org/`

describe('unresolvedDependency', () => {
  it('names the package, keeping the scope and dropping the range', () => {
    expect(unresolvedDependency(MID_PUBLISH)).toBe('@deepseek-ai/dsh-skill-badge')
  })

  it('is undefined for a failure that is not a resolution failure', () => {
    expect(unresolvedDependency('Error: pnpm add failed (1)\nENOTFOUND registry')).toBeUndefined()
  })
})

describe('isUpstreamGraphIncomplete', () => {
  it('recognises upstream mid-publish, so the suite can skip loudly', () => {
    expect(isUpstreamGraphIncomplete(MID_PUBLISH, CLI_PACKAGE)).toBe(true)
  })

  it('does NOT excuse a version of the requested package that never existed', () => {
    // A typo in DSH_E2E_VERSION is a real error and must fail, not skip.
    expect(isUpstreamGraphIncomplete(BAD_SPEC, CLI_PACKAGE)).toBe(false)
  })

  it('does not excuse an unrelated failure', () => {
    expect(isUpstreamGraphIncomplete('Error: network unreachable', CLI_PACKAGE)).toBe(false)
  })
})
