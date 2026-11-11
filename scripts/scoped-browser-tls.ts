/**
 * Test-only Chromium exception for the certificate identity printed by DSH.
 *
 * The browser must not ignore all certificate errors: that masks another TLS
 * listener or an unrelated MITM certificate. Chromium's SPKI list is a scoped
 * test exception, not OS trust-store or physical-phone acceptance.
 */
import { createHash, X509Certificate } from 'node:crypto'

export function scopedBrowserCertificateArg(
  pem: string, advertisedFingerprint: string, lanIPv4: string,
): string {
  const certificate = new X509Certificate(pem)
  if (certificate.fingerprint256 !== advertisedFingerprint) {
    throw new Error('lanyard browser e2e: deployed certificate differs from the printed pairing fingerprint')
  }
  if (certificate.checkIP(lanIPv4) !== lanIPv4) {
    throw new Error('lanyard browser e2e: deployed certificate does not cover the bound LAN IPv4')
  }
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' })
  const hash = createHash('sha256').update(spki).digest('base64')
  return `--ignore-certificate-errors-spki-list=${hash}`
}
