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
import { createServer } from 'node:http'
import { hasNoPluginEntries, hasPluginListEntries } from './tool-result-assertions.ts'
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

/**
 * Correlate a normal message from the touch composer with the exact Host
 * session/prompt request. A generic 200 on this path could belong to another
 * tab or request and must not count as this phone's submission.
 */
function promptRequestId(response: Response, expectedText: string): string | undefined {
  if (new URL(response.url()).pathname !== '/api/session/prompt') return undefined
  try {
    const message = response.request().postDataJSON() as {
      type?: unknown
      method?: unknown
      rpcId?: unknown
      payload?: { args?: { request?: {
        requestId?: unknown
        sessionId?: unknown
        mode?: unknown
        content?: unknown
      } } }
    } | null
    const prompt = message?.payload?.args?.request
    const content = prompt?.content
    if (message?.type !== 'client-request' || message.method !== 'session/prompt'
      || typeof message.rpcId !== 'string' || message.rpcId.length === 0
      || typeof prompt?.requestId !== 'string' || prompt.requestId.length === 0
      || typeof prompt.sessionId !== 'string' || prompt.sessionId.length === 0
      || prompt.mode !== 'queue' || !Array.isArray(content) || content.length !== 1) return undefined
    const part = content[0] as { type?: unknown; text?: unknown } | undefined
    return part?.type === 'text' && part.text === expectedText ? message.rpcId : undefined
  } catch {
    return undefined
  }
}

/** The Host's response to an ordinary session prompt, not an LLM completion. */
interface PromptRpcReply {
  type?: unknown
  rpcId?: unknown
  result?: { ok?: unknown; value?: { accepted?: unknown } }
}

/** The Host's response envelope to a built-in slash command. */
interface CommandRpcReply {
  type?: unknown
  rpcId?: unknown
  result?: { ok?: unknown; value?: { result?: { kind?: unknown } } }
}

/** Deliberately external to the shipped DSH Host, but bound to loopback only.
 * This mocks inference, not the model adapter, Agent loop, Session, or phone UI.
 */
const MODEL_ROUTE = 'lanyard-e2e'
const MODEL_ID = 'lanyard-e2e-model'
const MODEL_REPLY = 'The local fixture model replied to your phone task.'
const APPROVAL_DENY_PROMPT = 'List one installed plugin, but ask first; I may reject permission.'
const APPROVAL_DENY_CALL_ID = 'call_lanyard_denied_plugin_listing'
const APPROVAL_DENIED_REPLY = 'The phone rejected permission; no plugin listing was returned.'
const APPROVAL_ALLOW_PROMPT = 'List one installed plugin; I will approve this one-time request.'
const APPROVAL_ALLOW_CALL_ID = 'call_lanyard_allowed_plugin_listing'
const APPROVAL_ALLOWED_REPLY = 'The phone approved the tool and the Host returned a plugin list.'

interface FixtureModelCall {
  model?: unknown
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>
  tools?: Array<{ function?: { name?: string } }>
}

async function startModelFixture(): Promise<{
  url: string
  requests: FixtureModelCall[]
  close(): Promise<void>
}> {
  const requests: FixtureModelCall[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404)
      response.end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 1_000_000) request.destroy(new Error('oversized model fixture request'))
    })
    request.on('end', () => {
      let input: FixtureModelCall
      try {
        input = JSON.parse(body) as FixtureModelCall
        requests.push(input)
      } catch {
        response.writeHead(400)
        response.end('invalid JSON')
        return
      }
      const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
        JSON.stringify({
          id: 'chatcmpl-lanyard-e2e',
          object: 'chat.completion.chunk',
          created: 1_793_030_000,
          model: MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })
      // The fixture supplies inference, never a fabricated Host permission
      // decision or tool output. plugin_manager/list_plugins is read-only but
      // requires upstream's real one-shot approval before execution.
      const messages = Array.isArray(input.messages) ? input.messages : []
      // Look at the most recent task; a reused session can contain both
      // prompts in history, so merely searching for the deny text misroutes
      // the later Allow-once request to the previous rejection case.
      const transcript = JSON.stringify(messages)
      const denyPosition = transcript.lastIndexOf(APPROVAL_DENY_PROMPT)
      const allowPosition = transcript.lastIndexOf(APPROVAL_ALLOW_PROMPT)
      const approvalTask = denyPosition > allowPosition
      const allowTask = allowPosition > denyPosition
      const approvalCallId = approvalTask ? APPROVAL_DENY_CALL_ID
        : allowTask ? APPROVAL_ALLOW_CALL_ID : undefined
      const pluginToolAvailable = input.tools?.some(tool => tool.function?.name === 'plugin_manager') === true
      const matchingToolResults = approvalCallId === undefined ? [] : messages.filter(message =>
        message.role === 'tool' && message.tool_call_id === approvalCallId)
      const toolResult = matchingToolResults.length === 1 ? matchingToolResults[0] : undefined
      const callForApproval = approvalCallId !== undefined
        && pluginToolAvailable && matchingToolResults.length === 0
      const toolWasRejected = toolResult !== undefined &&
        JSON.stringify(toolResult.content).includes('the user rejected escalating this plugin management operation')
      const answer = approvalCallId !== undefined && matchingToolResults.length > 0
        ? toolResult === undefined ? 'Unexpected repeated plugin tool results.'
          : approvalTask
            ? toolWasRejected ? APPROVAL_DENIED_REPLY : 'Unexpected plugin rejection outcome.'
            : hasPluginListEntries(toolResult.content)
              ? APPROVAL_ALLOWED_REPLY : 'Unexpected plugin approval outcome.'
        : MODEL_REPLY
      const frames = callForApproval ? [
        chunk({ role: 'assistant', content: '' }, null),
        chunk({ tool_calls: [{
          index: 0, id: approvalCallId, type: 'function',
          function: { name: 'plugin_manager', arguments: JSON.stringify({ action: 'list_plugins', limit: 1 }) },
        }] }, null),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ] : [
        chunk({ role: 'assistant', content: '' }, null),
        chunk({ content: answer }, null),
        chunk({}, 'stop'),
        '[DONE]',
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      for (const frame of frames) response.write(`data: ${frame}\n\n`)
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => { if (error) reject(error); else resolve() }))
    },
  }
}

const modelFixture = await startModelFixture()
try {
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
    // Preserve the same mobile browser profile and its cookie through the
    // real DSH process restart below; browser.close() cleans up on failure.
    {
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

    // Save the mobile profile's existing cookie before the actual host reboot.
    const mobileCookieBeforeRestart = (await phone.cookies(origin)).find(
      cookie => cookie.name.startsWith('dsh-auth-'))

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

    // ---- the same paired mobile profile survives a real DSH restart ----
    // Unlike the earlier offline-only test, this rebooted the installed Host.
    // Open a fresh touch-browser tab at the bookmarked origin, not a token URL,
    // and NEVER resubmit /feedback to hide a missing persisted result.
    const mobileAfterRestart = await phone.newPage()
    let mobileRestartFrames = 0
    let mobileRestartSawToken = false
    mobileAfterRestart.on('request', request => {
      if (request.isNavigationRequest() && new URL(request.url()).searchParams.has('token')) {
        mobileRestartSawToken = true
      }
    })
    mobileAfterRestart.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/api/remote.mux') return
      socket.on('framereceived', () => { mobileRestartFrames += 1 })
    })
    const mobileRestartSession = mobileAfterRestart.waitForResponse(
      response => new URL(response.url()).pathname === '/api/session/list')
    const mobileRestartLanding = await mobileAfterRestart.goto(origin, { waitUntil: 'domcontentloaded' })
    const mobileRestartReply = await mobileRestartSession
    const mobileRestartRpc = await mobileRestartReply.json() as { result?: { ok?: unknown } }
    check('the same paired touch browser reopens the bare TLS origin after DSH restarts',
      mobileRestartLanding?.status(), 200)
    check('the reopened phone makes a successful Host session/list RPC after restart',
      mobileRestartReply.status() === 200 && mobileRestartRpc.result?.ok === true, true)
    const mobileCookieAfterRestart = (await phone.cookies(origin)).find(
      cookie => cookie.name.startsWith('dsh-auth-'))
    check('DSH restart preserves the phone original secure HttpOnly session cookie',
      mobileCookieBeforeRestart !== undefined && mobileCookieAfterRestart !== undefined
      && mobileCookieAfterRestart.httpOnly && mobileCookieAfterRestart.secure
      && mobileCookieAfterRestart.value === mobileCookieBeforeRestart.value, true)
    const restartMobileComposer = mobileAfterRestart.locator('[data-composer-input][contenteditable="true"]').first()
    await restartMobileComposer.waitFor({ state: 'visible', timeout: 20_000 })
    const mobileRestartReceipt = mobileAfterRestart.getByText(/Feedback recorded for session/)
    await mobileRestartReceipt.waitFor({ state: 'visible', timeout: 20_000 })
    check('the phone restores its pre-restart Host feedback without resending the command',
      await mobileRestartReceipt.isVisible(), true)
    const mobileRestartFrameDeadline = Date.now() + 10_000
    while (mobileRestartFrames === 0 && Date.now() < mobileRestartFrameDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    check('restarted DSH delivers a frame to the newly opened mobile WebSocket',
      mobileRestartFrames > 0, true)
    check('mobile restart recovery keeps the settings namespace loopback-only',
      pageRefused(await apiAnswer(mobileAfterRestart, '/api/settings/describe')), true)
    check('the resumed mobile tab never requests a new pairing token', mobileRestartSawToken, false)
    check('the resumed mobile tab ends at the saved TLS origin', mobileAfterRestart.url(), `${origin}/`)
    // ---- first ordinary phone prompt reaches the real Host ----
    // This clean DSH_HOME has no configured model. Acceptance by session/prompt
    // is a deliberately smaller milestone than a model response, permission
    // request, tool execution, or physical-phone test.
    const normalPrompt = 'Describe the next action before using any tools.'
    const promptReply = mobileAfterRestart.waitForResponse(
      response => promptRequestId(response, normalPrompt) !== undefined)
    await restartMobileComposer.fill(normalPrompt)
    await mobileAfterRestart.getByRole('button', { name: 'Send message', exact: true }).tap()
    const promptResponse = await promptReply
    const promptRpc = await promptResponse.json() as PromptRpcReply
    const submittedPromptRpcId = promptRequestId(promptResponse, normalPrompt)
    const submittedRequest = promptResponse.request().postDataJSON() as {
      payload?: { args?: { request?: { sessionId?: unknown; requestId?: unknown } } }
    }
    const submittedSessionId = submittedRequest.payload?.args?.request?.sessionId
    const submittedRequestId = submittedRequest.payload?.args?.request?.requestId
    if (typeof submittedSessionId !== 'string' || submittedSessionId.length === 0
      || typeof submittedRequestId !== 'string' || submittedRequestId.length === 0) {
      throw new Error('the accepted phone prompt had no durable session/request identity')
    }
    check('the normal prompt matcher rejects an unrelated message',
      promptRequestId(promptResponse, 'Different prompt') === undefined, true)
    check('the ordinary phone prompt response matches its actual Host RPC request',
      submittedPromptRpcId !== undefined && promptRpc.type === 'server-response'
      && promptRpc.rpcId === submittedPromptRpcId, true)
    check('the real Host accepts the normal text prompt from the paired phone',
      promptResponse.status() === 200 && promptRpc.result?.ok === true
      && promptRpc.result.value?.accepted === true, true)
    const submittedPrompt = mobileAfterRestart.getByText(normalPrompt, { exact: true })
    await submittedPrompt.waitFor({ state: 'visible', timeout: 20_000 })
    check('the phone displays its submitted normal prompt in the conversation',
      await submittedPrompt.isVisible(), true)

    // This is a real DSH Agent/model-adapter/UI round trip. Only the
    // non-deterministic model endpoint is fake, and it listens on loopback.
    // Checking Host acceptance or local chat echo is insufficient.
    const visibleModelReply = mobileAfterRestart.locator('[data-chat-flow]').getByText(MODEL_REPLY, { exact: true }).first()
    await visibleModelReply.waitFor({ state: 'visible', timeout: 30_000 })
    check('the paired phone displays the actual streamed model response',
      await visibleModelReply.isVisible(), true)
    // The shipped Web profile performs TWO distinct model calls: one Agent
    // answer and one asynchronous first-prompt Session title. Enforcing one
    // total call was incorrect and flagged correct upstream title generation.
    const titleDeadline = Date.now() + 10_000
    while (modelFixture.requests.length < 2 && Date.now() < titleDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    const modelCalls = modelFixture.requests as Array<{ model?: unknown; messages?: unknown }>
    check('the Host performs a task completion and its first-prompt title generation',
      modelCalls.length, 2)
    check('both provider calls stay on the local-only test model, never an ambient real provider',
      modelCalls.every(call => call.model === MODEL_ID), true)
    check('task completion and title generation have different input messages, not a duplicate retry',
      JSON.stringify(modelCalls[0]?.messages) !== JSON.stringify(modelCalls[1]?.messages), true)
    check('the model received the paired phone task, not an unrelated request',
      modelCalls.some(call => JSON.stringify(call.messages ?? null).includes(normalPrompt)), true)

    // ---- reopening a submitted task must restore its durable Host record ----
    // The local echo and browser storage cannot attest to persistence.
    // Read the Host's sequenced projection watermark, then its authoritative
    // Session history page for the exact submitted Session and request ID.
    await mobileAfterRestart.close()
    const reopenedTask = await phone.newPage()
    let reopenedTaskSawToken = false
    let reopenedTaskResubmissions = 0
    reopenedTask.on('request', (request) => {
      const target = new URL(request.url())
      if (request.isNavigationRequest() && target.searchParams.has('token')) {
        reopenedTaskSawToken = true
      }
      if (target.pathname === '/api/session/prompt') reopenedTaskResubmissions += 1
    })
    const reopenedTaskSession = reopenedTask.waitForResponse(
      response => new URL(response.url()).pathname === '/api/session/list')
    const reopenedTaskLanding = await reopenedTask.goto(origin, { waitUntil: 'domcontentloaded' })
    const reopenedTaskReply = await reopenedTaskSession
    const reopenedTaskRpc = await reopenedTaskReply.json() as { result?: { ok?: unknown } }
    check('a submitted task reopens at the saved phone TLS address',
      reopenedTaskLanding?.status() === 200, true)
    check('a reopened task still authenticates its Host session/list RPC',
      reopenedTaskReply.status() === 200 && reopenedTaskRpc.result?.ok === true, true)

    const hostHistory = await reopenedTask.evaluate(async (sessionId: string) => {
      interface Reply {
        status: number
        rpcId: string
        body: { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } }
      }
      const rpc = async (method: string, request: Record<string, unknown>): Promise<Reply> => {
        const rpcId = `e2e-reopen-${method.replace('/', '-')}`
        const response = await fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
        })
        return { status: response.status, rpcId, body: await response.json() as Reply['body'] }
      }
      const projections = await rpc('session/projections', { sessionId })
      const baseline = projections.body.result?.value as { kind?: unknown; asOfSeq?: unknown } | undefined
      if (projections.status !== 200 || projections.body.type !== 'server-response'
        || projections.body.rpcId !== projections.rpcId || projections.body.result?.ok !== true
        || baseline?.kind !== 'sequenced' || typeof baseline.asOfSeq !== 'number'
        || !Number.isSafeInteger(baseline.asOfSeq) || baseline.asOfSeq < 0) {
        return { projections, page: null }
      }
      const page = await rpc('session/page', {
        address: { kind: 'session', sessionId },
        throughSeq: baseline.asOfSeq,
        maxMessages: 50,
      })
      return { projections, page }
    }, submittedSessionId)
    const projection = hostHistory.projections
    const projectionValue = projection.body.result?.value as { kind?: unknown; asOfSeq?: unknown } | undefined
    check('the Host returned a sequenced snapshot for the submitted Session',
      projection.status === 200 && projection.body.type === 'server-response'
      && projection.body.rpcId === projection.rpcId && projection.body.result?.ok === true
      && projectionValue?.kind === 'sequenced'
      && typeof projectionValue.asOfSeq === 'number', true)
    const pageReply = hostHistory.page
    const pageValue = pageReply?.body.result?.value as {
      records?: Array<{
        type?: unknown
        event?: {
          type?: unknown
          data?: { source?: { kind?: unknown; rpcId?: unknown }; content?: unknown }
        }
      }>
    } | undefined
    check('the Host accepted an authenticated history-page read for that Session',
      pageReply?.status === 200 && pageReply.body.type === 'server-response'
      && pageReply.body.rpcId === pageReply.rpcId && pageReply.body.result?.ok === true
      && Array.isArray(pageValue?.records), true)
    const durablePrompt = pageValue?.records?.some(record => {
      if (record.type !== 'event' || record.event?.type !== 'user/message') return false
      const source = record.event.data?.source
      if (source?.kind !== 'user' || source.rpcId !== submittedRequestId) return false
      const content = record.event.data?.content
      return Array.isArray(content) && content.some((part: unknown) => {
        const text = part as { type?: unknown; text?: unknown } | null
        return text?.type === 'text' && text.text === normalPrompt
      })
    })
    check('the Host persisted the exact prompt under its original Session and request identity',
      durablePrompt, true)

    // Locate the visible copy only AFTER reading the actual Host history.
    // The surrounding DOM markers distinguish durable Chat from an optimistic
    // echo, unsent composer draft, or another UI surface.
    const visiblePrompt = reopenedTask.getByText(normalPrompt, { exact: true }).first()
    await visiblePrompt.waitFor({ state: 'visible', timeout: 20_000 })
    const visibleLocation = await visiblePrompt.evaluate((node) => ({
      flow: node.closest('[data-chat-flow]') !== null,
      echo: node.closest('[data-submission-echo]') !== null,
      composer: node.closest('[data-composer-input]') !== null,
    }))
    // The installed UI renders this text in Chat flow, not necessarily inside
    // data-message-bubble. The separate Host history assertion above is what
    // establishes durability; this asserts where the user can see it.
    check('the reopened phone displays the Host-backed prompt in Chat, not an echo or draft',
      visibleLocation.flow && !visibleLocation.echo && !visibleLocation.composer, true)

    // The observation window ends only after the asynchronous Host history
    // and settings probes, then the tab is closed. Late resends or navigation
    // during those requests must be counted, not hidden by an early snapshot.
    check('reopening a submitted task keeps the configuration plane pinned',
      pageRefused(await apiAnswer(reopenedTask, '/api/settings/describe')), true)
    const finalTaskUrl = reopenedTask.url()
    await reopenedTask.close()
    check('reopening a submitted task ends at the saved bare TLS address',
      finalTaskUrl, `${origin}/`)
    check('reopening a submitted task does not re-send its prompt',
      reopenedTaskResubmissions, 0)
    check('reopening a submitted task does not re-use a launch token',
      reopenedTaskSawToken, false)
    // ---- real model-driven approval; paired phone explicitly rejects ----
    // The only mock is loopback-only inference. DSH decides permission and
    // returns the tool result through its actual Agent and Remote waterfall.
    const permissionPhone = await phone.newPage()
    const permissionLanding = await permissionPhone.goto(origin, { waitUntil: 'domcontentloaded' })
    check('approval begins from the existing paired phone TLS address',
      permissionLanding?.status(), 200)
    const permissionComposer = permissionPhone.locator('[data-composer-input][contenteditable="true"]').first()
    await permissionComposer.waitFor({ state: 'visible', timeout: 20_000 })
    const permissionPromptResponse = permissionPhone.waitForResponse(
      response => promptRequestId(response, APPROVAL_DENY_PROMPT) !== undefined)
    await permissionComposer.fill(APPROVAL_DENY_PROMPT)
    await permissionPhone.getByRole('button', { name: 'Send message', exact: true }).tap()
    const permissionHostReply = await permissionPromptResponse
    const permissionHostRpc = await permissionHostReply.json() as PromptRpcReply
    check('the Host accepts the exact model-driven permission task from the phone',
      permissionHostReply.status() === 200 && permissionHostRpc.type === 'server-response'
      && permissionHostRpc.rpcId === promptRequestId(permissionHostReply, APPROVAL_DENY_PROMPT)
      && permissionHostRpc.result?.ok === true && permissionHostRpc.result.value?.accepted === true, true)

    const approvalCard = permissionPhone.locator('[data-approval-key]').first()
    await approvalCard.waitFor({ state: 'visible', timeout: 30_000 })
    check('the genuine phone approval card identifies the privileged tool',
      (await approvalCard.innerText()).includes('plugin_manager'), true)
    check('the browser presents a real one-shot permission choice',
      await approvalCard.getByRole('button', { name: 'Allow once', exact: true }).isVisible(), true)
    check('the local model was offered the actual plugin_manager tool',
      modelFixture.requests.some(call => call.model === MODEL_ID
        && JSON.stringify(call.messages).includes(APPROVAL_DENY_PROMPT)
        && call.tools?.some(tool => tool.function?.name === 'plugin_manager') === true), true)

    await approvalCard.getByRole('button', { name: 'Reject', exact: true }).tap()
    const rejectedReply = permissionPhone.locator('[data-chat-flow]')
      .getByText(APPROVAL_DENIED_REPLY, { exact: true }).first()
    await rejectedReply.waitFor({ state: 'visible', timeout: 30_000 })
    const rejectionCalls = modelFixture.requests.filter(call => call.messages?.some(message =>
      message.role === 'tool' && message.tool_call_id === APPROVAL_DENY_CALL_ID))
    const rejectedToolResult = rejectionCalls.at(-1)?.messages?.find(message =>
      message.role === 'tool' && message.tool_call_id === APPROVAL_DENY_CALL_ID)
    const rejectionText = JSON.stringify(rejectedToolResult?.content ?? null)
    check('the model receives the genuine rejected Host tool result, not a fixture-created denial',
      rejectionText.includes('the user rejected escalating this plugin management operation'), true)
    check('a refused plugin list operation returns no installed-plugin entries',
      hasNoPluginEntries(rejectedToolResult?.content), true)
    check('the phone displays the model continuation after rejecting the Host tool request',
      await rejectedReply.isVisible(), true)
    check('rejecting a tool does not unpin mobile settings',
      pageRefused(await apiAnswer(permissionPhone, '/api/settings/describe')), true)
    await permissionPhone.close()

    // ---- same real Agent approval surface; phone permits exactly one read ----
    // The fixture cannot invent a successful tool response: it only emits
    // this continuation after the installed plugin_manager has returned its
    // own structured list to the Agent's next provider request.
    const allowingPhone = await phone.newPage()
    let awaitingReconnectStream = false
    let approvalRecoveredFrames = 0
    // A visible React approval card may outlive a dead socket. Observe a
    // *new* Host Remote-mux connection receiving data after the outage.
    allowingPhone.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/api/remote.mux') return
      const openedAfterDrop = awaitingReconnectStream
      socket.on('framereceived', () => {
        if (openedAfterDrop) approvalRecoveredFrames += 1
      })
    })
    const allowingLanding = await allowingPhone.goto(origin, { waitUntil: 'domcontentloaded' })
    check('allow-once begins at the previously paired TLS address',
      allowingLanding?.status(), 200)
    const allowingComposer = allowingPhone.locator('[data-composer-input][contenteditable="true"]').first()
    await allowingComposer.waitFor({ state: 'visible', timeout: 20_000 })
    const allowingPromptResponse = allowingPhone.waitForResponse(
      response => promptRequestId(response, APPROVAL_ALLOW_PROMPT) !== undefined)
    await allowingComposer.fill(APPROVAL_ALLOW_PROMPT)
    await allowingPhone.getByRole('button', { name: 'Send message', exact: true }).tap()
    const allowingHostReply = await allowingPromptResponse
    const allowingHostRpc = await allowingHostReply.json() as PromptRpcReply
    check('Host accepts the exact phone task requesting an allowed tool execution',
      allowingHostReply.status() === 200 && allowingHostRpc.type === 'server-response'
      && allowingHostRpc.rpcId === promptRequestId(allowingHostReply, APPROVAL_ALLOW_PROMPT)
      && allowingHostRpc.result?.ok === true && allowingHostRpc.result.value?.accepted === true, true)

    const allowingCard = allowingPhone.locator('[data-approval-key]').first()
    await allowingCard.waitFor({ state: 'visible', timeout: 30_000 })
    check('Host approval card presents the actual plugin_manager tool before execution',
      (await allowingCard.innerText()).includes('plugin_manager'), true)
    check('the user can authorize only this tool call from the touch UI',
      await allowingCard.getByRole('button', { name: 'Allow once', exact: true }).isVisible(), true)
    check('the model was offered plugin_manager for the specific allowed task',
      modelFixture.requests.some(call => call.model === MODEL_ID
        && JSON.stringify(call.messages).includes(APPROVAL_ALLOW_PROMPT)
        && call.tools?.some(tool => tool.function?.name === 'plugin_manager') === true), true)
    // A transient phone Wi-Fi outage while a privileged tool is awaiting
    // consent must not grant permission, change the pending request, or make
    // the user resubmit the prompt. Keep the tab open: this is not the earlier
    // close-and-reopen recovery case. Only the model endpoint is synthetic.
    // The UI's data-approval-key is a render-local counter: the same pending
    // Host request can receive a new card key when the stream reconnects.
    // Track the actual model call and tool-call ID, not this presentation key.
    const callsForPendingTask = (): number => modelFixture.requests.filter(call =>
      call.tools?.some(tool => tool.function?.name === 'plugin_manager') === true
      && JSON.stringify(call.messages).includes(APPROVAL_ALLOW_PROMPT)).length
    const pendingTaskCallsBeforeDrop = callsForPendingTask()
    check('the Host produced a model tool request for the pending approval',
      pendingTaskCallsBeforeDrop > 0, true)
    const priorToolResults = (): number => modelFixture.requests.reduce((total, call) =>
      total + (call.messages?.filter(message =>
        message.role === 'tool' && message.tool_call_id === APPROVAL_ALLOW_CALL_ID).length ?? 0), 0)
    check('the model has received no allowed tool result before consent', priorToolResults(), 0)
    await phone.setOffline(true)
    check('the phone loses connectivity while the Host approval remains unanswered',
      await allowingPhone.evaluate(() => navigator.onLine), false)
    const offlineRequestFailed = await allowingPhone.evaluate(async () => {
      try {
        await fetch('/api/session/list', { cache: 'no-store' })
        return false
      } catch {
        return true
      }
    })
    check('the pending-approval phone cannot reach the Host while offline',
      offlineRequestFailed, true)
    awaitingReconnectStream = true
    await phone.setOffline(false)
    const reconnectDeadline = Date.now() + 15_000
    while (approvalRecoveredFrames === 0 && Date.now() < reconnectDeadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    check('the reconnected phone receives a frame on a newly opened Host WebSocket',
      approvalRecoveredFrames > 0, true)
    await allowingCard.waitFor({ state: 'visible', timeout: 20_000 })
    check('the reconnected phone still shows the pending plugin_manager approval',
      (await allowingCard.innerText()).includes('plugin_manager'), true)
    check('the reconnected phone still offers only a one-shot approval',
      await allowingCard.getByRole('button', { name: 'Allow once', exact: true }).isVisible(), true)
    check('network restoration does not repeat the model tool request',
      callsForPendingTask(), pendingTaskCallsBeforeDrop)
    check('reconnecting never silently approves the pending Host tool',
      priorToolResults(), 0)

    await allowingCard.getByRole('button', { name: 'Allow once', exact: true }).tap()
    const allowedReply = allowingPhone.locator('[data-chat-flow]')
      .getByText(APPROVAL_ALLOWED_REPLY, { exact: true }).first()
    await allowedReply.waitFor({ state: 'visible', timeout: 30_000 })
    const successfulCalls = modelFixture.requests.filter(call => call.messages?.some(message =>
      message.role === 'tool' && message.tool_call_id === APPROVAL_ALLOW_CALL_ID))
    // One provider call may carry several messages with the same call ID.
    // Count actual tool messages, not just requests, or a valid list followed
    // by a hidden denial would be incorrectly accepted as an approved run.
    const correlatedResults = successfulCalls.flatMap(call => call.messages?.filter(message =>
      message.role === 'tool' && message.tool_call_id === APPROVAL_ALLOW_CALL_ID) ?? [])
    const allowedToolResult = correlatedResults.length === 1 ? correlatedResults[0] : undefined
    check('allow-once resumes the Agent in exactly one provider continuation',
      successfulCalls.length, 1)
    check('that continuation contains exactly one correlated Host tool message',
      correlatedResults.length, 1)
    check('the model received the Host plugin list, not a denial or an unrelated tool response',
      hasPluginListEntries(allowedToolResult?.content), true)
    check('the phone displays the Agent continuation after the real tool result',
      await allowedReply.isVisible(), true)
    check('approving the Agent tool does not grant access to phone settings',
      pageRefused(await apiAnswer(allowingPhone, '/api/settings/describe')), true)
    await allowingPhone.close()
    await phone.close()

    // ---- neither the old launch token nor a forged one can pair ----
    const hostile = await browser.newContext({ ignoreHTTPSErrors: true })
    const hostilePage = await hostile.newPage()
    const expired = await hostilePage.goto(pairingLink, { waitUntil: 'domcontentloaded' })
    check('the previous process\'s pairing link is invalid after restart', expired?.status(), 401)
    const forged = await hostilePage.goto(`${origin}/?token=${'A'.repeat(43)}`, { waitUntil: 'domcontentloaded' })
    check('a link carrying the wrong token is refused', forged?.status(), 401)
    check('and leaves no session behind', (await hostile.cookies(origin)).some(cookie => cookie.name.startsWith('dsh-auth-')), false)

    // Even if an unpaired device learns a real Session ID, it must neither
    // execute a task nor read that Session's history. Use fully shaped RPCs:
    // a malformed request rejected by the Host is NOT proof of LAN gating.
    // The expected 403 carries this plugin's own refusal marker, not the
    // upstream error body, so the assertion fails if the gate is bypassed.
    const hostileRpcs = await hostilePage.evaluate(async (sessionId: string) => {
      const rpc = async (method: string, request: Record<string, unknown>) => {
        const response = await fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: `unpaired-${method}`,
            method,
            payload: { args: { request } },
          }),
        })
        return { status: response.status, body: await response.text() }
      }
      const prompt = await rpc('session/prompt', {
        sessionId,
        requestId: 'unpaired-should-never-reach-host',
        mode: 'queue',
        content: [{ type: 'text', text: 'This unpaired LAN device must not queue a task.' }],
      })
      const history = await rpc('session/page', {
        address: { kind: 'session', sessionId },
        throughSeq: 1_000_000,
        maxMessages: 50,
      })
      return { prompt, history }
    }, submittedSessionId)
    check('an unpaired phone cannot submit a task to a known real Session',
      pageRefused(hostileRpcs.prompt), true)
    check('an unpaired phone cannot read a known real Session history',
      pageRefused(hostileRpcs.history), true)
    await hostile.close()
  } finally {
    await browser.close()
  }
  }, {
    // Per-process CLI overlay: the shipped plugin and LAN admission rules are
    // unmodified. No external model key or real model traffic is used.
    overlay: [
      // The shipped standard preset disables plugin_manager. Select the
      // shipped cordis preset so this test can reach its real approval path.
      '- id: agent-preset-registry',
      '  config:',
      '    default: cordis',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      `      ${MODEL_ROUTE}:`,
      '        api: openai-completions',
      `        baseURL: ${modelFixture.url}/v1`,
      '        apiKeyEnv: LANYARD_E2E_MODEL_KEY',
      '        models:',
      `          - id: ${MODEL_ID}`,
      '            contextWindow: 32768',
      '            maxTokens: 1024',
      '- id: agent-default-model',
      '  config:',
      `    provider: ${MODEL_ROUTE}`,
      `    model: ${MODEL_ID}`,
      '',
    ].join('\n'),
    env: {
      LANYARD_E2E_MODEL_KEY: 'local-fixture-not-a-secret',
      // Pin the throwaway Host's standing policy even if CI exports another.
      DSH_PERMISSION_MODE: 'workspace-write',
    },
  })
} finally {
  await modelFixture.close()
}

report('lanyard browser e2e')
