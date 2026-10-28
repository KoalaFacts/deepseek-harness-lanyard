/** Independent Node processes sharing only disposable synthetic TLS material. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { generateMaterial } from '../src/tls.ts'
const fixture = fileURLToPath(new URL('./fixtures/tls-writer.mjs', import.meta.url))
const source = new URL('../src/tls.ts', import.meta.url).href
function writer(directory: string, mode: string) {
  const child = spawn(process.execPath, [fixture, source, directory, mode], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
  let out = '', err = ''
  child.stdout.on('data', data => { out += String(data) })
  child.stderr.on('data', data => { err += String(data) })
  const done = new Promise<{ ok: boolean; message?: string; original?: boolean }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`owned writer exit ${String(code)}: ${err}`)); return }
      try { resolve(JSON.parse(out) as { ok: boolean; message?: string; original?: boolean }) } catch { reject(new Error(`invalid owned writer output: ${out}; ${err}`)) }
    })
  })
  return { child, done }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('owned writer readiness timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
it('excludes a second process until failed first issuance cleans up, then permits retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-writers-'))
  const first = writer(dir, 'hold-fail')
  // Attach immediately so a fixture startup error cannot become unhandled.
  void first.done.catch(() => {})
  try {
    await until(() => existsSync(join(dir, 'ready')))
    const second = await writer(dir, 'normal').done
    // Always release the owned process even when the baseline lacks a lock.
    writeFileSync(join(dir, 'release'), '')
    const failed = await first.done
    expect(second.ok).toBe(false)
    expect(second.message).toMatch(/TLS material.*busy/i)
    expect(failed.original).toBe(true)
    expect(existsSync(join(dir, 'key.pem'))).toBe(false)
    expect(existsSync(join(dir, 'cert.pem'))).toBe(false)
    const retry = await writer(dir, 'normal').done
    expect(retry.ok).toBe(true)
    const cert = readFileSync(join(dir, 'cert.pem'))
    const key = readFileSync(join(dir, 'key.pem'))
    expect(new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))).toBe(true)
    expect((await writer(dir, 'normal').done).ok).toBe(true)
    expect(readFileSync(join(dir, 'cert.pem'))).toEqual(cert)
    expect(readFileSync(join(dir, 'key.pem'))).toEqual(key)
  } finally {
    writeFileSync(join(dir, 'release'), '')
    await first.done.catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

it('rejects overlapping same-process destinations and releases a partially acquired lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-overlap-'))
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem'), other = join(dir, 'another.pem')
  try {
    const first = generateMaterial(cert, key, ['192.0.2.10'])
    const overlapping = generateMaterial(other, key, ['192.0.2.10'])
    await expect(overlapping).rejects.toThrow(/TLS material.*busy/i)
    expect(existsSync(other + '.lanyard-lock')).toBe(false)
    await first
    await generateMaterial(cert, key, ['192.0.2.10'])
    expect(existsSync(cert + '.lanyard-lock')).toBe(false)
    expect(existsSync(key + '.lanyard-lock')).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('preserves abandoned locks and existing material without automatic takeover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-stale-lock-'))
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem'), lock = key + '.lanyard-lock'
  try {
    await generateMaterial(cert, key, ['192.0.2.10'])
    const beforeCert = readFileSync(cert), beforeKey = readFileSync(key)
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner-marker'), 'synthetic abandoned owner')
    expect((await writer(dir, 'normal').done).message).toMatch(/TLS material.*busy/i)
    expect(readFileSync(join(lock, 'owner-marker'), 'utf8')).toBe('synthetic abandoned owner')
    expect(readFileSync(cert)).toEqual(beforeCert)
    expect(readFileSync(key)).toEqual(beforeKey)
    expect(existsSync(cert + '.lanyard-lock')).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('retains the original IO error when releasing an owned lock also fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-lock-release-'))
  const first = writer(dir, 'hold-fail')
  void first.done.catch(() => {})
  try {
    await until(() => existsSync(join(dir, 'ready')))
    const marker = join(dir, 'cert.pem.lanyard-lock', 'obstruction')
    writeFileSync(marker, 'synthetic release obstruction')
    writeFileSync(join(dir, 'release'), '')
    expect((await first.done).original).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('synthetic release obstruction')
    expect((await writer(dir, 'normal').done).message).toMatch(/TLS material.*busy/i)
    expect(existsSync(join(dir, 'key.pem'))).toBe(false)
  } finally {
    writeFileSync(join(dir, 'release'), '')
    await first.done.catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

it('coordinates directory aliases without changing the final material paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lanyard-lock-alias-'))
  const dir = join(root, 'material'), alias = join(root, 'alias')
  mkdirSync(dir)
  try {
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const first = generateMaterial(join(dir, 'cert.pem'), join(dir, 'key.pem'), ['192.0.2.10'])
    await expect(generateMaterial(join(alias, 'cert.pem'), join(alias, 'key.pem'), ['192.0.2.10']))
      .rejects.toThrow(/TLS material.*busy/i)
    await first
    expect(existsSync(join(dir, 'cert.pem.lanyard-lock'))).toBe(false)
    expect(existsSync(join(dir, 'key.pem.lanyard-lock'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('reports a release failure after successful publication without deleting the pair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-lock-success-'))
  const first = writer(dir, 'hold-success')
  void first.done.catch(() => {})
  try {
    await until(() => existsSync(join(dir, 'ready')))
    const marker = join(dir, 'cert.pem.lanyard-lock', 'obstruction')
    writeFileSync(marker, 'synthetic release obstruction')
    writeFileSync(join(dir, 'release'), '')
    const result = await first.done
    expect(result.ok).toBe(false)
    expect(result.original).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe('synthetic release obstruction')
    expect(new X509Certificate(readFileSync(join(dir, 'cert.pem')))
      .checkPrivateKey(createPrivateKey(readFileSync(join(dir, 'key.pem'))))).toBe(true)
  } finally {
    writeFileSync(join(dir, 'release'), '')
    await first.done.catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)


it('coordinates a symlink followed by dot-dot with its filesystem parent across processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lanyard-lock-dotdot-'))
  const dir = join(root, 'material'), child = join(dir, 'sub'), alias = join(root, 'alias')
  mkdirSync(child, { recursive: true })
  symlinkSync(child, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const first = writer(dir, 'hold-success')
  void first.done.catch(() => {})
  try {
    await until(() => existsSync(join(dir, 'ready')))
    const second = await writer(`${alias}/..`, 'normal').done
    writeFileSync(join(dir, 'release'), '')
    expect((await first.done).ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.message).toMatch(/TLS material.*busy/i)
    expect(existsSync(join(root, 'cert.pem'))).toBe(false)
    expect(new X509Certificate(readFileSync(join(dir, 'cert.pem')))
      .checkPrivateKey(createPrivateKey(readFileSync(join(dir, 'key.pem'))))).toBe(true)
  } finally {
    writeFileSync(join(dir, 'release'), '')
    await first.done.catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
