/** TLS material: generated once on a network bind, absent on a loopback one. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { generate } from 'selfsigned'
import * as Tls from '../src/tls.ts'
import { LANYARD_TLS_SERVICE, certificateCovers, generateMaterial, lanIpv4Addresses, type LanyardTlsValues } from '../src/tls.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

/** Mount the row and read back what it provided. */
async function provide(config: { enabled: boolean; dir: string }): Promise<LanyardTlsValues> {
  ctx = new Context()
  await ctx.plugin(Tls, config).await()
  return ctx.get(LANYARD_TLS_SERVICE) as LanyardTlsValues
}

/** A fresh directory that does not exist yet, so the row has to create it. */
function unusedDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'lanyard-tls-')), 'material')
}

describe('the tls row', () => {
  it('provides no paths on a loopback deployment, keeping local serving on plain HTTP', async () => {
    const dir = unusedDir()
    expect(await provide({ enabled: false, dir })).toEqual({})
    expect(existsSync(dir)).toBe(false)
  })

  it('generates a persistent pair on the first network-serving boot', async () => {
    const dir = unusedDir()
    const values = await provide({ enabled: true, dir })
    expect(values.paths).toEqual({ certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') })
    expect(existsSync(join(dir, 'cert.pem'))).toBe(true)
    expect(existsSync(join(dir, 'key.pem'))).toBe(true)
  })

  it('issues a certificate valid for ten years, so an accepted exception outlives the install', async () => {
    // selfsigned defaults to one year and renamed its validity option across
    // majors; a dropped option is silent, so the span itself is checked.
    const dir = unusedDir()
    await provide({ enabled: true, dir })
    const cert = new X509Certificate(readFileSync(join(dir, 'cert.pem')))
    const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000
    expect(days).toBeGreaterThan(3649)
    expect(days).toBeLessThan(3651)
  })

  it('keeps the key owner-only, inside an owner-only directory', async () => {
    const dir = unusedDir()
    await provide({ enabled: true, dir })
    // A world-traversable directory or a readable key would hand the LAN
    // identity to any other account on a shared host.
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'key.pem')).mode & 0o777).toBe(0o600)
  })

  it('reuses existing material, so a paired device\'s accepted exception survives a restart', async () => {
    const dir = unusedDir()
    await provide({ enabled: true, dir })
    const first = readFileSync(join(dir, 'cert.pem'), 'utf8')
    await ctx?.fiber.dispose()
    ctx = undefined
    await provide({ enabled: true, dir })
    expect(readFileSync(join(dir, 'cert.pem'), 'utf8')).toBe(first)
  })

  it('carries localhost and every LAN address in the certificate\'s subject alternative names', async () => {
    const dir = unusedDir()
    await provide({ enabled: true, dir })
    const san = new X509Certificate(readFileSync(join(dir, 'cert.pem'))).subjectAltName ?? ''
    expect(san).toContain('DNS:localhost')
    expect(san).toContain('IP Address:127.0.0.1')
    for (const address of lanIpv4Addresses()) {
      expect([address, san.includes(address)]).toEqual([address, true])
    }
  })

  it('rejects the load when the material cannot be written, never falling back to plaintext', async () => {
    // A path whose parent is a file, so mkdir cannot create the directory.
    const parent = join(mkdtempSync(join(tmpdir(), 'lanyard-tls-')), 'cert.pem')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(parent, 'not a directory')
    ctx = new Context()
    await expect(ctx.plugin(Tls, { enabled: true, dir: join(parent, 'material') }).await()).rejects.toThrow()
  })
})

describe('lanIpv4Addresses', () => {
  it('reports only non-internal IPv4 literals', () => {
    for (const address of lanIpv4Addresses()) {
      expect([address, /^\d{1,3}(\.\d{1,3}){3}$/.test(address)]).toEqual([address, true])
      expect(address.startsWith('127.')).toBe(false)
    }
  })
})

// A certificate outlives the interfaces it was generated against. Reuse keeps a
// paired device's accept-once exception valid, but only while the certificate
// still names what the pairing link points at.
describe('certificateCovers', () => {
  /** A certificate naming exactly these IPv4 literals. */
  async function certFor(ips: string[]): Promise<string> {
    const pems = await generate([{ name: 'commonName', value: 'dsh' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...ips.map(ip => ({ type: 7 as const, ip }))],
      }],
    })
    const path = join(mkdtempSync(join(tmpdir(), 'lanyard-cov-')), 'cert.pem')
    writeFileSync(path, pems.cert)
    return path
  }

  it('accepts a certificate naming every address asked for', async () => {
    expect(certificateCovers(await certFor(['192.168.1.5', '10.0.0.7']), ['10.0.0.7', '192.168.1.5'])).toBe(true)
  })

  it('refuses one that misses an address, which is what moving networks does', async () => {
    expect(certificateCovers(await certFor(['192.168.1.5']), ['10.0.0.7'])).toBe(false)
  })

  it('matches whole entries, so a longer address in the certificate does not satisfy a shorter one', async () => {
    // The trap runs this way round: the rendered list contains "10.0.0.71", so
    // a substring test answers yes for 10.0.0.7 and reuses a certificate the
    // phone rejects by name. Both orderings are checked because only one of
    // them tells substring matching apart from entry matching.
    expect(certificateCovers(await certFor(['10.0.0.71']), ['10.0.0.7'])).toBe(false)
    expect(certificateCovers(await certFor(['10.0.0.7']), ['10.0.0.71'])).toBe(false)
  })

  it('treats an unreadable certificate as covering nothing rather than throwing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lanyard-cov-')), 'cert.pem')
    writeFileSync(path, 'not a certificate')
    expect(certificateCovers(path, ['10.0.0.7'])).toBe(false)
  })

  it('accepts a loopback-only deployment, which asks for no addresses at all', async () => {
    expect(certificateCovers(await certFor([]), [])).toBe(true)
  })
})

// The reuse decision itself, not just the predicate behind it: keeping a
// certificate is what makes a paired device's accept-once exception survive a
// restart, and replacing one is what keeps it valid after the machine moves.
describe('generateMaterial', () => {
  /** Somewhere to put a pair, plus the paths. */
  function paths(): { certPath: string; keyPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'lanyard-gen-'))
    return { certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') }
  }

  it('reuses material that still names the current addresses', async () => {
    const { certPath, keyPath } = paths()
    await generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const first = readFileSync(certPath, 'utf8')
    const firstKey = readFileSync(keyPath, 'utf8')
    await generateMaterial(certPath, keyPath, ['192.168.1.5'])
    expect(readFileSync(certPath, 'utf8')).toBe(first)
    expect(readFileSync(keyPath, 'utf8')).toBe(firstKey)
  })

  it.each(['mismatched', 'malformed'] as const)('rejects a %s existing key without replacing either file', async (kind) => {
    // Disposable pairs use the same offline fixture path as the existing TLS
    // tests. A different valid key catches checking only PEM parseability.
    const dir = mkdtempSync(join(tmpdir(), 'lanyard-reuse-'))
    const certPath = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem')
    try {
      await generateMaterial(certPath, keyPath, ['192.168.1.5'])
      let replacement = 'not a private key'
      if (kind === 'mismatched') {
        const otherKey = join(dir, 'other-key.pem')
        await generateMaterial(join(dir, 'other-cert.pem'), otherKey, ['192.168.1.5'])
        replacement = readFileSync(otherKey, 'utf8')
      }
      writeFileSync(keyPath, replacement)
      const cert = readFileSync(certPath, 'utf8')
      const before = [statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs]
      await expect(generateMaterial(certPath, keyPath, ['192.168.1.5'])).rejects.toThrow(/existing TLS certificate.*private key.*left unchanged.*matching pair/i)
      expect(readFileSync(certPath, 'utf8')).toBe(cert)
      expect(readFileSync(keyPath, 'utf8')).toBe(replacement)
      expect([statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs]).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })


  it.each(['expired', 'not-yet-valid'] as const)('renews a %s certificate instead of reusing an unusable TLS identity', async (kind) => {
    const { certPath, keyPath } = paths()
    const now = Date.now()
    const day = 86_400_000
    const pems = await generate([{ name: 'commonName', value: 'dsh' }], {
      notBeforeDate: new Date(now + (kind === 'expired' ? -4 : 2) * day),
      notAfterDate: new Date(now + (kind === 'expired' ? -2 : 4) * day),
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '192.168.1.5' }],
      }],
    })
    writeFileSync(certPath, pems.cert)
    writeFileSync(keyPath, pems.private)
    const oldCert = new X509Certificate(readFileSync(certPath))
    expect(oldCert.checkPrivateKey(createPrivateKey(readFileSync(keyPath)))).toBe(true)
    expect(certificateCovers(certPath, ['192.168.1.5'])).toBe(true)
    if (kind === 'expired') expect(Date.parse(oldCert.validTo)).toBeLessThan(now)
    else expect(Date.parse(oldCert.validFrom)).toBeGreaterThan(now)

    await generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const renewed = new X509Certificate(readFileSync(certPath))
    expect(readFileSync(certPath, 'utf8')).not.toBe(pems.cert)
    expect(readFileSync(keyPath, 'utf8')).not.toBe(pems.private)
    expect(renewed.checkPrivateKey(createPrivateKey(readFileSync(keyPath)))).toBe(true)
    expect(certificateCovers(certPath, ['192.168.1.5'])).toBe(true)
    expect(Date.parse(renewed.validFrom)).toBeLessThanOrEqual(Date.now())
    expect(Date.parse(renewed.validTo)).toBeGreaterThan(Date.now())
  })

  it('replaces material once the machine is reachable somewhere it does not name', async () => {
    const { certPath, keyPath } = paths()
    await generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const first = readFileSync(certPath, 'utf8')
    // The laptop moved networks. The pairing link now advertises 10.0.0.7, and
    // a certificate naming only 192.168.1.5 gives the phone a name mismatch
    // rather than the untrusted-issuer prompt the README describes.
    await generateMaterial(certPath, keyPath, ['10.0.0.7'])
    const second = readFileSync(certPath, 'utf8')
    expect(second).not.toBe(first)
    expect(certificateCovers(certPath, ['10.0.0.7'])).toBe(true)
  })

  it('replaces the key alongside the certificate, never pairing a fresh one with a stale one', async () => {
    const { certPath, keyPath } = paths()
    await generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const firstKey = readFileSync(keyPath, 'utf8')
    await generateMaterial(certPath, keyPath, ['10.0.0.7'])
    expect(readFileSync(keyPath, 'utf8')).not.toBe(firstKey)
  })
})
