/** The sleep inhibitor: which facility each platform holds, and how it fails. */
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as KeepAwake from '../src/keep-awake.ts'
import { resolveInhibitor } from '../src/keep-awake.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

/** One spawn the fake seam recorded. */
interface Spawned { argv: string[]; terminated: boolean }

/**
 * A subprocess seam whose spawns never run anything.
 * @param pid - the pid to report; zero or less means the platform binary is missing.
 * @param done - the outcome the spawn settles to.
 */
function fakeSubprocess(pid: number, done: Promise<{ exitCode: number; signal: string | null }>): {
  seam: unknown
  spawned: Spawned[]
} {
  const spawned: Spawned[] = []
  const seam = {
    spawn: (options: { argv: string[] }) => {
      const record: Spawned = { argv: options.argv, terminated: false }
      spawned.push(record)
      return {
        pid,
        done,
        terminate: () => { record.terminated = true },
        waitForExit: () => Promise.resolve(true),
      }
    },
  }
  return { seam, spawned }
}

describe('resolveInhibitor', () => {
  it.each([
    ['darwin' as const, 'caffeinate'],
    ['win32' as const, 'powershell'],
    ['linux' as const, 'systemd-inhibit'],
    ['freebsd' as const, 'systemd-inhibit'],
  ])('holds the %s facility with %s', (platform, command) => {
    expect(resolveInhibitor(platform).command).toBe(command)
  })

  it('inhibits idle sleep only on macOS, leaving the display free to sleep', () => {
    expect(resolveInhibitor('darwin').args).toEqual(['-i'])
  })

  it('passes the Windows hold as argv, never as a shell string', () => {
    const { args } = resolveInhibitor('win32')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args.at(-1)).toContain('SetThreadExecutionState')
  })

  it('blocks sleep on Linux for the process lifetime', () => {
    expect(resolveInhibitor('linux').args).toContain('--mode=block')
  })
})

describe('the keep-awake row', () => {
  it('spawns nothing when the invocation did not ask to stay awake', async () => {
    const { seam, spawned } = fakeSubprocess(1234, new Promise(() => {}))
    ctx = new Context()
    ctx.provide('subprocess', seam)
    await ctx.plugin(KeepAwake, { enabled: false }).await()
    expect(spawned).toEqual([])
  })

  it('holds the inhibitor while it lives and releases it on disposal', async () => {
    const { seam, spawned } = fakeSubprocess(1234, new Promise(() => {}))
    ctx = new Context()
    ctx.provide('subprocess', seam)
    await ctx.plugin(KeepAwake, { enabled: true }).await()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.argv[0]).toBe(resolveInhibitor(process.platform).command)
    expect(spawned[0]?.terminated).toBe(false)
    await ctx.fiber.dispose()
    ctx = undefined
    expect(spawned[0]?.terminated).toBe(true)
  })

  it('rejects its load when the platform binary is missing, rather than serving without the inhibitor', async () => {
    const { seam } = fakeSubprocess(-1, Promise.reject(new Error('ENOENT')))
    ctx = new Context()
    ctx.provide('subprocess', seam)
    await expect(ctx.plugin(KeepAwake, { enabled: true }).await()).rejects.toThrow(/ENOENT/)
  })
})
