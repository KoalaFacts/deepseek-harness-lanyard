/** The downloaded candidate must be tied to this main commit and immutable. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { verifyInstallCandidate, verifyInstalledModule } from '../scripts/verify-install-candidate.ts'

const sha = 'a'.repeat(40)
const root = fileURLToPath(new URL('../', import.meta.url))
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string }
const tarName = name.replace(/^@/, '').replace('/', '-') + '-' + version + '.tgz'

function withFixture(body: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'lanyard-candidate-fixture-'))
  try {
    const payload = Buffer.from('representative artifact bytes')
    writeFileSync(join(directory, tarName), payload)
    writeFileSync(join(directory, 'SOURCE_SHA'), sha + '\n')
    writeFileSync(join(directory, 'SHA256SUMS'), createHash('sha256').update(payload).digest('hex') + '  ' + tarName + '\n')
    body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('downloaded main install candidate identity', () => {
  it('accepts exactly the advertised three files and recorded SHA', () => {
    withFixture(directory => {
      expect(verifyInstallCandidate(directory, sha)).toBe(join(directory, tarName))
    })
  })
  it('rejects stale commit identity rather than trusting the archive checksum', () => {
    withFixture(directory => {
      expect(() => verifyInstallCandidate(directory, 'b'.repeat(40))).toThrow(/SOURCE_SHA/)
    })
  })
  it('rejects a changed tarball even when SOURCE_SHA matches', () => {
    withFixture(directory => {
      writeFileSync(join(directory, tarName), 'modified')
      expect(() => verifyInstallCandidate(directory, sha)).toThrow(/checksum mismatch/)
    })
  })
  it('rejects an additional file and a missing checksum', () => {
    withFixture(directory => {
      writeFileSync(join(directory, 'unexpected.txt'), 'extra')
      expect(() => verifyInstallCandidate(directory, sha)).toThrow(/exactly the published three files/)
      unlinkSync(join(directory, 'unexpected.txt'))
      unlinkSync(join(directory, 'SHA256SUMS'))
      expect(() => verifyInstallCandidate(directory, sha)).toThrow(/exactly the published three files/)
    })
  })
  it('rejects a symlink in place of the source identity file', () => {
    withFixture(directory => {
      unlinkSync(join(directory, 'SOURCE_SHA'))
      const outside = mkdtempSync(join(tmpdir(), 'lanyard-candidate-link-'))
      try {
        const identity = join(outside, 'SOURCE_SHA')
        writeFileSync(identity, sha + '\n')
        symlinkSync(identity, join(directory, 'SOURCE_SHA'))
        expect(() => verifyInstallCandidate(directory, sha)).toThrow(/non-file/)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})

it('executes the installed ESM exports, rejecting empty and syntactically broken modules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lanyard-candidate-modules-'))
  try {
    const valid = join(directory, 'valid.mjs')
    const empty = join(directory, 'empty.mjs')
    const broken = join(directory, 'broken.mjs')
    writeFileSync(valid, 'export const works = true\\n')
    writeFileSync(empty, '// resolves, but exports nothing\\n')
    writeFileSync(broken, 'export const broken = ;\\n')
    await expect(verifyInstalledModule(valid, 'test-valid')).resolves.toBeUndefined()
    // Removing the nonempty-export guard must make this negative control fail.
    await expect(verifyInstalledModule(empty, 'test-empty')).rejects
      .toThrow(/installed module exported nothing/)
    // Merely resolving a malformed file passed the old consumer gate.
    await expect(verifyInstalledModule(broken, 'test-broken')).rejects.toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('the main candidate consumer downloads this run artifact only after all main gates', () => {
  const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: { 'candidate-consumer': { needs: string[]; if: string; steps: Array<{ uses?: string; with?: { name?: string; 'persist-credentials'?: boolean }; env?: Record<string, string>; run?: string }> } }
  }
  const job = workflow.jobs['candidate-consumer']
  expect(job.needs).toEqual(['check', 'e2e', 'browser'])
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  expect(checkout?.with?.['persist-credentials']).toBe(false)
  expect(job.if).toContain("github.ref == 'refs/heads/main'")
  expect(job.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with?.name)
    .toBe('unpublished-lanyard-${{ github.sha }}')
  const install = job.steps.find(step => step.run?.includes('verify-install-candidate.ts'))
  expect(install?.env?.LANYARD_EXPECTED_SHA).toBe('${{ github.sha }}')
  expect(install?.env?.LANYARD_CANDIDATE_DIR).toBe('${{ runner.temp }}/lanyard-candidate')
})
