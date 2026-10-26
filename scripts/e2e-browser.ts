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

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Identify the exact Host command request a phone tap submitted. Matching only
 * the URL can consume an unrelated commands/execute call from the same page,
 * making a successful result falsely attest to the command under test.
 * Upstream's leading command-input claim may append trailing whitespace to
 * a bare slash command, so compare complete trimmed lines, not raw bytes.
 */
function commandRequestId(response: Response, line: string): string | undefined {
  if (new URL(response.url()).pathname !== '/api/commands/execute') return undefined
  try {
    const request = response.request().postDataJSON() as {
      type?: unknown
      method?: unknown
      rpcId?: unknown
      payload?: { args?: { line?: unknown } }
    } | null
    const submittedLine = request?.payload?.args?.line
    if (request?.type !== 'client-request' || request.method !== 'commands/execute'
      || typeof submittedLine !== 'string' || submittedLine.trim() !== line.trim()
      || typeof request.rpcId !== 'string' || request.rpcId.length === 0) return undefined
    return request.rpcId
  } catch {
    return undefined
  }
}

/** The Host's response envelope to a built-in slash command. */
interface CommandRpcReply {
  type?: unknown
  rpcId?: unknown
  result?: { ok?: unknown; value?: { result?: { kind?: unknown } } }
}

await withDshDeployment(async ({ cwd, port, pairingLink, fingerprint, restart }) => {
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
    let expectingOfflineRecovery = false
    let offlineRecoveryFrames = 0
    let expectingRecoveredSocket = false
    let recoveredMuxFrames = 0
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/api/remote.mux') return
      const openedAfterOffline = expectingOfflineRecovery
      const openedAfterRestart = expectingRecoveredSocket
      socket.on('framereceived', () => {
        muxFrames += 1
        if (openedAfterOffline) offlineRecoveryFrames += 1
        if (openedAfterRestart) recoveredMuxFrames += 1
      })
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

    // ---- a paired, phone-sized touch browser can begin a real task draft ----
    // Chromium mobile emulation is not a real iOS/Android device or soft keyboard.
    // Keep the desktop pairing checks above: mobile CSS and touch events must not
    // make the login/stream flow fail on a smaller screen.
    const phone = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
    })
    try {
      const phonePage = await phone.newPage()
      let phoneFrames = 0
      phonePage.on('websocket', (socket) => {
        if (new URL(socket.url()).pathname !== '/api/remote.mux') return
        socket.on('framereceived', () => { phoneFrames += 1 })
      })
      const phoneSession = phonePage.waitForResponse(response => new URL(response.url()).pathname === '/api/session/list')
      const phoneLanding = await phonePage.goto(pairingLink, { waitUntil: 'domcontentloaded' })
      const phoneReply = await phoneSession
      const phoneRpc = await phoneReply.json() as { result?: { ok?: unknown } }
      check('the phone-sized touch browser signs in over the TLS pairing link', phoneLanding?.status(), 200)
      check('the phone-sized browser removes the launch token from its address bar', phonePage.url(), `${origin}/`)
      check('the phone-sized browser makes a successful authenticated session/list RPC',
        phoneReply.status() === 200 && phoneRpc.result?.ok === true, true)
      const phoneSize = await phonePage.evaluate(() => ({
        width: window.innerWidth,
        touchPoints: navigator.maxTouchPoints,
      }))
      check('the task draft runs in an actual narrow touch-emulated viewport',
        phoneSize.width <= 390 && phoneSize.touchPoints > 0, true)
      const phoneCookie = (await phone.cookies(origin)).find(cookie => cookie.name.startsWith('dsh-auth-'))
      check('the phone stores the upstream session as an HttpOnly Secure cookie',
        phoneCookie?.httpOnly === true && phoneCookie.secure === true, true)

      // An unconfigured DSH Home has no workspace and deliberately no editor.
      // Take the same on-device Add Workspace → directory-picker route as an
      // actual first-time user; merely waiting for the composer would timeout.
      const workspacePath = join(cwd, 'phone-task-workspace')
      mkdirSync(workspacePath, { recursive: true })
      await phonePage.getByRole('button', { name: 'Add workspace', exact: true }).click()
      const picker = phonePage.getByRole('dialog', { name: 'Select Workspace Directory' })
      await picker.waitFor({ timeout: 15_000 })
      await picker.getByRole('button', { name: 'Edit path' }).click()
      const pathInput = picker.getByRole('textbox', { name: 'Edit path' })
      await pathInput.fill(workspacePath)
      await pathInput.press('Enter')
      await picker.getByRole('button', { name: 'Open', exact: true }).click()
      await picker.waitFor({ state: 'hidden', timeout: 15_000 })

      // An authenticated homepage alone says nothing about entering a task.
      // Use the real editable composer after mobile workspace onboarding.
      const composer = phonePage.locator('[data-composer-input][contenteditable="true"]').first()
      await composer.waitFor({ state: 'visible', timeout: 20_000 })
      const composerBounds = await composer.boundingBox()
      check('the task composer is inside the phone viewport',
        composerBounds !== null && composerBounds.x >= 0 && composerBounds.y >= 0
        && composerBounds.x + composerBounds.width <= phoneSize.width + 1
        && composerBounds.y + composerBounds.height <= 844, true)
      const draft = 'Explain the next step before running any tools.'
      await composer.fill(draft)
      check('a phone user can enter a task draft in the genuine composer', await composer.textContent(), draft)

      const phoneFrameDeadline = Date.now() + 10_000
      while (phoneFrames === 0 && Date.now() < phoneFrameDeadline) {
        await new Promise<void>(resolve => { setTimeout(resolve, 50) })
      }
      check('the mobile browser receives a live frame from its own WebSocket', phoneFrames > 0, true)
      check('mobile pairing does not lift the settings pin',
        pageRefused(await apiAnswer(phonePage, '/api/settings/describe')), true)

      // ---- touch Send -> real Host command -> visible acknowledgement ----
      // Generic commands such as /feedback deliberately leave a fresh, blank
      // Session on its empty hero, hiding their otherwise persisted result row.
      // A read-only /goal command contributes a visible input node, opening
      // Chat with no model request; then /feedback can show its result.
      const goalReply = phonePage.waitForResponse(
        response => commandRequestId(response, '/goal') !== undefined)
      await composer.fill('/goal')
      await phonePage.getByRole('button', { name: 'Send message', exact: true }).tap()
      const goalResponse = await goalReply
      const goalRpc = await goalResponse.json() as CommandRpcReply
      const goalRequestId = commandRequestId(goalResponse, '/goal')
      check('the goal command matcher rejects an unrelated line',
        commandRequestId(goalResponse, '/feedback unrelated') === undefined, true)
      check('the Host reply belongs to the tapped goal request',
        goalRequestId !== undefined && goalRpc.type === 'server-response'
        && goalRpc.rpcId === goalRequestId, true)
      check('a phone tap executes the read-only goal status command',
        goalResponse.status() === 200 && goalRpc.result?.ok === true
        && goalRpc.result.value?.result?.kind === 'success', true)
      await phonePage.getByText(/No goal is currently set/).first()
        .waitFor({ state: 'visible', timeout: 10_000 })

      // /feedback is a built-in, model-free command: this verifies the real
      // phone-to-Host path without credentials, an LLM, or a replay fixture.
      const feedback = '/feedback Verify phone LAN command delivery.'
      await composer.fill(feedback)
      const feedbackReply = phonePage.waitForResponse(
        response => commandRequestId(response, feedback) !== undefined)
      await phonePage.getByRole('button', { name: 'Send message', exact: true }).tap()
      const commandResponse = await feedbackReply
      const commandRpc = await commandResponse.json() as CommandRpcReply
      const feedbackRequestId = commandRequestId(commandResponse, feedback)
      check('the Host reply belongs to the tapped feedback request',
        feedbackRequestId !== undefined && commandRpc.type === 'server-response'
        && commandRpc.rpcId === feedbackRequestId, true)
      check('tapping Send executes feedback successfully in the real Host',
        commandResponse.status() === 200 && commandRpc.result?.ok === true
        && commandRpc.result.value?.result?.kind === 'success', true)
      const receipt = phonePage.getByText(/Feedback recorded for session/)
      await receipt.waitFor({ state: 'visible', timeout: 10_000 })
      check('the phone shows the real Host command acknowledgement', await receipt.isVisible(), true)
      check('sending the command clears the phone composer', await composer.textContent(), '')

      // ---- a paired phone reopens its saved URL after connectivity returns ----
      // Model a phone browser whose tab is discarded while offline. This proves
      // saved-origin recovery in Chromium touch emulation, not a hardware Wi-Fi
      // handoff, background eviction, or survival of an unsent draft.
      await phone.setOffline(true)
      check('the phone reports that its network is offline',
        await phonePage.evaluate(() => navigator.onLine), false)
      const mobileOfflineRequestFailed = await phonePage.evaluate(async () => {
        try {
          await fetch('/api/session/list', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request', rpcId: 'phone-offline-probe',
              method: 'session/list', payload: { args: {} },
            }),
          })
          return false
        } catch {
          return true
        }
      })
      check('the offline phone cannot reach the real session API', mobileOfflineRequestFailed, true)
      await phonePage.close()
      await phone.setOffline(false)

      // Reuse the browser profile, not the launch token. A fresh page and
      // socket must succeed with the original HttpOnly cookie and workspace.
      const resumedPhone = await phone.newPage()
      let resumedPhoneFrames = 0
      let usedTokenOnResume = false
      resumedPhone.on('request', (request) => {
        if (request.isNavigationRequest() && new URL(request.url()).searchParams.has('token')) {
          usedTokenOnResume = true
        }
      })
      resumedPhone.on('websocket', (socket) => {
        if (new URL(socket.url()).pathname !== '/api/remote.mux') return
        socket.on('framereceived', () => { resumedPhoneFrames += 1 })
      })
      const resumedPhoneSession = resumedPhone.waitForResponse(
        response => new URL(response.url()).pathname === '/api/session/list')
      const resumedPhoneLanding = await resumedPhone.goto(origin, { waitUntil: 'domcontentloaded' })
      const resumedPhoneReply = await resumedPhoneSession
      const resumedPhoneRpc = await resumedPhoneReply.json() as { result?: { ok?: unknown } }
      check('the phone reopens its saved TLS origin after network loss', resumedPhoneLanding?.status(), 200)
      check('the reopened phone authenticates a real session/list RPC',
        resumedPhoneReply.status() === 200 && resumedPhoneRpc.result?.ok === true, true)
      const phoneCookieAfterRecovery = (await phone.cookies(origin)).find(
        cookie => cookie.name.startsWith('dsh-auth-'))
      check('the reopened phone retains its existing secure HttpOnly session',
        phoneCookie !== undefined && phoneCookieAfterRecovery !== undefined
        && phoneCookieAfterRecovery.httpOnly && phoneCookieAfterRecovery.secure
        && phoneCookieAfterRecovery.value === phoneCookie.value, true)
      const recoveredComposer = resumedPhone.locator('[data-composer-input][contenteditable="true"]').first()
      await recoveredComposer.waitFor({ state: 'visible', timeout: 20_000 })
      // An editor and an authenticated socket alone do not show that the
      // conversation survived. Require the actual Host acknowledgement from
      // before the outage to return in the reopened phone's transcript; never
      // issue /feedback again here (which would mask lost conversation state).
      const recoveredReceipt = resumedPhone.getByText(/Feedback recorded for session/)
      await recoveredReceipt.waitFor({ state: 'visible', timeout: 20_000 })
      check('the reopened phone restores its pre-outage Host acknowledgement',
        await recoveredReceipt.isVisible(), true)
      const recoveryBounds = await recoveredComposer.boundingBox()
      check('the existing workspace composer reappears within the phone viewport',
        recoveryBounds !== null && recoveryBounds.x >= 0 && recoveryBounds.y >= 0
        && recoveryBounds.x + recoveryBounds.width <= phoneSize.width + 1
        && recoveryBounds.y + recoveryBounds.height <= 844, true)
      const recoveredDraft = 'Continue from this workspace after reconnecting.'
      await recoveredComposer.fill(recoveredDraft)
      check('the reopened phone can type a fresh task draft',
        await recoveredComposer.textContent(), recoveredDraft)
      const resumedPhoneFrameDeadline = Date.now() + 10_000
      while (resumedPhoneFrames === 0 && Date.now() < resumedPhoneFrameDeadline) {
        await new Promise<void>(resolve => { setTimeout(resolve, 50) })
      }
      check('the reopened phone receives frames on a new WebSocket',
        resumedPhoneFrames > 0, true)
      check('mobile network recovery still refuses the configuration API',
        pageRefused(await apiAnswer(resumedPhone, '/api/settings/describe')), true)
      // Check after the asynchronous RPC, stream and editor steps: late
      // navigation to a pairing token must not pass unnoticed.
      check('mobile recovery never revisits a launch-token URL', usedTokenOnResume, false)
      check('mobile recovery ends at the saved bare TLS address', resumedPhone.url(), `${origin}/`)
      await resumedPhone.close()
    } finally {
      await phone.close()
    }

    // ---- the point of pairing: the bare address works afterwards ----
    const later = await page.goto(origin, { waitUntil: 'domcontentloaded' })
    check('a later visit to the bare address needs no link', later?.status(), 200)
    check('while the configuration plane stays refused, even paired',
      pageRefused(await apiAnswer(page, '/api/settings/describe')), true)

    // ---- a phone temporarily loses its network, then opens its saved address ----
    // This is a Chromium-level connectivity interruption, not an iOS/Android
    // hardware or Wi-Fi handoff test. Keep this browser context and its cookie;
    // creating a new context or revisiting the token-bearing URL would hide
    // the very recovery regression this checks.
    await paired.setOffline(true)
    check('the paired browser detects loss of network connectivity',
      await page.evaluate(() => navigator.onLine), false)
    const unreachableWhileOffline = await page.evaluate(async () => {
      try {
        // POST cannot be satisfied by a cached document or service worker
        // navigation. It must fail at the network boundary while offline.
        await fetch('/api/session/list', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'offline-probe', method: 'session/list', payload: { args: {} },
          }),
        })
        return false
      } catch {
        return true
      }
    })
    check('the browser cannot send an API request while offline', unreachableWhileOffline, true)

    await paired.setOffline(false)
    expectingOfflineRecovery = true
    const onlineSession = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/list')
    const onlinePage = await page.goto(origin, { waitUntil: 'domcontentloaded' })
    const onlineReply = await onlineSession
    const onlineRpc = await onlineReply.json() as { result?: { ok?: unknown } }
    check('the bookmarked TLS address loads again without a new pairing link', onlinePage?.status(), 200)
    check('the prior session authenticates real RPC after connectivity returns',
      onlineReply.status() === 200 && onlineRpc.result?.ok === true, true)
    const onlineFrameDeadline = Date.now() + 10_000
    while (offlineRecoveryFrames === 0 && Date.now() < onlineFrameDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    check('a new WebSocket receives a frame after network recovery', offlineRecoveryFrames > 0, true)
    expectingOfflineRecovery = false
    const onlineCookie = (await paired.cookies(origin)).find(cookie => cookie.name.startsWith('dsh-auth-'))
    check('network recovery keeps the same HttpOnly session cookie',
      session !== undefined && onlineCookie !== undefined && onlineCookie.value === session.value, true)
    check('the configuration plane stays refused after network recovery',
      pageRefused(await apiAnswer(page, '/api/settings/describe')), true)

    // ---- restart dsh: the same phone should resume without scanning again ----
    const restarted = await restart()
    check('a restart reuses the certificate the phone trusted', restarted.fingerprint, fingerprint)
    const oldToken = new URL(pairingLink).searchParams.get('token')
    const newToken = new URL(restarted.pairingLink).searchParams.get('token')
    check('the restart rotated its launch token, rather than reusing the old pairing link',
      oldToken !== null && newToken !== null && oldToken !== newToken, true)

    // A fresh page navigation mimics reopening the bookmarked address after
    // dsh has restarted. The browser context (and its original session cookie)
    // is deliberately preserved; a new context would quietly mask a failure.
    expectingRecoveredSocket = true
    const resumedSession = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/list')
    const resumedPage = await page.goto(origin, { waitUntil: 'domcontentloaded' })
    const listedAfterRestart = await resumedSession
    check('the same phone opens its bookmarked URL after dsh restarts, without pairing again', resumedPage?.status(), 200)
    const resumedRpc = await listedAfterRestart.json() as { result?: { ok?: unknown } }
    check('its previous session still successfully lists sessions, not just returns HTTP 200',
      listedAfterRestart.status() === 200 && resumedRpc.result?.ok === true, true)
    // Observing a WebSocket object is not a successful handshake. Require a
    // frame on a socket opened after restart, never the previous socket.
    const frameDeadline = Date.now() + 10_000
    while (recoveredMuxFrames === 0 && Date.now() < frameDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    check('the recovered stream delivers a frame on a new WebSocket', recoveredMuxFrames > 0, true)
    // Never log the cookie value in CI: it is a bearer credential.
    const resumedCookie = (await paired.cookies(origin)).find(cookie => cookie.name.startsWith('dsh-auth-'))
    check('the browser retained its existing HttpOnly session rather than getting a new one',
      session !== undefined && resumedCookie !== undefined && resumedCookie.value === session.value, true)
    check('the configuration plane is still refused after recovery',
      pageRefused(await apiAnswer(page, '/api/settings/describe')), true)

    // ---- reopen the browser tab after a restart, without pairing again ----
    // This exercises a new document and WebSocket with the browser profile's
    // existing cookie. It is not an iOS/Android lock-screen, background
    // eviction, or real Wi-Fi handoff test.
    await page.close()
    const reopened = await paired.newPage()
    let reopenedMuxFrames = 0
    reopened.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/api/remote.mux') return
      socket.on('framereceived', () => { reopenedMuxFrames += 1 })
    })
    // Merely passing goto(origin) does not prove the app did not redirect to
    // a token-bearing link. Observe all navigation requests on this new page.
    let reopenedSawPairingToken = false
    reopened.on('request', (request) => {
      if (request.isNavigationRequest() && new URL(request.url()).searchParams.has('token')) {
        reopenedSawPairingToken = true
      }
    })
    const reopenedSession = reopened.waitForResponse(response => new URL(response.url()).pathname === '/api/session/list')
    const reopenedLanding = await reopened.goto(origin, { waitUntil: 'domcontentloaded' })
    const reopenedReply = await reopenedSession
    const reopenedRpc = await reopenedReply.json() as { result?: { ok?: unknown } }
    check('a newly opened browser tab loads the saved address', reopenedLanding?.status(), 200)
    check('the new tab authenticates its own real session/list RPC',
      reopenedReply.status() === 200 && reopenedRpc.result?.ok === true, true)
    const reopenedFrameDeadline = Date.now() + 10_000
    while (reopenedMuxFrames === 0 && Date.now() < reopenedFrameDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    check('the new tab receives a frame on its own stream WebSocket', reopenedMuxFrames > 0, true)
    const reopenedCookie = (await paired.cookies(origin)).find(cookie => cookie.name.startsWith('dsh-auth-'))
    check('reopening the tab retains the original HttpOnly session cookie',
      session !== undefined && reopenedCookie !== undefined
      && reopenedCookie.httpOnly && reopenedCookie.value === session.value, true)
    check('the new tab still cannot reach the configuration plane',
      pageRefused(await apiAnswer(reopened, '/api/settings/describe')), true)
    // Evaluate navigation history and final URL *after* asynchronous RPC,
    // frame and configuration probes: a late redirect must still fail.
    check('reopening never navigates to a pairing-token URL', reopenedSawPairingToken, false)
    check('the reopened tab stays on the bookmarked bare TLS origin', reopened.url(), `${origin}/`)
    await reopened.close()
    await paired.close()

    // ---- neither the old launch token nor a forged one can pair ----
    const hostile = await browser.newContext({ ignoreHTTPSErrors: true })
    const hostilePage = await hostile.newPage()
    const expired = await hostilePage.goto(pairingLink, { waitUntil: 'domcontentloaded' })
    check('the previous process\'s pairing link is invalid after restart', expired?.status(), 401)
    const forged = await hostilePage.goto(`${origin}/?token=${'A'.repeat(43)}`, { waitUntil: 'domcontentloaded' })
    check('a link carrying the wrong token is refused', forged?.status(), 401)
    check('and leaves no session behind', (await hostile.cookies(origin)).some(cookie => cookie.name.startsWith('dsh-auth-')), false)
    await hostile.close()
  } finally {
    await browser.close()
  }
})

report('lanyard browser e2e')
