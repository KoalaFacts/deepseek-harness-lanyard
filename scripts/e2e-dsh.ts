/**
 * End-to-end verification against a real `dsh` install: the plugin is actually
 * a plugin, the patch really takes the seats it disables, and a paired device
 * on the LAN reaches exactly what it should over real TLS.
 *
 * Usage:  node scripts/e2e-dsh.ts
 *         DSH_E2E_VERSION=0.1.1-rc.1 node scripts/e2e-dsh.ts
 *         DSH_E2E_KEEP=1 node scripts/e2e-dsh.ts   (keep the workspace)
 */

import {
  TOKEN, admitted, probe, recorder, refused, requireLan, run, withDshDeployment,
} from './dsh-harness.ts'

const lan = requireLan()
const { check, report } = recorder()

await withDshDeployment(async ({ dsh, env, cwd, port, pairingLink, packageName, bundles }) => {
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
})

report('lanyard e2e')
