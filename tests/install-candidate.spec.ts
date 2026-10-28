/** The downloaded candidate must be tied to this main commit and immutable. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyInstallCandidate } from '../scripts/verify-install-candidate.ts'

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
      symlinkSync(join(root, 'package.json'), join(directory, 'SOURCE_SHA'))
      expect(() => verifyInstallCandidate(directory, sha)).toThrow(/non-file/)
    })
  })
})
