/** Failure diagnostics must not leak still-valid DSH browser pairing tokens. */
import { describe, expect, it } from 'vitest'
import { readinessLines, redactReadinessOutput } from '../scripts/dsh-harness.ts'

describe('DSH readiness failure diagnostics', () => {
  it('redacts both real-format pairing URLs without altering readiness parsing or useful context', () => {
    const output = [
      'dsh web: http://127.0.0.1:3080/?token=synthetic-local-secret',
      'lanyard: pair a device by opening https://192.168.1.5:3443/?token=synthetic-lan-secret&source=phone once',
      'lanyard: the phone should show certificate SHA-256 AB:CD — verify before trusting',
      '',
    ].join('\n')
    const ready = readinessLines(output)
    expect(ready?.localUrl).toContain('synthetic-local-secret')
    expect(ready?.pairingLink).toContain('synthetic-lan-secret')

    const safe = redactReadinessOutput(output)
    expect(safe).not.toContain('synthetic-local-secret')
    expect(safe).not.toContain('synthetic-lan-secret')
    expect(safe).toContain('http://127.0.0.1:3080/?token=[REDACTED]')
    expect(safe).toContain('https://192.168.1.5:3443/?token=[REDACTED]&source=phone')
    expect(safe).toContain('certificate SHA-256 AB:CD')
  })
})
