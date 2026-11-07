import { createHash, X509Certificate } from 'node:crypto'
import { generate } from 'selfsigned'
import { describe, expect, it } from 'vitest'
import { scopedBrowserCertificateArg } from '../scripts/scoped-browser-tls.ts'

async function fixture() {
  return generate([{ name: 'commonName', value: 'dsh' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  })
}

describe('scoped Chromium test certificate exception', () => {
  it('pins its public key and rejects a changed fingerprint or LAN address', async () => {
    const first = await fixture()
    const second = await fixture()
    const deployed = new X509Certificate(first.cert)
    const unrelated = new X509Certificate(second.cert)
    const expected = createHash('sha256').update(
      deployed.publicKey.export({ type: 'spki', format: 'der' }),
    ).digest('base64')

    expect(scopedBrowserCertificateArg(first.cert, deployed.fingerprint256, '127.0.0.1'))
      .toBe(`--ignore-certificate-errors-spki-list=${expected}`)
    expect(scopedBrowserCertificateArg(second.cert, unrelated.fingerprint256, '127.0.0.1'))
      .not.toBe(`--ignore-certificate-errors-spki-list=${expected}`)
    expect(() => scopedBrowserCertificateArg(first.cert, unrelated.fingerprint256, '127.0.0.1'))
      .toThrow(/printed pairing fingerprint/)
    expect(() => scopedBrowserCertificateArg(first.cert, deployed.fingerprint256, '127.0.0.2'))
      .toThrow(/bound LAN IPv4/)
  })
})
