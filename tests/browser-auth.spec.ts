/**
 * The browser half, exercised as the page actually receives it: the emitted
 * script text is evaluated in a VM whose globals are the browser surfaces the
 * bootstrap touches. Testing the TypeScript function directly would prove
 * nothing about the string that reaches the page.
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME, AUTH_FRAGMENT_PARAM, AUTH_STORAGE_KEY, PAIRING_TOKEN_PATTERN,
} from '../src/admission.ts'
import { bootstrapAuthToken, injectPairingBootstrap, pairingBootstrapScript } from '../src/browser-auth.ts'

const TOKEN = 'pairing-token_0123456789-ab'

/** The browser surfaces one page boot presents, and what the bootstrap did to them. */
interface Page {
  stored: Record<string, string>
  cookie: string
  replaced: string | undefined
  hash: string
}

/**
 * Run the emitted script against one page state.
 * @param options - the page's fragment, protocol, stored token, and which surfaces exist.
 * @returns what the bootstrap left behind.
 */
function boot(options: {
  hash?: string
  protocol?: string
  stored?: string
  withStorage?: boolean
  withDocument?: boolean
}): Page {
  const page: Page = { stored: {}, cookie: '', replaced: undefined, hash: options.hash ?? '' }
  if (options.stored !== undefined) page.stored[AUTH_STORAGE_KEY] = options.stored
  const sandbox: Record<string, unknown> = {
    URLSearchParams,
    location: {
      hash: page.hash,
      pathname: '/',
      search: '?fixture=1',
      protocol: options.protocol ?? 'https:',
    },
    history: { replaceState: (_data: unknown, _unused: string, url?: string) => { page.replaced = url } },
  }
  if (options.withStorage !== false) {
    sandbox.localStorage = {
      getItem: (key: string) => page.stored[key] ?? null,
      setItem: (key: string, value: string) => { page.stored[key] = value },
    }
  }
  if (options.withDocument !== false) {
    sandbox.document = { set cookie(value: string) { page.cookie = value }, get cookie() { return page.cookie } }
  }
  const script = pairingBootstrapScript()
  runInNewContext(script.replace(/^<script>/, '').replace(/<\/script>$/, ''), sandbox)
  return page
}

describe('pairingBootstrapScript', () => {
  it('serializes a self-contained function, so no bundler scope can leak into the page', () => {
    // Every constant the bootstrap needs is declared in its own body; a
    // reference to module scope would serialize to an undefined identifier.
    const body = bootstrapAuthToken.toString()
    for (const literal of [AUTH_COOKIE_NAME, AUTH_FRAGMENT_PARAM, AUTH_STORAGE_KEY, PAIRING_TOKEN_PATTERN.source]) {
      expect([literal, body.includes(literal)]).toEqual([literal, true])
    }
  })

  it('cannot close the script element it is injected into', () => {
    // Only the serialized body matters; the wrapper's own </script> is the
    // element's terminator, not content inside it.
    expect(bootstrapAuthToken.toString()).not.toContain('</')
    expect(pairingBootstrapScript().split('</script>')).toHaveLength(2)
  })

  it('runs before the shell, as the first script in <head>', () => {
    const injected = injectPairingBootstrap('<html><head><title>dsh</title></head><body></body></html>')
    expect(injected.indexOf('<script>')).toBe('<html><head>'.length)
    expect(injected.indexOf('<script>')).toBeLessThan(injected.indexOf('<title>'))
  })

  it('still runs first in a document that has no head', () => {
    expect(injectPairingBootstrap('<body>x</body>').startsWith('<script>')).toBe(true)
  })
})

describe('the pairing bootstrap in the page', () => {
  it('adopts a pairing fragment, strips it, and republishes it as the cookie', () => {
    const page = boot({ hash: `#${AUTH_FRAGMENT_PARAM}=${TOKEN}` })
    expect(page.stored[AUTH_STORAGE_KEY]).toBe(TOKEN)
    // The fragment never reaches a server, but it does reach the address bar,
    // browser history, and anything the user pastes; it goes away after use.
    expect(page.replaced).toBe('/?fixture=1')
    expect(page.cookie).toBe(`${AUTH_COOKIE_NAME}=${TOKEN}; path=/; SameSite=Strict; Secure`)
  })

  it('keeps presenting the stored token on later boots, with no fragment at all', () => {
    const page = boot({ stored: TOKEN })
    expect(page.cookie).toBe(`${AUTH_COOKIE_NAME}=${TOKEN}; path=/; SameSite=Strict; Secure`)
    expect(page.replaced).toBeUndefined()
  })

  it('drops the Secure attribute on a loopback http page, so local serving keeps working', () => {
    expect(boot({ stored: TOKEN, protocol: 'http:' }).cookie)
      .toBe(`${AUTH_COOKIE_NAME}=${TOKEN}; path=/; SameSite=Strict`)
  })

  it('preserves fragment parameters that are not the token', () => {
    const page = boot({ hash: `#view=chat&${AUTH_FRAGMENT_PARAM}=${TOKEN}` })
    expect(page.replaced).toBe('/?fixture=1#view=chat')
  })

  it.each([
    ['too short', 'only15chars_ab-'],
    ['cookie-breaking punctuation', 'evil; Domain=attacker.example'],
    ['empty', ''],
  ])('refuses to store or present a %s fragment token, while still stripping it', (_kind, candidate) => {
    // The fragment is attacker-reachable: a malformed value must never reach
    // durable storage, nor the cookie attribute string it could extend.
    const page = boot({ hash: `#${AUTH_FRAGMENT_PARAM}=${encodeURIComponent(candidate)}` })
    expect(page.stored[AUTH_STORAGE_KEY]).toBeUndefined()
    expect(page.cookie).toBe('')
    expect(page.replaced).toBe('/?fixture=1')
  })

  it('ignores a stored value that no longer meets the token form', () => {
    expect(boot({ stored: 'tampered' }).cookie).toBe('')
  })

  it('is a no-op where storage or the document is unavailable', () => {
    expect(() => boot({ hash: `#${AUTH_FRAGMENT_PARAM}=${TOKEN}`, withStorage: false })).not.toThrow()
    expect(boot({ stored: TOKEN, withDocument: false }).cookie).toBe('')
  })
})
