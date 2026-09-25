/**
 * Network admission for every request the gated carrier serves.
 *
 * Authentication belongs to upstream. Since 0.1.2, `dsh-client-connection`
 * turns the launch token `dsh web` prints into a signed, host-bound browser
 * session, and publishes the check as `ctx.connection.requestRejection` for
 * every route owner to apply to its own routes. This module decides only
 * *where* that check is mandatory — on every request from a peer that is not
 * this machine, whichever seat it arrives at — and never issues or verifies a
 * credential of its own.
 *
 * The peer is the socket the kernel reported, never a request header: on an
 * all-interfaces bind any client reaching the socket can claim
 * `Host: localhost`, so a header-derived exemption would be a bypass.
 * @module
 */

import type { IncomingMessage } from 'node:http'

/**
 * The part of upstream's `ctx.connection` this gate relies on: the Host/Origin
 * fence plus browser-session verification, applicable to any route.
 *
 * Read structurally rather than through the Context augmentation
 * `@deepseek-ai/dsh-client-connection` declares: this plugin does not import
 * that package, and re-declaring its service key would collide with its own
 * declaration in any composition that does.
 */
export interface SessionAuthority {
  /**
   * @param request - the request, read for its Host, Origin, and Cookie headers.
   * @returns 401 or 403 to refuse, undefined to admit.
   */
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined
}

/**
 * Whether a service offers the session check this gate needs. A connection
 * that predates upstream's browser authentication has no such member, and
 * neither does whatever a rename upstream leaves behind — both read as absent.
 * @param candidate - `ctx.get('connection')`, whatever it holds.
 */
export function isSessionAuthority(candidate: unknown): candidate is SessionAuthority {
  return typeof (candidate as Partial<SessionAuthority> | undefined)?.requestRejection === 'function'
}

/**
 * Whether a literal is canonical dotted-quad IPv4 inside `127.0.0.0/8`. Octets
 * carry no leading zero: `127.0.0.01` denotes loopback to a resolver but is not
 * the form node reports, and some parsers read a leading zero as octal, so it
 * classifies as non-loopback like every other non-canonical spelling.
 */
function isIpv4Loopback(literal: string): boolean {
  const parts = literal.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket peer address is the loopback interface: IPv4 `127.0.0.0/8`,
 * IPv6 `::1`, or an IPv4-mapped loopback. An address this does not recognize —
 * an unusual literal, a non-IP transport, `undefined` — is not loopback, so it
 * fails closed to session-required.
 * @param address - `req.socket.remoteAddress`, or undefined.
 * @returns true only for a genuine loopback peer.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  return isIpv4Loopback(address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address)
}

/**
 * Whether one request may proceed to the handler it addressed.
 *
 * A loopback peer is exempt here, not unauthenticated: upstream still applies
 * its own session check to every route that owns one. What this adds is the
 * same check in front of every *other* route, for a peer elsewhere on the
 * network — so a route whose owner authenticates nothing is not thereby open
 * to the LAN.
 * @param req - the incoming request, whose socket carries the peer address.
 * @param authority - `ctx.get('connection')` at request time; absent before
 * Connection mounts and after it is disposed.
 * @returns true for a loopback peer, or a network peer upstream admits.
 */
export function admit(req: IncomingMessage, authority: unknown): boolean {
  if (isLoopbackAddress(req.socket.remoteAddress)) return true
  // Without the check there is no telling a paired device from anyone else on
  // the network, so the peer is refused rather than waved through.
  return isSessionAuthority(authority) && authority.requestRejection(req) === undefined
}
