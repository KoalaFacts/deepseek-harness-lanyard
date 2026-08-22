/** TLS material: generated once on a network bind, absent on a loopback one. */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Tls from '../src/tls.ts'
import { lanIpv4Addresses, LANYARD_TLS_SERVICE, type LanyardTlsValues } from '../src/tls.ts'

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
