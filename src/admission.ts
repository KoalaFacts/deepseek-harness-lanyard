/**
 * Pairing-token admission for every request the gated carrier serves. The
 * decision reads the socket peer the kernel reported, never a request header:
 * on an all-interfaces bind any client reaching the socket can claim
 * `Host: localhost`, so a header-derived exemption is a token bypass.
 * @module
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** Cookie the browser half publishes after adopting a `#auth=` pairing link. */
export const AUTH_COOKIE_NAME = 'dsh_auth'

/** URL-fragment parameter carrying the token on a pairing link (`#auth=<token>`); a fragment never reaches the server or its logs. */
export const AUTH_FRAGMENT_PARAM = 'auth'

/** localStorage key the browser half keeps the adopted token under. */
export const AUTH_STORAGE_KEY = 'dsh.pairingToken'

/** A pairing token is at least 16 characters of the URL-, cookie-, and shell-safe alphabet. */
export const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/

/** Human-readable form of {@link PAIRING_TOKEN_PATTERN}, used in load-time errors. */
export const PAIRING_TOKEN_REQUIREMENT = 'at least 16 characters of A-Za-z0-9_-'

/**
 * Assert a configured pairing token is strong enough to guard network access.
 * Anything else — too short, cookie-breaking punctuation, non-ASCII — fails the
 * load loudly rather than silently weakening or corrupting the cookie exchange.
 * @param token - the configured value, verbatim.
 */
export function assertPairingToken(token: string): void {
  if (PAIRING_TOKEN_PATTERN.test(token)) return
  throw new Error(`lanyard: pairing token must be ${PAIRING_TOKEN_REQUIREMENT}`)
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
 * fails closed to token-required.
 * @param address - `req.socket.remoteAddress`, or undefined.
 * @returns true only for a genuine loopback peer.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  return isIpv4Loopback(address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address)
}

/** Every token the request presents: the Bearer authorization plus each pairing cookie value. */
function presentedTokens(req: IncomingMessage): string[] {
  const tokens: string[] = []
  const authorization = req.headers.authorization
  if (authorization?.startsWith('Bearer ') === true) tokens.push(authorization.slice('Bearer '.length))
  const cookies = req.headers.cookie
  if (cookies !== undefined) {
    for (const pair of cookies.split(';')) {
      const separator = pair.indexOf('=')
      if (separator === -1) continue
      // The name is compared whole: a neighbouring `dsh_auth_x` carrying a
      // valid token must not satisfy this one.
      if (pair.slice(0, separator).trim() === AUTH_COOKIE_NAME) tokens.push(pair.slice(separator + 1).trim())
    }
  }
  return tokens
}

/** Constant-time equality over sha256 digests: length-independent, prefix-blind. */
function tokenMatches(presented: string, token: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(token).digest(),
  )
}

/**
 * Whether one request may proceed to the handler it addressed.
 * @param req - the incoming request, whose socket carries the peer address.
 * @param token - the deployment's pairing token; absent admits only loopback peers.
 * @returns true for a loopback peer, or a non-loopback peer presenting the token.
 */
export function admit(req: IncomingMessage, token: string | undefined): boolean {
  if (isLoopbackAddress(req.socket.remoteAddress)) return true
  return token !== undefined && presentedTokens(req).some(presented => tokenMatches(presented, token))
}
