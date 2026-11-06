import { describe, expect, it } from 'vitest'
import { browserSandboxPolicy } from '../scripts/browser-sandbox.ts'
import { sandboxReportIndicatesProtection } from '../scripts/browser-sandbox-attestation.ts'

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

describe('actual Chromium diagnostic (not merely launch flags)', () => {
  const protectedReport = [
    'Layer 1 Sandbox', 'PID namespaces\tYes', 'Network namespaces\tYes',
    'Seccomp-BPF sandbox\tYes', 'You are adequately sandboxed.',
  ].join('\n')

  it('requires Chromium to report both PID isolation and seccomp filtering', () => {
    expect(sandboxReportIndicatesProtection(protectedReport)).toBe(true)
  })

  it.each([
    ['disabled sandbox', protectedReport.replace('You are adequately', 'You are NOT adequately')],
    ['missing PID isolation', protectedReport.replace('PID namespaces\tYes', 'PID namespaces\tNo')],
    ['missing seccomp filter', protectedReport.replace('Seccomp-BPF sandbox\tYes', 'Seccomp-BPF sandbox\tNo')],
    ['administrator-blocked page', 'sandbox is blocked: Your organization does not allow this site'],
  ])('refuses %s instead of treating launch flags as acceptance', (_, report) => {
    expect(sandboxReportIndicatesProtection(report)).toBe(false)
  })
})
