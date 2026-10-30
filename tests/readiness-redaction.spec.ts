/** Failure diagnostics must not leak still-valid DSH browser pairing tokens. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { awaitReadiness, readinessLines, redactReadinessOutput, stopDshProcess } from '../scripts/dsh-harness.ts'

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

  it('rejects an unspawnable CLI without waiting for an exit event that never fires', async () => {
    const missing = join(tmpdir(), `lanyard-nonexistent-dsh-${randomUUID()}`)
    const child = spawn(missing, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    await expect(awaitReadiness(child)).rejects.toThrow(/ENOENT|spawn/)
    await expect(stopDshProcess(child)).resolves.toBeUndefined()
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('detaches readiness listeners after success instead of retaining every later log', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const fakeServer = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as Parameters<typeof awaitReadiness>[0]
    const ready = awaitReadiness(fakeServer)
    stdout.write('dsh web: http://127.0.0.1:3080/?token=synthetic-secret\n')
    stderr.write('lanyard: pair a device by opening https://192.168.1.5:3443/?token=synthetic-secret once\n')
    stderr.write('lanyard: the phone should show certificate SHA-256 AB:CD — verify before trusting\n')
    expect((await ready).fingerprint).toBe('AB:CD')
    expect(stdout.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('data')).toBe(0)
    expect(fakeServer.listenerCount('exit')).toBe(0)
    expect(fakeServer.listenerCount('error')).toBe(0)
    stdout.end()
    stderr.end()
  })
})
