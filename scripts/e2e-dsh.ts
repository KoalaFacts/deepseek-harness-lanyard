/**
 * End-to-end verification against a real `dsh` install: the plugin is actually
 * a plugin, the patch really takes the seats it disables, and a paired device
 * on the LAN reaches exactly what it should over real TLS.
 *
 * Every claim that something *works* is checked as success — a 200 carrying a
 * result, a 101 — never as "the gate did not refuse". Upstream refuses on its
 * own now, so a request can pass this gate and still reach nothing; an earlier
 * version of this suite passed a paired device that could not reach anything.
 *
 * Usage:  node scripts/e2e-dsh.ts
 *         DSH_E2E_VERSION=next node scripts/e2e-dsh.ts
 *         DSH_E2E_KEEP=1 node scripts/e2e-dsh.ts   (keep the workspace)
 */

import type { OutgoingHttpHeaders } from 'node:http'
import {
  plainGet, probe as probeUnbound, recorder, refused, requireLan, rpcCall, run, sessionCookie, succeeded,
  upgradeHeaders, withDshDeployment,
} from './dsh-harness.ts'
import type { ProbeInit } from './dsh-harness.ts'

const lan = requireLan()
const { check, report } = recorder()

/**
 * A built asset the served index actually references, so the check probes a
 * real file under the fallback seat rather than a path this script invented.
 * The build references its assets relatively (`./assets/…`), so each one is
 * resolved against the document it appears in, the way a browser would.
 * @param html - the index document as served.
 * @param documentUrl - where that document was served from.
 */
function assetPath(html: string, documentUrl: string): string | undefined {
  const reference = /(?:src|href)=["']((?:\.\/|\/)?assets\/[^"']+)["']/.exec(html)?.[1]
  return reference === undefined ? undefined : new URL(reference, documentUrl).pathname
}

/** Path and query of a link, as a device requests it. */
function target(link: string): string {
  const url = new URL(link)
  return `${url.pathname}${url.search}`
}

/** `init` with one more header. */
function withHeaders(init: ProbeInit, headers: OutgoingHttpHeaders): ProbeInit {
  return { ...init, headers: { ...init.headers, ...headers } }
}

await withDshDeployment(async ({ dsh, env, cwd, port, pairingLink, localUrl, packageName, bundles, ca }) => {
  // Bound to this deployment's certificate once, rather than threaded through
  // every call: passing it per site is the shape where one gets missed, and a
  // missed one would silently be the only probe trusting any certificate.
  const probe = (host: string, path: string, init: ProbeInit = {}): ReturnType<typeof probeUnbound> =>
    probeUnbound(host, port, path, init, ca)
  const origin = `https://${lan}:${String(port)}`

  check('the bundle joined the profile layer stack', bundles.includes(packageName), true)

  // The startup row replacement is visible before anything binds: the shipped
  // provider refuses --host 0.0.0.0 and has no --keep-awake at all.
  const help = run(dsh, ['--profile', 'web', '--help'], { cwd, env })
  check('the replacement provider owns the command line', help.includes('--keep-awake') && help.includes('serves your network over TLS'), true)
  check('and still offers the shipped flags it replaced', help.includes('--no-open') && help.includes('--trusted-host'), true)

  check('the pairing link names the LAN address, the TLS port, and upstream\'s launch token',
    new RegExp(`^${origin.replaceAll('.', '\\.')}/\\?token=[A-Za-z0-9_-]{43}$`).test(pairingLink), true)

  console.log('lanyard e2e: exercising the gate from the LAN address over real TLS')

  // ---- a device that has never paired
  check('an anonymous LAN peer is refused at the gate',
    refused(await probe(lan, '/api/session/list', rpcCall('session/list', { _request: {} }))), true)
  check('so is its stream WebSocket',
    refused(await probe(lan, '/api/remote.mux', { headers: upgradeHeaders() })), true)
  check('and the client bundles, which only a loaded page ever needs',
    refused(await probe(lan, '/plugins/')), true)
  check('a source map is refused anonymously',
    refused(await probe(lan, '/assets/index.js.map')), true)
  const cold = await probe(lan, '/')
  check('the index answers a peer with no session with upstream\'s own refusal, not the GUI',
    cold.status === 401 && !refused(cold), true)

  // ---- opening the pairing link once
  const exchange = await probe(lan, target(pairingLink))
  const cookie = sessionCookie(exchange)
  check('opening the pairing link sets upstream\'s session cookie', exchange.status === 303 && cookie !== undefined, true)
  check('and redirects to the bare origin, taking the token out of the address bar',
    new URL(String(exchange.headers.location), pairingLink).href, `${origin}/`)
  const paired: OutgoingHttpHeaders = { cookie: cookie ?? '' }

  // ---- what the paired device reaches
  const index = await probe(lan, '/', { headers: paired })
  check('the shell loads for the paired device', index.status === 200 && index.body.includes('<script'), true)
  const asset = assetPath(index.body, `${origin}/`)
  const served = asset === undefined ? undefined : await probe(lan, asset, { headers: paired })
  check('and so do its own assets', served !== undefined && served.status === 200 && served.body.length > 0, true)
  check('a paired LAN device reaches the session plane',
    succeeded(await probe(lan, '/api/session/list', withHeaders(rpcCall('session/list', { _request: {} }), paired))), true)
  check('and opens the stream WebSocket the shell follows sessions over',
    (await probe(lan, '/api/remote.mux', { headers: { ...upgradeHeaders(), ...paired } })).status, 101)
  check('the configuration plane stays at the machine, even for a paired device',
    refused(await probe(lan, '/api/settings/describe', withHeaders(rpcCall('settings/describe'), paired))), true)
  check('an unclassified Gateway namespace is refused for a paired device',
    refused(await probe(lan, '/api/dynamicCordisRunner/invoke', withHeaders(rpcCall('dynamicCordisRunner/invoke'), paired))), true)
  check('acting on this machine\'s desktop is refused for a paired device',
    refused(await probe(lan, '/api/session/openWorkspacePath', withHeaders(rpcCall('session/openWorkspacePath'), paired))), true)
  check('the uncapped dev reload channel is refused for a paired device',
    refused(await probe(lan, '/plugins/events', { headers: paired })), true)
  const forged = (cookie ?? '').replace(/.$/, last => (last === 'A' ? 'B' : 'A'))
  check('a session cookie this deployment did not sign is refused',
    refused(await probe(lan, '/api/session/list', withHeaders(rpcCall('session/list', { _request: {} }), { cookie: forged }))), true)

  // ---- at the machine
  // Upstream's own line names the inherited plaintext listener; under TLS that
  // has to stay loopback http, or the browser handoff lands on an error page.
  const local = new URL(localUrl)
  check('the local URL dsh web prints is loopback plain http, on a port other than the network one',
    local.protocol === 'http:' && local.hostname === '127.0.0.1' && Number(local.port) !== port, true)
  check('and opens the GUI on this machine', (await plainGet(localUrl)).status, 303)
  const loopbackExchange = await probe('127.0.0.1', target(pairingLink))
  const loopback: OutgoingHttpHeaders = { cookie: sessionCookie(loopbackExchange) ?? '' }
  check('the loopback peer reaches the configuration plane',
    succeeded(await probe('127.0.0.1', '/api/settings/describe', withHeaders(rpcCall('settings/describe'), loopback))), true)
})

report('lanyard e2e')
