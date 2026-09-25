/**
 * The host sleep inhibitor: while enabled, holds a platform keep-awake child
 * for the dsh process lifetime so idle sleep cannot cut off running sessions or
 * paired LAN devices. The inhibitor is the platform's own facility —
 * `caffeinate -i` on macOS, `systemd-inhibit` on Linux, a PowerShell
 * `SetThreadExecutionState` holder on Windows — so the OS drops the lock when
 * that child exits, and disposal is what ends it. A dsh killed abruptly
 * (`SIGKILL`, power loss) runs no disposer and orphans the child, which holds
 * the inhibitor until it is killed or the machine restarts. An inhibitor that
 * is not on PATH rejects activation: a deployment that asked to stay awake
 * must never silently serve without it. A child that dies later logs a warning
 * and serving continues.
 * @module
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Stable Cordis plugin name. */
export const name = 'lanyard-keep-awake'

/** The process seam owning spawn, tree termination, and exit observation. */
export const inject = ['subprocess']

/** Plugin config: whether this invocation holds the host awake. */
export interface Config {
  /** Hold the platform sleep inhibitor for the process lifetime. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
})

/** One platform sleep-inhibitor invocation. */
export interface InhibitorCommand {
  /** Executable holding the platform's inhibitor for as long as it runs. */
  command: string
  /** Arguments passed as an argv array, never a shell string. */
  args: string[]
}

/**
 * ES_CONTINUOUS | ES_SYSTEM_REQUIRED held for the child's lifetime; Windows
 * clears the state automatically when the holding process dies, so no
 * release call exists or is needed.
 */
const WINDOWS_HOLD = [
  'Add-Type -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\' -Name PowerState -Namespace DshKeepAwake | Out-Null;',
  '[DshKeepAwake.PowerState]::SetThreadExecutionState(0x80000001) | Out-Null;',
  'while ($true) { Start-Sleep -Seconds 3600 }',
].join(' ')

/** SIGTERM-to-SIGKILL window the seam escalates through at teardown. */
const TERMINATE_GRACE_MS = 5_000

/**
 * Bound on the disposer's wait for the tree to exit: the grace window plus room
 * for SIGKILL to land and be observed. A healthy inhibitor dies on SIGTERM in
 * milliseconds, so this only matters when the signal cannot land — a group id
 * reused by a foreign group (EPERM), or an unkillable member. This disposer
 * then warns and returns rather than waiting on a signal that cannot land,
 * leaving an orphan the OS releases when it finally dies. The bound is local
 * to this disposer, not a shutdown guarantee: `dsh-subprocess-local` awaits
 * the same tree without one in its own disposer, and the CLI's whole-tree
 * shutdown budget is the ceiling that actually ends a stuck teardown.
 */
const RELEASE_TIMEOUT_MS = TERMINATE_GRACE_MS + 2_000

/**
 * How long activation waits for the inhibitor to fail before counting it as
 * held. The seam has no started signal: it rejects `done` for a spawn that
 * failed — a missing interpreter, a permission lost since the PATH check,
 * EAGAIN — a tick or so after `spawn` returns, and an inhibitor that cannot
 * take hold, such as `systemd-inhibit` with no logind to ask, exits within
 * milliseconds. One still running after this long has taken hold, and only
 * its later exit is downgraded to a warning. The cost is this much added to a
 * `--keep-awake` boot.
 */
const HOLD_CONFIRM_MS = 250

/**
 * The inhibitors print nothing in normal operation. Collecting a small bound
 * keeps whatever a broken one does say off the URL readiness line, without
 * leaving an unread pipe the child could block on.
 */
const DISCARD_OUTPUT = { maxBytes: 4096 } as const

/**
 * Resolve the platform's sleep-inhibitor invocation.
 * @param platform - `process.platform` of the host.
 * @returns the command and arguments to hold for the process lifetime.
 */
export function resolveInhibitor(platform: NodeJS.Platform): InhibitorCommand {
  switch (platform) {
    case 'darwin':
      // -i inhibits idle system sleep only; the display may still sleep.
      return { command: 'caffeinate', args: ['-i'] }
    case 'win32':
      return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOLD] }
    default:
      return {
        command: 'systemd-inhibit',
        args: ['--what=sleep:idle', '--who=dsh', '--why=Serving the DSH web GUI', '--mode=block', 'sleep', 'infinity'],
      }
  }
}

/**
 * Where an executable name resolves on PATH, the way the platform's spawn
 * would find it: each PATH entry in order, and on Windows each `PATHEXT`
 * extension within it.
 * @param command - a bare executable name.
 * @param path - the PATH value to search.
 * @param extensions - candidate suffixes; `['']` outside Windows.
 * @returns the first match, or undefined when nothing on PATH answers to it.
 */
export function findOnPath(command: string, path = process.env.PATH ?? '', extensions = pathExtensions()): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined
}

/** `PATHEXT` on Windows, where a bare name resolves through it; nothing elsewhere. */
function pathExtensions(): string[] {
  if (process.platform !== 'win32') return ['']
  return ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => extension !== '')]
}

/**
 * Test hooks for the host's PATH; production never mutates them. The unit
 * suite must not depend on whether the machine running it has
 * `systemd-inhibit`.
 */
export const internals = { findOnPath }

/**
 * Hold the sleep inhibitor while this plugin lives.
 * @param ctx - plugin context carrying the subprocess seam.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  const { command, args } = resolveInhibitor(process.platform)
  // The common failure — a platform without the inhibitor — is decided before
  // anything runs, so it gets a message naming the fix. The confirmation
  // window below catches every other way the inhibitor fails to take hold.
  if (internals.findOnPath(command) === undefined) {
    throw new Error(`lanyard-keep-awake: ${command} is not on PATH, so --keep-awake cannot hold this host awake`)
  }
  const held = ctx.subprocess.spawn({
    argv: [command, ...args],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: DISCARD_OUTPUT, stderr: DISCARD_OUTPUT },
    graceMs: TERMINATE_GRACE_MS,
  })
  // An inhibitor that settles inside the window never held: fail the load
  // rather than serve without what this invocation asked for.
  const confirmation = new AbortController()
  const early = await Promise.race([
    held.done.then(
      outcome => `exited at once (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
      (error: unknown) => `could not start (${String(error)})`,
    ),
    // Aborted once the race is decided, so no timer outlives it.
    delay(HOLD_CONFIRM_MS, undefined, { signal: confirmation.signal }).catch(() => undefined),
  ])
  confirmation.abort()
  if (early !== undefined) {
    held.terminate()
    throw new Error(`lanyard-keep-awake: ${command} ${early}, so --keep-awake cannot hold this host awake`)
  }
  let disposed = false
  const report = (what: string): void => {
    if (!disposed) ctx.logger.warn(`lanyard-keep-awake: sleep inhibitor ${what}; the host may sleep again`)
  }
  void held.done.then(
    (outcome) => { report(`exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`) },
    (error: unknown) => { report(`failed (${String(error)})`) },
  )
  ctx.effect(() => async () => {
    disposed = true
    held.terminate()
    const released = await held.waitForExit(AbortSignal.timeout(RELEASE_TIMEOUT_MS))
    if (!released) {
      ctx.logger.warn(`lanyard-keep-awake: sleep inhibitor did not exit within teardown; ${command} may keep the host awake until it is killed`)
    }
  }, 'lanyard-keep-awake: sleep inhibitor')
}
