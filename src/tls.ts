/**
 * TLS material for LAN serving: on a network-serving invocation this ensures a
 * persistent self-signed certificate exists and provides its PEM file paths;
 * a loopback invocation provides no paths, keeping local serving on plain HTTP.
 * The carrier reads only paths, so key material never enters plugin config or
 * the surfaces that echo it. The certificate is generated once and reused
 * across restarts so a paired device's accept-once exception stays valid.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { generate } from 'selfsigned'

/** Stable Cordis plugin name. */
export const name = 'lanyard-tls'

/** Service this plugin provides; the gated carrier row injects it. */
export const LANYARD_TLS_SERVICE = 'lanyardTls'

/** What the carrier reads from {@link LANYARD_TLS_SERVICE}. */
export interface LanyardTlsValues {
  /** PEM paths of the active material; absent on a loopback-only deployment. */
  paths?: { certPath: string; keyPath: string }
}

/** Plugin config: whether this invocation serves the network, and where material persists. */
export interface Config {
  /** Generate and provide TLS paths: true exactly when the composition binds all interfaces. */
  enabled: boolean
  /** Directory holding the generated `cert.pem` and `key.pem`. */
  dir: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
  dir: z.string().required(),
})

/**
 * Certificate parameters. Validity runs ten years so a paired device's accepted
 * exception outlives the install; 2048-bit RSA with SHA-256 is the smallest
 * pair every current browser accepts without a warning of its own. All three
 * are fixed: weakening them would only degrade the certificate a deployment's
 * own devices must trust.
 */
const CERT_VALIDITY_DAYS = 3650
const CERT_KEY_SIZE = 2048
const CERT_ALGORITHM = 'sha256'

/**
 * The machine's non-internal IPv4 addresses, for the certificate's subject
 * alternative names.
 * @returns each LAN IPv4 literal, in interface order.
 */
export function lanIpv4Addresses(): string[] {
  const found: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
    }
  }
  return found
}

/**
 * Whether an existing certificate still names every address this machine would
 * be reached on.
 *
 * The subject alternative names are a snapshot of the interfaces present when
 * the certificate was generated, and the certificate outlives them: move the
 * machine to another network and the pairing link advertises an address the
 * certificate does not cover, so the phone gets a name-mismatch error rather
 * than the plain untrusted-issuer prompt the README describes. A certificate
 * that cannot be read at all counts as not covering anything, so the next step
 * replaces it rather than serving something unparseable.
 * @param certPath - the PEM certificate to inspect.
 * @param addresses - the LAN literals the certificate has to name.
 */
export function certificateCovers(certPath: string, addresses: string[]): boolean {
  let named: string
  try {
    named = new X509Certificate(readFileSync(certPath)).subjectAltName ?? ''
  } catch {
    return false
  }
  // `subjectAltName` is a rendered list — `DNS:localhost, IP Address:10.0.0.7`
  // — so each literal is matched as a whole entry rather than as a substring,
  // which would let 10.0.0.7 satisfy a request for 10.0.0.71.
  const entries = new Set(named.split(',').map(entry => entry.trim()))
  return addresses.every(address => entries.has(`IP Address:${address}`))
}

/**
 * Write one certificate and key pair unless a usable one already exists. The
 * key is written before the certificate and both land through a rename, so a
 * crash mid-generation leaves the next boot regenerating both rather than
 * pairing a fresh key with a stale certificate.
 *
 * "Usable" means present *and* still naming this machine's current addresses:
 * reuse is what keeps a paired device's accept-once exception valid, but only
 * while the certificate still matches what the pairing link points at.
 * @param certPath - destination of the PEM certificate.
 * @param keyPath - destination of the PEM private key.
 * @param addresses - LAN literals to name; this machine's current ones by default.
 */
export function generateMaterial(certPath: string, keyPath: string, addresses: string[] = lanIpv4Addresses()): void {
  if (existsSync(certPath) && existsSync(keyPath) && certificateCovers(certPath, addresses)) return
  const pems = generate([{ name: 'commonName', value: 'dsh' }], {
    days: CERT_VALIDITY_DAYS,
    keySize: CERT_KEY_SIZE,
    algorithm: CERT_ALGORITHM,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...addresses.map(ip => ({ type: 7 as const, ip })),
      ],
    }],
  })
  writeAtomic(keyPath, pems.private, 0o600)
  writeAtomic(certPath, pems.cert, 0o644)
}

/** Write through a sibling temp file and rename, so a reader sees old-or-new, never partial. */
function writeAtomic(path: string, content: string, mode: number): void {
  const temp = `${path}.${String(process.pid)}.tmp`
  // 'wx' on the temp file only: a leftover temp means another process is
  // mid-write, which is worth failing on. The rename over `path` is what makes
  // replacing an existing certificate work at all.
  writeFileSync(temp, content, { mode, flag: 'wx' })
  renameSync(temp, path)
}

/**
 * Provide the TLS paths, generating material on the first network-serving boot.
 * A generation failure or an unwritable directory rejects the load: a
 * composition that asked for TLS must never silently serve plaintext.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) {
    ctx.provide(LANYARD_TLS_SERVICE, {} satisfies LanyardTlsValues)
    return
  }
  const certPath = join(config.dir, 'cert.pem')
  const keyPath = join(config.dir, 'key.pem')
  // Owner-only: the key's directory must not be world-traversable on a shared host.
  mkdirSync(config.dir, { recursive: true, mode: 0o700 })
  try {
    generateMaterial(certPath, keyPath)
  } catch (error) {
    throw new Error(`lanyard-tls: could not generate TLS material in ${config.dir}`, { cause: error })
  }
  ctx.provide(LANYARD_TLS_SERVICE, { paths: { certPath, keyPath } } satisfies LanyardTlsValues)
}
