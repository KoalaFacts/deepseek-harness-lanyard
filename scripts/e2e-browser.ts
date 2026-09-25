/**
 * The pairing flow in a real browser.
 *
 * The HTTP suite proves the exchange as requests; only a browser proves what
 * a phone actually does with it — that it follows the redirect and keeps the
 * session cookie for a self-signed TLS origin, that the shell it lands on then
 * attaches that cookie to its own `/api` calls and WebSocket, and that it
 * survives a later visit to the bare address. It is also the one place that
 * sees every call the shipped GUI makes on load, so a namespace the GUI needs
 * but this gate pins shows up here as a failure rather than as a phone that
 * quietly cannot do something.
 *
 * Usage:  node scripts/e2e-browser.ts
 *         LANYARD_CHROMIUM=/path/to/chrome node scripts/e2e-browser.ts
 *
 * Playwright normally resolves its own matching Chromium build. Set
 * `LANYARD_CHROMIUM` when the machine already provides one — a preprovisioned
 * image whose build does not match this Playwright version, a distro package —
 * so the suite runs there without downloading a second browser.
 */

import type { BrowserType, Page, Response } from 'playwright'
import { recorder, requireLan, withDshDeployment } from './dsh-harness.ts'
import { REFUSAL_BODY } from '../src/webserver.ts'

const lan = requireLan()
const { check, report } = recorder()

let chromium: BrowserType
try {
  ({ chromium } = await import('playwright'))
} catch {
  console.error('lanyard e2e: playwright is not installed, so the browser half cannot be exercised.')
  console.error('lanyard e2e: SKIPPED (not passed) — run `pnpm install` then `npx playwright install chromium`.')
  process.exit(2)
}

/**
 * Routes a paired device is refused by design. Anything else the shell calls
 * and this gate refuses is a namespace the GUI needs and the classification
 * missed — the failure this suite exists to catch.
 */
const PINNED_BY_DESIGN = /^\/api\/(settings|credentials|account|llm|pluginManager|pluginRegistryProbe|pluginInventory|dynamicCordisRunner)\/|^\/api\/(present|changes)\.open$|^\/plugins\/events$|^\/open-in-app\/open$/

/** What the page saw when it called the api the way the shell does. */
interface PageAnswer {
  status: number
  body: string
}

/**
 * Ask the page to call one api endpoint. `credentials: 'same-origin'` is the
 * browser default; the point is that the cookie rides along without the app
 * doing anything.
 */
const apiAnswer = (page: Page, path: string): Promise<PageAnswer> => page.evaluate(async (target: string) => {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'e2e', method: target.replace(/^\/api\//, ''), payload: { args: {} } }),
  })
  return { status: response.status, body: await response.text() }
}, path)

/** Whether the gate refused the page's own fetch. */
const pageRefused = (answer: PageAnswer): boolean => answer.status === 403 && answer.body === REFUSAL_BODY

/** Whether a response is this gate's refusal. */
async function gateRefused(response: Response): Promise<boolean> {
  if (response.status() !== 403) return false
  try {
    return await response.text() === REFUSAL_BODY
  } catch {
    return false
  }
}

await withDshDeployment(async ({ port, pairingLink }) => {
  const origin = `https://${lan}:${String(port)}`
  const executablePath = process.env.LANYARD_CHROMIUM
  // The certificate is self-signed by design; a real device accepts it once.
  const browser = await chromium.launch({
    // The deployment under test is on this machine's own LAN address. An
    // ambient HTTP(S)_PROXY — normal in a container — would send the
    // navigation through it and the connection is reset.
    args: ['--no-proxy-server'],
    ...executablePath === undefined ? {} : { executablePath },
  })
  try {
    // ---- a device that has never paired ----
    // `ignoreHTTPSErrors` stays here, unlike in the node probes, for two
    // reasons. Playwright exposes no per-context way to trust a specific CA —
    // the alternatives are the same flag under another name or installing the
    // certificate into the machine's trust store. And it is what the flow being
    // tested actually looks like: the README tells a person the certificate
    // warning is normal and to accept it once, so a browser that accepts an
    // untrusted certificate is the behaviour under test, not a shortcut around
    // it. The certificate itself is validated in the node e2e, which trusts the
    // deployment's own PEM and nothing else.
    const cold = await browser.newContext({ ignoreHTTPSErrors: true })
    const coldPage = await cold.newPage()
    const coldLanding = await coldPage.goto(origin, { waitUntil: 'domcontentloaded' })
    check('an unpaired browser meets upstream\'s refusal, not the GUI', coldLanding?.status(), 401)
    check('and its own api calls are refused at the gate', pageRefused(await apiAnswer(coldPage, '/api/session/list')), true)
    await cold.close()

    // ---- opening the pairing link once ----
    const paired = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await paired.newPage()
    const refusedOnLoad = new Set<string>()
    const checks: Promise<void>[] = []
    page.on('response', (response) => {
      checks.push(gateRefused(response).then((refused) => {
        if (refused) refusedOnLoad.add(new URL(response.url()).pathname)
      }))
    })
    let muxFrames = 0
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname === '/api/remote.mux') socket.on('framereceived', () => { muxFrames += 1 })
    })
    const sessionList = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/list')
    await page.goto(pairingLink, { waitUntil: 'domcontentloaded' })
    const listed = await sessionList
    // The shell's other load-time calls are in flight alongside session/list;
    // give them the same moment to land before reading what was refused.
    await page.waitForLoadState('networkidle').catch(() => {})
    await Promise.all(checks)

    check('the link lands on the bare origin, the token gone from the address bar', page.url(), `${origin}/`)
    const session = (await paired.cookies(origin)).find(cookie => cookie.name.startsWith('dsh-auth-'))
    check('upstream set its session cookie, out of reach of the page\'s scripts', session?.httpOnly, true)
    // What the browser stored, not what the header said: Secure is what keeps
    // it off any later plain-http request to this machine's address.
    check('and the browser holds it as Secure, so it never leaves TLS', session?.secure, true)
    check('the shell\'s own session call succeeds, cookie attached by the browser alone', listed.status(), 200)
    check('the shell holds its stream WebSocket open', muxFrames > 0, true)
    const unexpected = [...refusedOnLoad].filter(path => !PINNED_BY_DESIGN.test(path))
    if (unexpected.length > 0) console.log(`lanyard e2e: refused on load, unexpectedly: ${unexpected.join(', ')}`)
    check('everything else the shell calls on load reaches it; only the configuration plane is refused', unexpected.length, 0)

    // ---- the point of pairing: the bare address works afterwards ----
    const later = await page.goto(origin, { waitUntil: 'domcontentloaded' })
    check('a later visit to the bare address needs no link', later?.status(), 200)
    check('while the configuration plane stays refused, even paired',
      pageRefused(await apiAnswer(page, '/api/settings/describe')), true)
    await paired.close()

    // ---- a wrong token must not pair ----
    const hostile = await browser.newContext({ ignoreHTTPSErrors: true })
    const hostilePage = await hostile.newPage()
    const forged = await hostilePage.goto(`${origin}/?token=${'A'.repeat(43)}`, { waitUntil: 'domcontentloaded' })
    check('a link carrying the wrong token is refused', forged?.status(), 401)
    check('and leaves no session behind', (await hostile.cookies(origin)).some(cookie => cookie.name.startsWith('dsh-auth-')), false)
    await hostile.close()
  } finally {
    await browser.close()
  }
})

report('lanyard browser e2e')
