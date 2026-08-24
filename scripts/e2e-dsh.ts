/**
 * End-to-end verification against a real `dsh` install: the plugin is actually
 * a plugin, the patch really takes the seats it disables, and a paired device
 * on the LAN reaches exactly what it should over real TLS.
 *
 * Usage:  node scripts/e2e-dsh.ts
 *         DSH_E2E_VERSION=0.1.1-rc.1 node scripts/e2e-dsh.ts
 *         DSH_E2E_KEEP=1 node scripts/e2e-dsh.ts   (keep the workspace)
 */

import type { OutgoingHttpHeaders } from 'node:http'
import {
  TOKEN, admitted, probe as probeUnbound, recorder, refused, requireLan, run, withDshDeployment,
} from './dsh-harness.ts'

const lan = requireLan()
const { check, report } = recorder()

/**
 * A built asset the served index actually references, so the check probes a
 * real file under the fallback seat rather than a path this script invented.
 * @param html - the index document as served.
 */
function assetPath(html: string): string | undefined {
  return /["'](\/assets\/[^"']+)["']/.exec(html)?.[1]
}

await withDshDeployment(async ({ dsh, env, cwd, port, pairingLink, packageName, bundles, ca }) => {
  // Bound to this deployment's certificate once, rather than threaded through
  // every call: passing it per site is the shape where one gets missed, and a
  // missed one would silently be the only probe trusting any certificate.
  const probe = (host: string, port: number, path: string, headers: OutgoingHttpHeaders = {}): ReturnType<typeof probeUnbound> =>
    probeUnbound(host, port, path, headers, ca)

  check('the bundle joined the profile layer stack', bundles.includes(packageName), true)

  // The startup row replacement is visible before anything binds: the shipped
  // provider refuses --host 0.0.0.0 and has no pairing flag at all.
  const help = run(dsh, ['--profile', 'web', '--help'], { cwd, env })
  check('the replacement provider owns the command line', help.includes('--pairing-token-env'), true)
  check('and still offers the shipped flags it replaced', help.includes('--no-open') && help.includes('--trusted-host'), true)

  check('the pairing link names the LAN address, the TLS scheme, and the token',
    pairingLink, `https://${lan}:${String(port)}/#auth=${TOKEN}`)

  console.log('lanyard e2e: exercising the gate from the LAN address over real TLS')
  const paired = { Cookie: `dsh_auth=${TOKEN}` }

  check('an anonymous LAN peer is refused',
    refused(await probe(lan, port, '/api/session.list')), true)
  check('a LAN peer with the wrong token is refused',
    refused(await probe(lan, port, '/api/session.list', { Cookie: 'dsh_auth=wrong-token-0123456789' })), true)
  check('a paired LAN peer reaches the api',
    admitted(await probe(lan, port, '/api/session.list', paired)), true)
  check('an Authorization header is accepted too',
    admitted(await probe(lan, port, '/api/session.list', { Authorization: `Bearer ${TOKEN}` })), true)
  check('the configuration plane stays at the machine, even for a paired device',
    refused(await probe(lan, port, '/api/settings.update', paired)), true)
  check('an unclassified Gateway namespace is refused for a paired device',
    refused(await probe(lan, port, '/api/dynamicCordisRunner/invoke', paired)), true)
  check('the uncapped dev reload channel is refused for a paired device',
    refused(await probe(lan, port, '/plugins/events', paired)), true)
  check('a source map is refused anonymously',
    refused(await probe(lan, port, '/plugins/ui-theme/client.js.map')), true)
  check('the loopback peer reaches the configuration plane',
    admitted(await probe('127.0.0.1', port, '/api/settings.update')), true)

  const index = await probe(lan, port, '/')
  check('the shell loads for an anonymous LAN peer', admitted(index), true)
  check('and carries the pairing bootstrap, so the link can adopt the token',
    index.body.includes('dsh.pairingToken') && index.body.includes('dsh_auth'), true)

  // The fallback seat — dsh-host-frontend-static serving the built SPA — is a
  // third registration path, and wrapping only register/registerUpgrade left it
  // ungated. These two checks are what that omission needed: the first shows the
  // gate is now in front of the seat at all, and the second shows it still lets
  // a freshly paired device load the shell it was sent to.
  check('the gate is in front of the fallback seat, not just the named routes',
    refused(await probe(lan, port, '/assets/index.js.map')), true)
  const asset = assetPath(index.body)
  // `admitted` only means the gate did not refuse, so a 404 satisfies it — this
  // has to assert the asset actually arrived, which is the thing pairing needs.
  const served = asset === undefined ? undefined : await probe(lan, port, asset)
  check('and the shell\'s own assets still load for an anonymous LAN peer, so pairing resolves',
    served !== undefined && served.status === 200 && served.body.length > 0, true)
})

report('lanyard e2e')
