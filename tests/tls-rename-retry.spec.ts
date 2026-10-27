/** A failed certificate rename must not poison retry in the same DSH process. */
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { certificateCovers, generateMaterial } from '../src/tls.ts'

// Inject the error at the filesystem boundary while retaining real writes and
// real certificate generation. This simulates EIO, not a physical power loss.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

it('removes only the temp it created on rename failure and retries with the saved key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-tls-rename-'))
  try {
    const certPath = join(dir, 'cert.pem')
    const keyPath = join(dir, 'key.pem')
    await generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const originalCert = readFileSync(certPath, 'utf8')
    const originalKey = readFileSync(keyPath, 'utf8')
    const tempPath = `${certPath}.${String(process.pid)}.tmp`

    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('injected certificate rename EIO'), { code: 'EIO' })
    })
    await expect(generateMaterial(certPath, keyPath, ['10.0.0.7']))
      .rejects.toThrow('injected certificate rename EIO')

    expect(existsSync(tempPath)).toBe(false)
    expect(readFileSync(certPath, 'utf8')).toBe(originalCert)
    expect(readFileSync(keyPath, 'utf8')).toBe(originalKey)
    expect(new X509Certificate(readFileSync(certPath))
      .checkPrivateKey(createPrivateKey(readFileSync(keyPath)))).toBe(true)

    // Without the cleanup, the second call fails with EEXIST on the old temp.
    await generateMaterial(certPath, keyPath, ['10.0.0.7'])
    expect(certificateCovers(certPath, ['10.0.0.7'])).toBe(true)
    expect(readFileSync(keyPath, 'utf8')).toBe(originalKey)
    expect(new X509Certificate(readFileSync(certPath))
      .checkPrivateKey(createPrivateKey(readFileSync(keyPath)))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
