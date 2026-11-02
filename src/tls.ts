/**
 * TLS material for LAN serving: on a network-serving invocation this ensures a
 * persistent self-signed certificate exists and provides its PEM file paths;
 * a loopback invocation provides no paths, keeping local serving on plain HTTP.
 * The carrier reads only paths, so key material never enters plugin config or
 * the surfaces that echo it. The certificate is generated once and reused
 * across restarts so a paired device's accept-once exception stays valid.
 * @module
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
  /** Generate and provide TLS paths on a non-loopback bind without explicit PEM material. */
  enabled: boolean
  /** The network bind host; concrete IPv4 binds need only that address in their certificate. */
  host?: string
  /** Directory holding the generated `cert.pem` and `key.pem`. */
  dir: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
  host: z.string().default('0.0.0.0'),
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
 * than the plain untrusted-issuer prompt the README describes. The predicate returns false for an unreadable certificate. The caller must
 * first validate any saved certificate/key pair and fail closed if it is
 * incomplete, malformed or mismatched, rather than silently replacing it.
 * @param certPath - the PEM certificate to inspect.
 * @param addresses - the LAN literals the certificate has to name.
 */
export function certificateCovers(certPath: string, addresses: string[]): boolean {
  let named: string
  try {
    named = new X509Certificate(readManagedPem(certPath)).subjectAltName ?? ''
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
 * key is written before the certificate and each lands through a rename.
 * For an expired/not-yet-valid identity, a reported certificate write failure
 * rolls the key back while the old certificate remains. This is not atomic
 * across abrupt process or power loss between the two file replacements.
 * Any pre-existing material must form a readable matching pair before SAN or
 * date checks permit renewal: an interrupted replacement must not silently
 * discard the remaining identity, even when the LAN address has changed.
 *
 * "Usable" means a matching pair still naming this machine's current addresses:
 * reuse is what keeps a paired device's accept-once exception valid, but only
 * while the certificate still matches what the pairing link points at.
 * @param certPath - destination of the PEM certificate.
 * @param keyPath - destination of the PEM private key.
 * @param addresses - LAN literals to name; this machine's current ones by default.
 */
export async function generateMaterial(certPath: string, keyPath: string, addresses: string[] = lanIpv4Addresses()): Promise<void> {
  // All cooperating Lanyard writers lock both destinations before inspecting
  // saved state, including while asynchronous key generation is in flight.
  // Canonical parents make relative paths and directory symlink aliases share
  // a lock. No stale-lock stealing: an abandoned lock must fail closed.
  const locks = [...new Set([certPath, keyPath].map(path => {
    // Resolve the original parent through the filesystem before normalizing '..'.
    return join(realpathSync.native(dirname(path)), `${basename(path)}.lanyard-lock`)
  }))].sort()
  const held: string[] = []
  let failed = false
  try {
    for (const lock of locks) {
      try {
        mkdirSync(lock, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`TLS material is busy or an earlier writer left a lock: ${lock}. Retry after the writer finishes; abandoned locks are not removed automatically.`, { cause: error })
        }
        throw error
      }
      held.push(lock)
    }
    await generateLockedMaterial(certPath, keyPath, addresses)
  } catch (error) {
    failed = true
    throw error
  } finally {
    let releaseError: unknown
    for (const lock of held.reverse()) {
      try { rmdirSync(lock) } catch (error) { releaseError ??= error }
    }
    // A cleanup failure must never mask the original generation/IO error.
    if (!failed && releaseError !== undefined) throw releaseError
  }
}

/**
 * A dangling certificate/key symlink is still a saved filesystem entry.
 * existsSync() follows its missing target and reports false, which would let
 * first-issue generation silently replace that link and discard a previous
 * TLS identity. Treat any existing entry as saved material; unreadable or
 * unmatched pairs are rejected by generateLockedMaterial().
 */
function materialEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

/**
 * Bound saved managed PEM reads, even for valid certs/keys followed by huge
 * whitespace. A pathname size check before readFileSync cannot protect
 * against a non-cooperating writer changing the file during that read.
 */
const MAX_MANAGED_PEM_BYTES = 1024 * 1024

/** Keep a bounded-input recovery error distinct from malformed or mismatched PEM. */
class ManagedPemTooLarge extends Error {}

function readManagedPem(path: string): string {
  // Do not block on a FIFO substituted after the entry check on POSIX.
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK))
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Managed TLS PEM must be a regular file')
    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_MANAGED_PEM_BYTES) {
      const length = Math.min(64 * 1024, MAX_MANAGED_PEM_BYTES + 1 - total)
      const chunk = Buffer.allocUnsafe(length)
      const bytesRead = readSync(fd, chunk, 0, length, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > MAX_MANAGED_PEM_BYTES) throw new ManagedPemTooLarge('Managed TLS PEM exceeds the 1 MiB size limit')
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The complete material transaction, called only with both writer locks held. */
async function generateLockedMaterial(certPath: string, keyPath: string, addresses: string[]): Promise<void> {
  const hasCertificate = materialEntryExists(certPath)
  const hasKey = materialEntryExists(keyPath)
  if (hasCertificate !== hasKey) {
    // A partial identity may be the result of an interrupted update or an
    // operator moving one file. Never destroy the survivor to "repair" it.
    throw new Error('Existing TLS certificate and private key are incomplete. Files were left unchanged; restore the missing file from a matching pair before restarting.')
  }
  // Rename replaces a symlink rather than its target. Non-file entries are
  // unsafe too: a FIFO can block readFileSync forever, and directories or
  // device nodes are not certificate material. Check both entries before any
  // synchronous PEM read, even when the LAN address has not changed.
  if (hasCertificate && (!lstatSync(certPath).isFile() || !lstatSync(keyPath).isFile())) {
    throw new Error('Managed TLS certificate and private key must be regular files, not symbolic links or special filesystem entries. Files were left unchanged; restore the matching pair as regular files before restarting.')
  }
  // A LAN-address-only certificate reissue must not replace the matching
  // private key. If the certificate rename fails, the saved pair must still
  // match on the next boot rather than strand the user's phone identity.
  let retainedKeyPair: { privateKey: string; publicKey: string } | undefined
  // Validity renewal rotates the key; a failed certificate write must not
  // strand the old certificate next to that new private key.
  let previousIdentity: { certificate: string; key: string } | undefined
  if (hasCertificate) {
    let cert: X509Certificate
    let savedKey: string
    try {
      const certificate = readManagedPem(certPath)
      cert = new X509Certificate(certificate)
      savedKey = readManagedPem(keyPath)
      previousIdentity = { certificate, key: savedKey }
      if (!cert.checkPrivateKey(createPrivateKey(savedKey))) throw new Error('key mismatch')
    } catch (error) {
      // An otherwise parseable PEM may exceed the enforced read budget. Report
      // the recovery action rather than misdiagnose it as a mismatched pair.
      if (error instanceof ManagedPemTooLarge) {
        throw new ManagedPemTooLarge('Existing TLS certificate or private key exceeds the 1 MiB PEM size limit. Files were left unchanged; restore a matching pair with each file no larger than 1 MiB before restarting.')
      }
      // Check identity before SANs: a moved LAN address must never make a
      // mismatched or unreadable saved pair eligible for automatic replacement.
      throw new Error('Existing TLS certificate and private key cannot be used together. Files were left unchanged; restore a readable matching pair before restarting.')
    }
    const now = Date.now()
    const withinValidity = Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo)
    if (withinValidity) {
      if (certificateCovers(certPath, addresses)) return
      // The only reason to reissue this still-valid certificate is the LAN
      // address. Reuse its public/private key pair so writing the new cert is
      // the single atomic file replacement; expiry still rotates both files.
      retainedKeyPair = {
        privateKey: savedKey,
        publicKey: cert.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }
      previousIdentity = undefined
    }
  }
  const notBeforeDate = new Date()
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
  const pems = await generate([{ name: 'commonName', value: 'dsh' }], {
    notBeforeDate,
    notAfterDate,
    keySize: CERT_KEY_SIZE,
    algorithm: CERT_ALGORITHM,
    ...(retainedKeyPair === undefined ? {} : { keyPair: retainedKeyPair }),
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...addresses.map(ip => ({ type: 7 as const, ip })),
      ],
    }],
  })
  if (retainedKeyPair === undefined) {
    writeAtomic(keyPath, pems.private, 0o600)
    try {
      writeAtomic(certPath, pems.cert, 0o644)
    } catch (error) {
      // On the very first issue there was no identity to preserve. If the
      // certificate could not be installed, do not strand this attempt's new
      // private key and make every later start fail the incomplete-pair guard.
      // Do not touch an existing identity or any key another writer changed.
      if (!hasCertificate && !hasKey) {
        try {
          if (!existsSync(certPath) && readManagedPem(keyPath) === pems.private) {
            unlinkSync(keyPath)
          }
        } catch { /* Fail closed if cleanup fails; preserve the original error. */ }
      } else if (previousIdentity !== undefined) {
        // The old certificate is still on disk; roll back only this attempt's
        // replacement key. A non-cooperating writer must never be overwritten.
        try {
          if (readManagedPem(certPath) !== previousIdentity.certificate
            || readManagedPem(keyPath) !== pems.private) {
            throw new Error('TLS identity changed during failed renewal; refusing unsafe rollback')
          }
          writeAtomic(keyPath, previousIdentity.key, 0o600)
        } catch (restoreError) {
          throw new Error(
            'TLS renewal failed and the previous matching private key could not be restored; recover cert.pem and key.pem from a matching backup',
            { cause: new AggregateError([error, restoreError], 'TLS renewal and rollback failed') },
          )
        }
      }
      throw error
    }
  } else {
    writeAtomic(certPath, pems.cert, 0o644)
  }
}

/** Write through a sibling temp file and rename, so a reader sees old-or-new, never partial. */
function writeAtomic(path: string, content: string, mode: number): void {
  const temp = `${path}.${String(process.pid)}.tmp`
  // 'wx' on the temp file only: a leftover temp means another process is
  // mid-write, which is worth failing on. The rename over `path` is what makes
  // replacing an existing certificate work at all.
  writeFileSync(temp, content, { mode, flag: 'wx' })
  try {
    renameSync(temp, path)
  } catch (error) {
    // The exclusive create succeeded, so this temp belongs to this attempt.
    // Remove it after a failed rename; otherwise retrying in this same process
    // hits EEXIST forever. Never remove a temp that failed the 'wx' guard.
    try { unlinkSync(temp) } catch { /* Preserve the original rename failure. */ }
    throw error
  }
}

/**
 * Do not serve a managed identity saved with permissions which let other local
 * accounts read its private key or traverse its private material directory.
 * mkdirSync({ recursive: true, mode }) does not repair an existing directory;
 * a restored key may likewise be group/world-readable. Fail closed rather than
 * silently changing permissions on a directory the operator may share.
 * POSIX mode bits do not describe Windows ACLs; Windows file security remains
 * the operator's responsibility.
 */
function assertOwnerOnlyManagedMaterial(dir: string, keyPath: string): void {
  if (process.platform === 'win32') return
  if ((statSync(dir).mode & 0o077) !== 0) {
    throw new Error('Managed TLS directory permissions must be owner-only (chmod 700 on the material directory); existing permissions were left unchanged')
  }
  if (existsSync(keyPath) && (statSync(keyPath).mode & 0o077) !== 0) {
    throw new Error('Managed TLS private key permissions must be owner-only (chmod 600 on key.pem); existing permissions were left unchanged')
  }
}

/**
 * Provide the TLS paths, generating material on the first network-serving boot.
 * A generation failure or an unwritable directory rejects the load: a
 * composition that asked for TLS must never silently serve plaintext.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) {
    ctx.provide(LANYARD_TLS_SERVICE, {} satisfies LanyardTlsValues)
    return
  }
  const certPath = join(config.dir, 'cert.pem')
  const keyPath = join(config.dir, 'key.pem')
  // Owner-only: the key's directory must not be world-traversable on a shared host.
  mkdirSync(config.dir, { recursive: true, mode: 0o700 })
  try {
    // Check before reading a reused identity and after any write. Neither a
    // pre-existing directory nor a restored key is automatically chmodded.
    assertOwnerOnlyManagedMaterial(config.dir, keyPath)
    // A concrete-interface carrier cannot serve the other adapters. Requiring
    // SANs for all of them rotates a phone's accepted certificate whenever an
    // unrelated VPN or virtual adapter appears. Legacy wildcard binds still
    // need the full address snapshot because pairing offers each reachable LAN.
    const addresses = config.host === undefined || config.host === '0.0.0.0'
      ? lanIpv4Addresses() : [config.host]
    await generateMaterial(certPath, keyPath, addresses)
    assertOwnerOnlyManagedMaterial(config.dir, keyPath)
  } catch (error) {
    // Keep the size-limit recovery visible at the top level; a CLI may show
    // only this error and omit nested causes during startup failure.
    const message = error instanceof ManagedPemTooLarge
      ? `lanyard-tls: ${error.message}`
      : `lanyard-tls: could not generate TLS material in ${config.dir}`
    throw new Error(message, { cause: error })
  }
  ctx.provide(LANYARD_TLS_SERVICE, { paths: { certPath, keyPath } } satisfies LanyardTlsValues)
}
