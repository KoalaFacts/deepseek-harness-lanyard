/** The nightly contract install: an incomplete upstream wave is SKIPPED, a bad spec is not. */
import { describe, expect, it } from 'vitest'
import { NEXT_PACKAGES, isWaveIncomplete } from '../scripts/install-next.ts'

describe('installing next for the contract job', () => {
  it('reads a dependency the wave has not published yet as an incomplete upstream graph', () => {
    const reported = ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @deepseek-ai/dsh-skill-badge@0.3.0-rc.1 while fetching it'
    expect(isWaveIncomplete(reported, NEXT_PACKAGES)).toBe(true)
  })

  it('keeps a missing version of a package it asked for by name a real failure', () => {
    const reported = ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @deepseek-ai/dsh-web-app@next while fetching it'
    expect(isWaveIncomplete(reported, NEXT_PACKAGES)).toBe(false)
  })

  it('keeps any other failure a real failure', () => {
    expect(isWaveIncomplete('ERR_PNPM_FETCH_500 Internal Server Error', NEXT_PACKAGES)).toBe(false)
  })
})
