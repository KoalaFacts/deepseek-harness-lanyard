/** The sleep inhibitor: which facility each platform holds, and how it fails. */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as KeepAwake from '../src/keep-awake.ts'
import { findOnPath, internals, resolveInhibitor } from '../src/keep-awake.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.restoreAllMocks() })

/** One spawn the fake seam recorded. */
interface Spawned { argv: string[]; terminated: boolean }

/**
 * A subprocess seam whose spawns never run anything, shaped like the seam's
 * handle: no pid, a `done` that settles on exit, and termination.
 * @param done - the outcome the spawn settles to.
 */
function fakeSubprocess(done: Promise<{ exitCode: number; signal: string | null }>): {
  seam: unknown
  spawned: Spawned[]
} {
  const spawned: Spawned[] = []
  const seam = {
    spawn: (options: { argv: string[] }) => {
      const record: Spawned = { argv: options.argv, terminated: false }
      spawned.push(record)
      return {
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

describe.skipIf(process.platform === 'win32')('findOnPath', () => {
  /** A PATH of two directories, the second holding the files this test names. */
  function pathWith(files: Record<string, number>): string {
    const empty = mkdtempSync(join(tmpdir(), 'lanyard-path-'))
    const full = mkdtempSync(join(tmpdir(), 'lanyard-path-'))
    for (const [name, mode] of Object.entries(files)) {
      writeFileSync(join(full, name), '#!/bin/sh\n')
      chmodSync(join(full, name), mode)
    }
    return ['', empty, full].join(delimiter)
  }

  it('finds an executable in any PATH entry, skipping empty ones', () => {
    const path = pathWith({ inhibitor: 0o755 })
    expect(findOnPath('inhibitor', path, [''])).toMatch(/inhibitor$/)
  })

  it('does not count a file it could not execute, or a directory by that name', () => {
    const path = pathWith({ inhibitor: 0o644 })
    expect(findOnPath('inhibitor', path, [''])).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'lanyard-path-'))
    mkdirSync(join(dir, 'inhibitor'))
    expect(findOnPath('inhibitor', dir, [''])).toBeUndefined()
  })

  it('tries each extension it is given, as Windows resolves PATHEXT', () => {
    const path = pathWith({ 'inhibitor.exe': 0o755 })
    expect(findOnPath('inhibitor', path, ['', '.com', '.exe'])).toMatch(/inhibitor\.exe$/)
  })
})

describe('the keep-awake row', () => {
  it('spawns nothing when the invocation did not ask to stay awake', async () => {
    const { seam, spawned } = fakeSubprocess(new Promise(() => {}))
    ctx = new Context()
    ctx.provide('subprocess', seam)
    await ctx.plugin(KeepAwake, { enabled: false }).await()
    expect(spawned).toEqual([])
  })

  it('holds the inhibitor while it lives and releases it on disposal', async () => {
    vi.spyOn(internals, 'findOnPath').mockReturnValue('/usr/bin/inhibitor')
    const { seam, spawned } = fakeSubprocess(new Promise(() => {}))
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

  it('rejects its load when the platform binary is not on PATH, rather than serving without the inhibitor', async () => {
    // The seam reports a failed spawn only through `done`, after the load has
    // finished; the missing binary is decided before anything runs instead.
    vi.spyOn(internals, 'findOnPath').mockReturnValue(undefined)
    const { seam, spawned } = fakeSubprocess(new Promise(() => {}))
    ctx = new Context()
    ctx.provide('subprocess', seam)
    await expect(ctx.plugin(KeepAwake, { enabled: true }).await()).rejects.toThrow(/is not on PATH/)
    expect(spawned).toEqual([])
  })

  it('warns, and keeps serving, when a running inhibitor dies later', async () => {
    vi.spyOn(internals, 'findOnPath').mockReturnValue('/usr/bin/inhibitor')
    let exit = (_outcome: { exitCode: number; signal: string | null }): void => {}
    const { seam } = fakeSubprocess(new Promise((resolve) => { exit = resolve }))
    ctx = new Context()
    ctx.provide('subprocess', seam)
    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warnings.push(String(message)) }) as never)
    await ctx.plugin(KeepAwake, { enabled: true }).await()
    exit({ exitCode: 1, signal: null })
    await new Promise(resolve => setImmediate(resolve))
    expect(warnings).toEqual([expect.stringMatching(/sleep inhibitor exited \(code 1, signal null\); the host may sleep again/)])
  })
})
