/** Cleanup must not erase the primary failure or an unsuccessfully stopped DSH_HOME. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stopDshProcess, withDshWorkspace } from '../scripts/dsh-harness.ts'

const server = {} as Parameters<typeof stopDshProcess>[0]
const remove = (workspace: string): void => { rmSync(workspace, { recursive: true, force: true }) }

async function fixture(body: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'lanyard-cleanup-test-'))
  try {
    await body(workspace)
  } finally {
    // Each test owns its fixture, including the deliberately retained ones.
    remove(workspace)
  }
}

describe('disposable DSH lifecycle failure retention', () => {
  it('preserves the identical body error and removes the workspace on a clean stop', async () => {
    await fixture(async workspace => {
      const primary = new Error('primary DSH readiness failure')
      const result = await withDshWorkspace(
        workspace,
        async () => { throw primary },
        () => server,
        { stop: async () => {}, remove },
        false,
      ).then(() => undefined, (error: unknown) => error)
      expect(result).toBe(primary)
      expect(existsSync(workspace)).toBe(false)
    })
  })

  it('preserves primary first, secondary stop error second, and never deletes diagnostics', async () => {
    await fixture(async workspace => {
      const primary = new Error('body failed before shutdown')
      const secondary = new Error('SIGKILL required during teardown')
      let removalCount = 0
      const result = await withDshWorkspace(
        workspace,
        async () => { throw primary },
        () => server,
        {
          stop: async () => { throw secondary },
          remove: path => { removalCount++; remove(path) },
        },
        false,
      ).then(() => undefined, (error: unknown) => error)
      expect(result).toBeInstanceOf(AggregateError)
      expect((result as AggregateError).errors).toEqual([primary, secondary])
      expect((result as Error & { cause?: unknown }).cause).toBe(primary)
      expect(removalCount).toBe(0)
      expect(existsSync(workspace)).toBe(true)
    })
  })

  it('retains diagnostics when restart-stop fails but the final already-exited stop succeeds', async () => {
    await fixture(async workspace => {
      const forced = new Error('restart required SIGKILL')
      let stopCount = 0
      let removalCount = 0
      const result = await withDshWorkspace(
        workspace,
        async trackedStop => {
          // Simulates restart() propagating the first failed stop. A finalizer
          // sees that same child already exited and its next stop resolves.
          await trackedStop(server)
          return 'unreachable'
        },
        () => server,
        {
          stop: async () => {
            stopCount++
            if (stopCount === 1) throw forced
          },
          remove: path => { removalCount++; remove(path) },
        },
        false,
      ).then(() => undefined, (error: unknown) => error)
      expect(result).toBe(forced)
      expect(stopCount).toBe(2)
      expect(removalCount).toBe(0)
      expect(existsSync(workspace)).toBe(true)
    })
  })

  it('removes the workspace after a successful operation and graceful stop', async () => {
    await fixture(async workspace => {
      const result = await withDshWorkspace(
        workspace,
        async () => 'ok',
        () => server,
        { stop: async () => {}, remove },
        false,
      )
      expect(result).toBe('ok')
      expect(existsSync(workspace)).toBe(false)
    })
  })
})
