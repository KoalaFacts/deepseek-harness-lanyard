/**
 * The browser half of the pairing exchange, delivered as an inline `<script>`
 * in the index document rather than as a client-plugin bundle.
 *
 * A pairing link carries `#auth=<token>` in the URL fragment — which no browser
 * ever puts on the wire, so it reaches neither the server nor its logs. This
 * bootstrap moves the token into `localStorage`, strips it from the address
 * bar, and republishes it on every boot as the `dsh_auth` cookie, which the
 * browser then attaches to `/api` fetches and WebSocket upgrades alike. The
 * carriers therefore need no token plumbing at all.
 *
 * Why an index tap and not a `dsh.client` roster entry: the cookie must exist
 * before the shell issues its first `/api` request, and the roster gives no
 * ordering guarantee against `dsh-client-connection`. A classic inline script
 * in `<head>` runs before every deferred module, so the ordering is structural
 * instead of negotiated — and the plugin needs no browser build chain.
 * @module
 */

/**
 * Adopt a `#auth=<token>` pairing fragment and republish the stored token as
 * the `dsh_auth` cookie.
 *
 * **This function is serialized into the page by {@link pairingBootstrapScript}
 * through `Function.prototype.toString`, so it must stay entirely
 * self-contained**: every constant it needs is declared in its own body, and it
 * closes over nothing. A reference to module scope would serialize to an
 * identifier that does not exist in the browser.
 */
export function bootstrapAuthToken(): void {
  const cookieName = 'dsh_auth'
  const fragmentParam = 'auth'
  const storageKey = 'dsh.pairingToken'
  const tokenPattern = /^[A-Za-z0-9_-]{16,}$/
  const globals = globalThis as {
    location?: { hash: string; pathname: string; search: string; protocol: string }
    localStorage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
    document?: { cookie: string }
    history?: { replaceState: (data: unknown, unused: string, url?: string) => void }
  }
  const pageLocation = globals.location
  const storage = globals.localStorage
  if (pageLocation === undefined || storage === undefined) return
  const fragment = new URLSearchParams(pageLocation.hash.replace(/^#/, ''))
  const fromFragment = fragment.get(fragmentParam)
  if (fromFragment !== null) {
    // The fragment is attacker-reachable input and storage is durable, so only
    // a well-formed token is adopted; a malformed one is dropped rather than
    // stored, and never reaches the cookie attribute string it could otherwise
    // extend with its own `;` clauses. The address bar is stripped either way.
    if (tokenPattern.test(fromFragment)) storage.setItem(storageKey, fromFragment)
    fragment.delete(fragmentParam)
    const rest = fragment.toString()
    globals.history?.replaceState(null, '', `${pageLocation.pathname}${pageLocation.search}${rest === '' ? '' : `#${rest}`}`)
  }
  const token = storage.getItem(storageKey)
  if (token === null || !tokenPattern.test(token) || globals.document === undefined) return
  // Secure on an https page (every network deployment serves TLS), so the token
  // cookie never rides a plaintext request; loopback http keeps working.
  const secure = pageLocation.protocol === 'https:' ? '; Secure' : ''
  globals.document.cookie = `${cookieName}=${token}; path=/; SameSite=Strict${secure}`
}

/**
 * The inline bootstrap as page source: an immediately-invoked copy of
 * {@link bootstrapAuthToken}, contained so a browser privacy setting that
 * denies storage or cookie access cannot abort the rest of the document.
 * @returns the script element to inject into `<head>`.
 * @throws when the serialized body could close the script element, which would
 * turn an injection into markup — impossible for the source above, and checked
 * so a future edit cannot make it possible silently.
 */
/**
 * Opening tag of {@link pairingBootstrapScript}'s output, exported so a caller
 * that needs the body back strips an exact known wrapper instead of describing
 * it with a pattern — one that would have to agree about case, whitespace and
 * attributes with a string this module wrote itself.
 */
export const BOOTSTRAP_SCRIPT_OPEN = '<script>'

/** Closing tag of {@link pairingBootstrapScript}'s output; see {@link BOOTSTRAP_SCRIPT_OPEN}. */
export const BOOTSTRAP_SCRIPT_CLOSE = '</script>'

export function pairingBootstrapScript(): string {
  const body = bootstrapAuthToken.toString()
  if (body.includes('</')) {
    throw new Error('lanyard: the pairing bootstrap contains "</", which would close the script element it is injected into')
  }
  return `${BOOTSTRAP_SCRIPT_OPEN}try{(${body})()}catch{}${BOOTSTRAP_SCRIPT_CLOSE}`
}

/**
 * Inject the bootstrap as the first script in `<head>`, ahead of the shell's
 * own deferred module, so the cookie exists before the first `/api` request.
 * @param html - the index document body.
 * @returns the document with the bootstrap injected.
 */
export function injectPairingBootstrap(html: string): string {
  const script = pairingBootstrapScript()
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + '<head>'.length)}${script}${html.slice(head + '<head>'.length)}`
  // A document without a <head> is not the shipped index; prepending still runs
  // the bootstrap before anything the body loads.
  return `${script}${html}`
}
