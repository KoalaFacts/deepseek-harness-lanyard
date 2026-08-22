/**
 * The pairing flow in a real browser.
 *
 * Everything else proves the bootstrap as *source*: unit tests evaluate the
 * emitted string against fake globals, the build gate evaluates the built
 * artifact, and the HTTP suite finds it in the served index. None of that
 * proves a browser does what the fakes did — that `document.cookie` accepts the
 * attribute string, that `history.replaceState` strips the fragment, that the
 * cookie is actually attached to a same-origin `/api` fetch over a self-signed
 * TLS origin, or that it survives a reload at the bare authority.
 *
 * This drives Chromium through the flow a person performs: open the pairing
 * link once, then use the bare address afterwards.
 *
 * Usage:  node scripts/e2e-browser.ts
 *         LANYARD_CHROMIUM=/path/to/chrome node scripts/e2e-browser.ts
 *
 * Playwright normally resolves its own matching Chromium build. Set
 * `LANYARD_CHROMIUM` when the machine already provides one — a preprovisioned
 * image whose build does not match this Playwright version, a distro package —
 * so the suite runs there without downloading a second browser.
 */

import type { BrowserType, Page } from 'playwright'
import { TOKEN, recorder, requireLan, withDshDeployment } from './dsh-harness.ts'

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
  const response = await fetch(target)
  return { status: response.status, body: await response.text() }
}, path)

/** Whether the gate refused the page's own fetch. */
const pageRefused = (answer: PageAnswer): boolean => answer.status === 403 && answer.body === 'lanyard: forbidden'

/** Whether the page's fetch passed the gate, so a check reads as its own claim. */
const pageAdmitted = (answer: PageAnswer): boolean => !pageRefused(answer)

await withDshDeployment(async ({ port }) => {
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
    const cold = await browser.newContext({ ignoreHTTPSErrors: true })
    const coldPage = await cold.newPage()
    await coldPage.goto(origin, { waitUntil: 'domcontentloaded' })
    check('an unpaired browser is refused by the gate',
      pageRefused(await apiAnswer(coldPage, '/api/session.list')), true)
    check('and stored nothing to present later',
      await coldPage.evaluate(() => localStorage.getItem('dsh.pairingToken')), null)
    await cold.close()

    // ---- opening the pairing link once ----
    const paired = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await paired.newPage()
    await page.goto(`${origin}/#auth=${TOKEN}`, { waitUntil: 'domcontentloaded' })

    check('the browser adopted the token from the fragment',
      await page.evaluate(() => localStorage.getItem('dsh.pairingToken')), TOKEN)
    check('and republished it as the pairing cookie',
      await page.evaluate(() => document.cookie.includes(`dsh_auth=${String(localStorage.getItem('dsh.pairingToken'))}`)), true)
    // The fragment never reaches a server, but it does reach the address bar,
    // browser history, and anything the user pastes.
    check('the fragment was stripped from the address bar',
      await page.evaluate(() => location.hash), '')
    check('leaving the bare authority',
      await page.evaluate(() => location.origin + location.pathname), `${origin}/`)
    check('the paired page reaches the api, cookie attached by the browser alone',
      pageAdmitted(await apiAnswer(page, '/api/session.list')), true)

    // ---- the point of pairing: the bare address works afterwards ----
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    check('a later visit to the bare address needs no link',
      await page.evaluate(() => document.cookie.includes('dsh_auth=')), true)
    check('and still reaches the api',
      pageAdmitted(await apiAnswer(page, '/api/session.list')), true)
    check('while the configuration plane stays refused, even paired',
      pageRefused(await apiAnswer(page, '/api/settings.update')), true)
    await paired.close()

    // ---- a malformed link must not poison storage ----
    const hostile = await browser.newContext({ ignoreHTTPSErrors: true })
    const hostilePage = await hostile.newPage()
    await hostilePage.goto(`${origin}/#auth=${encodeURIComponent('evil; Domain=attacker.example')}`, { waitUntil: 'domcontentloaded' })
    check('a malformed fragment token is not stored',
      await hostilePage.evaluate(() => localStorage.getItem('dsh.pairingToken')), null)
    check('and never reaches the cookie it could have extended',
      await hostilePage.evaluate(() => document.cookie.includes('attacker.example')), false)
    await hostile.close()
  } finally {
    await browser.close()
  }
})

report('lanyard browser e2e')
