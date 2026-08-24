/** TLS material: generated once on a network bind, absent on a loopback one. */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
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
  function certFor(ips: string[]): string {
    const pems = generate([{ name: 'commonName', value: 'dsh' }], {
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

  it('accepts a certificate naming every address asked for', () => {
    expect(certificateCovers(certFor(['192.168.1.5', '10.0.0.7']), ['10.0.0.7', '192.168.1.5'])).toBe(true)
  })

  it('refuses one that misses an address, which is what moving networks does', () => {
    expect(certificateCovers(certFor(['192.168.1.5']), ['10.0.0.7'])).toBe(false)
  })

  it('matches whole entries, so a longer address in the certificate does not satisfy a shorter one', () => {
    // The trap runs this way round: the rendered list contains "10.0.0.71", so
    // a substring test answers yes for 10.0.0.7 and reuses a certificate the
    // phone rejects by name. Both orderings are checked because only one of
    // them tells substring matching apart from entry matching.
    expect(certificateCovers(certFor(['10.0.0.71']), ['10.0.0.7'])).toBe(false)
    expect(certificateCovers(certFor(['10.0.0.7']), ['10.0.0.71'])).toBe(false)
  })

  it('treats an unreadable certificate as covering nothing rather than throwing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lanyard-cov-')), 'cert.pem')
    writeFileSync(path, 'not a certificate')
    expect(certificateCovers(path, ['10.0.0.7'])).toBe(false)
  })

  it('accepts a loopback-only deployment, which asks for no addresses at all', () => {
    expect(certificateCovers(certFor([]), [])).toBe(true)
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

  it('reuses material that still names the current addresses', () => {
    const { certPath, keyPath } = paths()
    generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const first = readFileSync(certPath, 'utf8')
    generateMaterial(certPath, keyPath, ['192.168.1.5'])
    expect(readFileSync(certPath, 'utf8')).toBe(first)
  })

  it('replaces material once the machine is reachable somewhere it does not name', () => {
    const { certPath, keyPath } = paths()
    generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const first = readFileSync(certPath, 'utf8')
    // The laptop moved networks. The pairing link now advertises 10.0.0.7, and
    // a certificate naming only 192.168.1.5 gives the phone a name mismatch
    // rather than the untrusted-issuer prompt the README describes.
    generateMaterial(certPath, keyPath, ['10.0.0.7'])
    const second = readFileSync(certPath, 'utf8')
    expect(second).not.toBe(first)
    expect(certificateCovers(certPath, ['10.0.0.7'])).toBe(true)
  })

  it('replaces the key alongside the certificate, never pairing a fresh one with a stale one', () => {
    const { certPath, keyPath } = paths()
    generateMaterial(certPath, keyPath, ['192.168.1.5'])
    const firstKey = readFileSync(keyPath, 'utf8')
    generateMaterial(certPath, keyPath, ['10.0.0.7'])
    expect(readFileSync(keyPath, 'utf8')).not.toBe(firstKey)
  })
})
