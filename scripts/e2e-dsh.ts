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
import { connect as tlsConnect } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT, plainGet, probe as probeUnbound, recorder, refused, requireLan, rpcCall, run, sessionCookie, sessionCookieSecure,
  succeeded, upgradeHeaders, withDshDeployment,
} from './dsh-harness.ts'
import type { Answer, ProbeInit } from './dsh-harness.ts'

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

/**
 * SHA-256 fingerprint of the certificate a TLS listener actually presents —
 * what a phone shows in the certificate details it is asked to accept.
 */
function presentedFingerprint(host: string, port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, ca }, () => {
      const { fingerprint256 } = socket.getPeerCertificate()
      socket.destroy()
      resolve(fingerprint256)
    })
    socket.on('error', reject)
  })
}

/** A localized title or description as dsh's Plugins page receives it. */
type Localized = string | Record<string, string>

/** The fields of one `pluginManager/listBundles` entry this suite reads. */
interface ListedBundle {
  name: string
  meta?: { title?: Localized; description?: Localized; icon?: string; error?: string }
  rows?: { rowId: string; meta?: { title?: Localized; error?: string } }[]
}

/** The bundle's own locale file, as this checkout ships it. */
function localeFile(language: string): { meta: { title: string; description: string } } {
  return JSON.parse(readFileSync(join(ROOT, 'locale', `${language}.json`), 'utf8')) as { meta: { title: string; description: string } }
}

/** One language of a localized field; a plain string is the same in every language. */
function inLanguage(value: Localized | undefined, language: string): string | undefined {
  return typeof value === 'string' ? value : value?.[language]
}

/** The bundles a `pluginManager/listBundles` answer lists, or undefined when it did not succeed. */
function listedBundles(answer: Answer): ListedBundle[] | undefined {
  if (!succeeded(answer)) return undefined
  return (JSON.parse(answer.body) as { result: { value: ListedBundle[] } }).result.value
}

await withDshDeployment(async ({ dsh, env, cwd, port, localPort, pairingLink, fingerprint, localUrl, packageName, bundles, ca }) => {
  // Bound to this deployment's certificate once, rather than threaded through
  // every call: passing it per site is the shape where one gets missed, and a
  // missed one would silently be the only probe trusting any certificate.
  const probe = (host: string, path: string, init: ProbeInit = {}): ReturnType<typeof probeUnbound> =>
    probeUnbound(host, port, path, init, ca)
  const origin = `https://${lan}:${String(port)}`

  check('the bundle joined the profile layer stack', bundles.includes(packageName), true)

  // The startup row replacement is visible before anything binds: the shipped
  // provider refuses --host 0.0.0.0 and has no --keep-awake at all.
  // Commander wraps at the terminal width, so a phrase may span lines.
  const help = run(dsh, ['--profile', 'web', '--help'], { cwd, env }).replace(/\s+/g, ' ')
  check('the replacement provider owns the command line',
    help.includes('--network-port') && help.includes('0.0.0.0 also serves your network over TLS'), true)
  check('and still offers the shipped flags it replaced', help.includes('--no-open') && help.includes('--trusted-host'), true)

  check('the pairing link names the LAN address, the TLS port, and upstream\'s launch token',
    new RegExp(`^${origin.replaceAll('.', '\\.')}/\\?token=[A-Za-z0-9_-]{43}$`).test(pairingLink), true)
  // The one check a self-signed certificate offers is a person comparing this
  // line with what the phone shows, so it has to name what the phone is shown.
  check('the fingerprint the pairing line prints is the certificate the network listener presents',
    fingerprint, await presentedFingerprint(lan, port, ca))
  check('which is the certificate the tls row wrote', fingerprint, new X509Certificate(ca).fingerprint256)

  console.log('lanyard e2e: exercising the gate from the LAN address over real TLS')

  // ---- a device that has never paired
  check('an anonymous LAN peer is refused at the gate',
    refused(await probe(lan, '/api/session/list', rpcCall('session/list', { _request: {} }))), true)
  check('so is its stream WebSocket',
    refused(await probe(lan, '/api/remote.mux', { headers: upgradeHeaders() })), true)
  check('and the client bundles, which only a loaded page ever needs',
    refused(await probe(lan, '/plugins/')), true)
  // The real dsh-host-frontend-static sits behind this seat, and its
  // path.resolve opens `index.js.map/` as the map itself.
  for (const path of ['/assets/index.js.map', '/assets/index.js.map/', '/assets/index.js.MAP']) {
    check(`a source map is refused anonymously, spelled ${path}`, refused(await probe(lan, path)), true)
  }
  const cold = await probe(lan, '/')
  check('the index answers a peer with no session with upstream\'s own refusal, not the GUI',
    cold.status === 401 && !refused(cold), true)

  // ---- opening the pairing link once
  const exchange = await probe(lan, target(pairingLink))
  const cookie = sessionCookie(exchange)
  check('opening the pairing link sets upstream\'s session cookie', exchange.status === 303 && cookie !== undefined, true)
  check('and redirects to the bare origin, taking the token out of the address bar',
    new URL(String(exchange.headers.location), pairingLink).href, `${origin}/`)
  // Upstream mints it without `Secure`; unmarked, it would ride any later
  // http:// request the phone made to this machine's address.
  check('the session cookie is marked Secure, so it only ever travels inside TLS', sessionCookieSecure(exchange), true)
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
  // Exact routes beside the Gateway, decided by name: the openers are pinned
  // like their Gateway twin, and a read the session views make gets through.
  for (const route of ['present.open', 'changes.open']) {
    check(`so is opening a file with this machine's applications through /api/${route}`,
      refused(await probe(lan, `/api/${route}`, { method: 'POST', headers: paired })), true)
  }
  const host = await probe(lan, '/api/present.host', { headers: paired })
  check('while an exact route the session views read answers a paired device',
    host.status === 200 && (host.headers['content-type'] ?? '').startsWith('application/json'), true)
  check('the uncapped dev reload channel is refused for a paired device',
    refused(await probe(lan, '/plugins/events', { headers: paired })), true)
  const forged = (cookie ?? '').replace(/.$/, last => (last === 'A' ? 'B' : 'A'))
  check('a session cookie this deployment did not sign is refused',
    refused(await probe(lan, '/api/session/list', withHeaders(rpcCall('session/list', { _request: {} }), { cookie: forged }))), true)

  // ---- at the machine
  // Upstream's own line names the inherited plaintext listener. It has to stay
  // loopback http on the port asked for — the one stock dsh would bind — or the
  // browser handoff lands on an error page and a bookmark dies on restart.
  const local = new URL(localUrl)
  check('the local URL dsh web prints is plain http on this machine, on the port stock dsh would use',
    `${local.protocol}//${local.hostname}:${local.port}`, `http://127.0.0.1:${String(localPort)}`)
  const localExchange = await plainGet(localUrl)
  check('and opens the GUI on this machine', localExchange.status, 303)
  // A browser drops a Secure cookie set over http, which would sign the local
  // tab out; the mark belongs to the network listener alone.
  check('with a session cookie left unmarked, as a plaintext loopback tab needs', sessionCookieSecure(localExchange), false)
  // What the dsh web line calls its LAN address pairs the network address with
  // the loopback port, and its link carries the launch token. Nothing may
  // answer there: a phone opening it gets a refused connection, and a passive
  // listener sees no token. (Someone impersonating this machine could still
  // answer, which is why the pairing line says not to open it.)
  const lanLine = await plainGet(`http://${lan}:${String(localPort)}/`).then(() => 'answered', () => 'refused')
  check('nothing answers the dsh web line\'s plaintext LAN address, so no request carrying its token completes', lanLine, 'refused')
  const loopbackExchange = await probe('127.0.0.1', target(pairingLink))
  const loopback: OutgoingHttpHeaders = { cookie: sessionCookie(loopbackExchange) ?? '' }
  check('the loopback peer reaches the configuration plane',
    succeeded(await probe('127.0.0.1', '/api/settings/describe', withHeaders(rpcCall('settings/describe'), loopback))), true)

  // ---- what the Plugins page shows, where this dsh has one
  const listing = await probe('127.0.0.1', '/api/pluginManager/listBundles', withHeaders(rpcCall('pluginManager/listBundles'), loopback))
  if (listing.status === 404) {
    console.log('  n/a  this dsh serves no pluginManager/listBundles, so it has no Plugins page to show the bundle on')
  } else {
    const ours = listedBundles(listing)?.find(bundle => bundle.name === packageName)
    check('the Plugins page lists the bundle', ours !== undefined, true)
    for (const language of ['en', 'zh']) {
      const { meta } = localeFile(language)
      check(`under its own title and description in ${language}`,
        inLanguage(ours?.meta?.title, language) === meta.title && inLanguage(ours?.meta?.description, language) === meta.description, true)
    }
    check('with its icon, and no metadata diagnostic',
      (ours?.meta?.icon ?? '').startsWith('data:image/svg+xml;base64,') && ours?.meta?.error === undefined, true)
    const untitled = (ours?.rows ?? []).filter(row => inLanguage(row.meta?.title, 'zh') === undefined || row.meta?.error !== undefined)
    check('and a title of its own for every row it inserts',
      (ours?.rows ?? []).length > 0 && untitled.length === 0 ? 'all titled' : untitled.map(row => row.rowId).join(', ') || 'no rows', 'all titled')
  }
})

report('lanyard e2e')
