/** Tracking `dsh@latest`: which devDependencies move, and in what form. */
import { describe, expect, it } from 'vitest'
import { drift, syncedRange } from '../scripts/sync-dsh.ts'

describe('syncing to dsh@latest', () => {
  it('pins exactly, since a caret range would admit a later prerelease from next', () => {
    expect(syncedRange('0.3.0-rc.1')).toBe('0.3.0-rc.1')
  })

  it('moves every lockstep package, the CLI included, and nothing else', () => {
    expect(drift({
      '@deepseek-ai/dsh': '0.2.0-rc.2',
      '@deepseek-ai/dsh-web-app': '0.2.0-rc.2',
      '@deepseek-ai/dsh-cmdline': '^0.2.0-rc.2',
      '@deepseek-ai/dsh-subprocess': '^0.3.0-rc.1',
      '@deepseek-ai/cordis': '^4.0.2',
      'vitest': '^5.0.1',
    }, '0.3.0-rc.1')).toEqual([
      { name: '@deepseek-ai/dsh', from: '0.2.0-rc.2', to: '0.3.0-rc.1' },
      { name: '@deepseek-ai/dsh-web-app', from: '0.2.0-rc.2', to: '0.3.0-rc.1' },
      { name: '@deepseek-ai/dsh-cmdline', from: '^0.2.0-rc.2', to: '0.3.0-rc.1' },
      { name: '@deepseek-ai/dsh-subprocess', from: '^0.3.0-rc.1', to: '0.3.0-rc.1' },
    ])
  })
})
