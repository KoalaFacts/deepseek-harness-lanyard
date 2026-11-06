import { describe, expect, it } from 'vitest'
import { browserSandboxPolicy } from '../scripts/browser-sandbox.ts'

describe('Chromium E2E sandbox launch policy', () => {
  it('preserves the existing CI launch mode when not opted in', () => {
    expect(browserSandboxPolicy(undefined)).toEqual({
      chromiumSandbox: false,
      nativeArgs: ['--no-sandbox'],
    })
  })

  it('requires sandboxing for BOTH managed and native CDP browser launches', () => {
    const policy = browserSandboxPolicy('required')
    expect(policy.chromiumSandbox).toBe(true)
    expect(policy.nativeArgs).toEqual([])
  })

  it.each(['', 'false', '0', 'optional', 'REQUIRED'])(
    'rejects ambiguous %j rather than silently downgrading', mode => {
      expect(() => browserSandboxPolicy(mode)).toThrow(
        'LANYARD_CHROMIUM_SANDBOX must be "required" or unset',
      )
    },
  )
})
