/** Failure diagnostics must not leak still-valid DSH browser pairing tokens. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { awaitReadiness, isolatedDshEnvironment, readinessLines, redactReadinessOutput, stopDshProcess } from '../scripts/dsh-harness.ts'

describe('Disposable DSH profile isolation', () => {
  it('pins DSH_HOME even when inherited from a real profile and rejects explicit overrides', () => {
    const realHome = join(tmpdir(), 'lanyard-real-home-must-not-be-used')
    const testHome = join(tmpdir(), 'lanyard-isolated-home')
    const env = isolatedDshEnvironment(testHome, { LANYARD_TEST_FLAG: 'ok' }, {
      DSH_HOME: realHome, PATH: '/safe/test/path',
    })
    expect(env.DSH_HOME).toBe(testHome)
    expect(env.PATH).toBe('/safe/test/path')
    expect(env.LANYARD_TEST_FLAG).toBe('ok')
    expect(() => isolatedDshEnvironment(testHome, { DSH_HOME: realHome }))
      .toThrow(/DSH_HOME cannot be overridden/)
    expect(() => isolatedDshEnvironment(testHome, { DSH_HOME: '' }))
      .toThrow(/DSH_HOME cannot be overridden/)
  })
})

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

  it('retains early readiness across noisy startup and bounds redacted failure logs', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as Parameters<typeof awaitReadiness>[0]
    const ready = awaitReadiness(child)
    stdout.write('dsh web: http://127.0.0.1:3080/?token=early-secret\n')
    stderr.write('noisy upstream startup\n' + 'x'.repeat(180_000) + '\n')
    stderr.write('lanyard: pair a device by opening https://192.168.1.5:3443/?token=late-secret once\n')
    stderr.write('lanyard: the phone should show certificate SHA-256 AB:CD — verify before trusting\n')
    // A lost early signal must reject now rather than wait for the long timeout.
    child.emit('exit', 1)
    expect((await ready).localUrl).toContain('early-secret')
    stdout.end()
    stderr.end()

    const failedOut = new PassThrough()
    const failedErr = new PassThrough()
    const failing = Object.assign(new EventEmitter(), {
      stdout: failedOut, stderr: failedErr,
    }) as unknown as Parameters<typeof awaitReadiness>[0]
    const pending = awaitReadiness(failing)
    failedOut.write('noise\n' + 'y'.repeat(180_000))
    failedErr.write('lanyard: pair a device by opening https://192.168.1.5:3443/?token=late-secret once\n')
    failing.emit('exit', 1)
    let message = ''
    try {
      await pending
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('omitted')
    expect(message.length).toBeLessThan(70_000)
    expect(message).not.toContain('late-secret')
    expect(message).toContain('?token=[REDACTED]')
    failedOut.end()
    failedErr.end()
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
    stdout.write('post-ready logs must drain without a parser')
    stderr.write('including repeated errors from DSH')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(stdout.readableLength).toBe(0)
    expect(stderr.readableLength).toBe(0)
    stdout.end()
    stderr.end()
  })
})

describe('DSH cleanup after a non-responsive child', () => {
  it('only settles after a graceful SIGTERM exit and releases its listeners', async () => {
    const signals: NodeJS.Signals[] = []
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals): boolean {
        signals.push(signal)
        queueMicrotask(() => { emitter.emit('exit', 0, signal) })
        return true
      },
    }) as unknown as Parameters<typeof stopDshProcess>[0]

    await expect(stopDshProcess(child, 10)).resolves.toBeUndefined()
    expect(signals).toEqual(['SIGTERM'])
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('does not settle on SIGKILL alone, and treats a forced exit as a failure', async () => {
    const signals: NodeJS.Signals[] = []
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      pid: 12346,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals): boolean {
        signals.push(signal)
        return true
      },
    }) as unknown as Parameters<typeof stopDshProcess>[0]

    const stopping = stopDshProcess(child, 10)
    let settled = false
    void stopping.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => { expect(signals).toEqual(['SIGTERM', 'SIGKILL']) }, { interval: 5, timeout: 1_000 })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('exit', null, 'SIGKILL')
    await expect(stopping).rejects.toThrow(/required SIGKILL/)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })
})
