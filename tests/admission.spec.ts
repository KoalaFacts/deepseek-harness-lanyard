/** Admission: peer classification, token presentation, and the privileged pin. */
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { admit, assertPairingToken, isLoopbackAddress } from '../src/admission.ts'
import { isPrivilegedEndpoint } from '../src/webserver.ts'

const TOKEN = 'pairing-token_0123456789-ab'

/** A request whose socket peer the kernel would have filled in. */
function req(headers: Record<string, string>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('isLoopbackAddress', () => {
  it('accepts the forms node actually reports', () => {
    for (const a of ['127.0.0.1', '127.8.9.10', '127.255.255.255', '::1', '::ffff:127.0.0.1']) {
      expect([a, isLoopbackAddress(a)]).toEqual([a, true])
    }
  })

  it('fails closed on every other spelling', () => {
    // Each denotes loopback to some resolver and none is a form node reports.
    // Reading any of them as loopback would hand out the tokenless exemption.
    for (const a of [
      undefined, '', '192.168.1.5', '::ffff:192.168.1.5', '0.0.0.0',
      '::FFFF:127.0.0.1', '::ffff:7f00:1', '2130706433', '127.1',
      '0127.0.0.1', '127.0.0.01', '127.000.000.001', '::ffff:127.0.0.1%eth0',
      ' 127.0.0.1', '127.0.0.1 ',
    ]) {
      expect([a, isLoopbackAddress(a)]).toEqual([a, false])
    }
  })
})

describe('assertPairingToken', () => {
  it('accepts the URL-, cookie-, and shell-safe alphabet at 16+ characters', () => {
    expect(() => { assertPairingToken('A-Za-z0-9_-16chr') }).not.toThrow()
  })

  it.each([
    ['too short', 'only15chars_ab-'],
    ['cookie-breaking punctuation', 'token;with=bad,chars****'],
    ['whitespace', 'token with spaces padding'],
    ['non-ASCII', 'token-ünïcode-0123456789'],
    ['empty', ''],
  ])('rejects %s loudly', (_kind, token) => {
    expect(() => { assertPairingToken(token) }).toThrow(/at least 16 characters/)
  })
})

describe('admit', () => {
  it('exempts a genuine loopback peer, with or without a configured token', () => {
    expect(admit(req({}), TOKEN, )).toBe(false) // no peer at all is not loopback
    expect(admit(req({}, '127.0.0.1'), TOKEN)).toBe(true)
    expect(admit(req({}, '::1'), undefined)).toBe(true)
  })

  it('refuses a non-loopback peer forging a loopback Host', () => {
    // The peer is what the kernel saw; Host is what the client claims. Deriving
    // the exemption from the header would be a complete token bypass.
    expect(admit(req({ host: '127.0.0.1:3080' }, '192.168.1.5'), TOKEN)).toBe(false)
    expect(admit(req({ host: 'localhost:3080' }, '192.168.1.5'), TOKEN)).toBe(false)
  })

  it('admits either presentation form from a non-loopback peer', () => {
    expect(admit(req({ cookie: `dsh_auth=${TOKEN}` }, '192.168.1.5'), TOKEN)).toBe(true)
    expect(admit(req({ authorization: `Bearer ${TOKEN}` }, '192.168.1.5'), TOKEN)).toBe(true)
    expect(admit(req({ cookie: `theme=dark; dsh_auth=${TOKEN} ; sid=1` }, '192.168.1.5'), TOKEN)).toBe(true)
  })

  it('refuses a non-loopback peer when no token is configured at all', () => {
    expect(admit(req({ cookie: `dsh_auth=${TOKEN}` }, '192.168.1.5'), undefined)).toBe(false)
  })

  it.each([
    ['a name the cookie name prefixes', `dsh_auth_extra=${TOKEN}`],
    ['a name ending in the cookie name', `xdsh_auth=${TOKEN}`],
    ['the token as another cookie value', `session=${TOKEN}`],
    ['the token as a cookie name', `${TOKEN}=1`],
    ['an empty pairing cookie', 'dsh_auth='],
    ['a malformed pair', 'no-separator; other=1'],
  ])('refuses %s', (_kind, cookie) => {
    // The cookie name is compared whole: the parser bug that turns a substring
    // test into an authentication bypass.
    expect(admit(req({ cookie }, '192.168.1.5'), TOKEN)).toBe(false)
  })

  it('admits a valid pairing cookie sent alongside a stale one', () => {
    expect(admit(req({ cookie: `dsh_auth=stale-token-0123456789; dsh_auth=${TOKEN}` }, '192.168.1.5'), TOKEN)).toBe(true)
  })

  it('refuses a wrong token and a different authorization scheme', () => {
    expect(admit(req({ cookie: 'dsh_auth=wrong-token-0123456789' }, '192.168.1.5'), TOKEN)).toBe(false)
    expect(admit(req({ authorization: `Basic ${TOKEN}` }, '192.168.1.5'), TOKEN)).toBe(false)
  })
})

describe('isPrivilegedEndpoint', () => {
  it('pins the configuration and native-desktop plane', () => {
    for (const m of ['settings.describe', 'credentials.set', 'host.openPath', 'agentPreset.read', 'llm.discoverModels']) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, true])
    }
  })

  it('leaves the session plane reachable for a paired device', () => {
    for (const m of ['session.list', 'session.create', 'llm.providers', 'agentPreset.list', 'agentPreset.select']) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, false])
    }
  })

  it('pins every method of an unlisted Gateway namespace, including ones no list names', () => {
    // The Gateway claims any namespace/method a live remote service exposes, so
    // a per-method list would default each new endpoint to LAN-reachable.
    for (const m of [
      'pluginInventory/list',
      'dynamicCordisRunner/inventory', 'dynamicCordisRunner/invoke',
      'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/aMethodAddedLater',
      'somethingUnclassified/read',
    ]) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, true])
    }
  })

  it('lets the session-content namespaces through', () => {
    for (const m of ['commands/execute', 'goals/create', 'messageFeedback/put']) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, false])
    }
  })
})
