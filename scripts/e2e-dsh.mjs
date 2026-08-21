/**
 * End-to-end verification against a real `dsh` install.
 *
 * The unit suite proves the gate's decisions in isolation; this proves the
 * plugin is actually a plugin — that `dsh plugin add` recognises the bundle,
 * that the patch really does take the seats it disables, and that a paired
 * device on the LAN reaches exactly what it should over real TLS.
 *
 * It installs the PUBLISHED CLI and the PACKED plugin into a throwaway
 * DSH_HOME. That is deliberate: a source checkout of the harness would test a
 * composition no user runs, and testing against the published packages is what
 * caught a shipped flag going missing.
 *
 * Usage:  node scripts/e2e-dsh.mjs            (installs the CLI itself)
 *         DSH_E2E_VERSION=0.1.1-rc.1 node scripts/e2e-dsh.mjs
 *         DSH_E2E_KEEP=1 node scripts/e2e-dsh.mjs   (keep the workspace)
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:https'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI_VERSION = process.env.DSH_E2E_VERSION ?? '0.1.1-rc.1'
const TOKEN = 'e2e-token_0123456789-abcdef'
const BOOT_TIMEOUT_MS = 180_000

const results = []
/** Record one assertion. */
function check(what, actual, expected) {
  const ok = actual === expected
  results.push({ what, actual, expected, ok })
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}  →  ${actual}${ok ? '' : `  (expected ${expected})`}`)
}

/** Run a command to completion, failing loudly. */
function run(command, args, options = {}) {
  const done = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(done.status)})\n${done.stdout ?? ''}\n${done.stderr ?? ''}`)
  }
  return `${done.stdout ?? ''}${done.stderr ?? ''}`
}

/** The machine's first non-internal IPv4 literal, or undefined. */
function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address
  }
  return undefined
}

/** A port free right now. `listen` is asynchronous, so the address is only readable once bound. */
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => { resolve(port) })
    })
  })
}

/**
 * One HTTPS request against the deployment, accepting its self-signed cert.
 * @returns `<body>|<status>` so a gate refusal ("forbidden|403") is
 * distinguishable from the app answering after admission ("not found|404").
 */
function probe(host, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const rq = request({ host, port, path, method: 'GET', headers, rejectUnauthorized: false, timeout: 15_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode, body }) })
    })
    rq.on('timeout', () => { rq.destroy(new Error('timed out')) })
    rq.on('error', reject)
    rq.end()
  })
}

/**
 * Whether THIS GATE refused. `dsh-client-connection`'s own Host fence also
 * answers 403 with the body `forbidden`, so the status alone — and the bare
 * body — cannot tell admission from the fence behind it. The gate's refusal
 * carries its own marker (`REFUSAL_BODY`) precisely so this can.
 */
const refused = answer => answer.status === 403 && answer.body === 'lanyard: forbidden'
/** Whether the request passed the gate and reached whatever owns the route. */
const admitted = answer => !refused(answer)

const lan = lanAddress()
if (lan === undefined) {
  console.error('lanyard e2e: this host has no non-loopback IPv4 address, so the LAN half cannot be exercised.')
  console.error('lanyard e2e: SKIPPED (not passed) — run it somewhere with a LAN interface.')
  process.exit(2)
}

const workspace = mkdtempSync(join(tmpdir(), 'lanyard-e2e-'))
const home = join(workspace, 'home')
let server
try {
  console.log(`lanyard e2e: workspace ${workspace}`)

  console.log('lanyard e2e: packing the plugin as a publishable tarball')
  run('pnpm', ['pack', '--pack-destination', workspace], { cwd: root })
  const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const tarball = join(workspace, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)

  console.log(`lanyard e2e: installing the published CLI @deepseek-ai/dsh@${CLI_VERSION}`)
  writeFileSync(join(workspace, 'package.json'), '{"name":"lanyard-e2e","private":true}\n')
  run('pnpm', ['add', `@deepseek-ai/dsh@${CLI_VERSION}`], { cwd: workspace })
  const dsh = join(workspace, 'node_modules', '.bin', 'dsh')
  const env = { ...process.env, DSH_HOME: home, DSH_E2E_TOKEN: TOKEN }

  console.log('lanyard e2e: dsh plugin add')
  run(dsh, ['plugin', '--profile', 'web', 'add', tarball], { cwd: workspace, env })
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  check('the bundle joined the profile layer stack',
    manifest.dsh?.profile?.bundles?.includes(name) === true, true)

  // The startup row replacement is visible before anything binds: the shipped
  // provider refuses --host 0.0.0.0 and has no pairing flag at all.
  const help = run(dsh, ['--profile', 'web', '--help'], { cwd: workspace, env })
  check('the replacement provider owns the command line', help.includes('--pairing-token-env'), true)
  check('and still offers the shipped flags it replaced', help.includes('--no-open') && help.includes('--trusted-host'), true)

  const port = await freePort()
  console.log(`lanyard e2e: booting dsh on 0.0.0.0:${String(port)} (this takes a while)`)
  server = spawn(dsh, [
    '--profile', 'web', '--host', '0.0.0.0', '--port', String(port),
    '--no-open', '--pairing-token-env', 'DSH_E2E_TOKEN',
  ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  const pairingLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`no pairing line within ${String(BOOT_TIMEOUT_MS)}ms:\n${output}`)) }, BOOT_TIMEOUT_MS)
    const read = (chunk) => {
      output += String(chunk)
      const match = /lanyard: pair a device by opening (\S+) once/.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1])
    }
    server.stdout.on('data', read)
    server.stderr.on('data', read)
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`dsh exited (${String(code)}) before serving:\n${output}`)) })
  })

  check('the pairing link names the LAN address, the TLS scheme, and the token',
    pairingLine, `https://${lan}:${String(port)}/#auth=${TOKEN}`)

  console.log('lanyard e2e: exercising the gate from the LAN address over real TLS')
  const paired = { Cookie: `dsh_auth=${TOKEN}` }

  check('an anonymous LAN peer is refused',
    refused(await probe(lan, port, '/api/session.list')), true)
  check('a LAN peer with the wrong token is refused',
    refused(await probe(lan, port, '/api/session.list', { Cookie: 'dsh_auth=wrong-token-0123456789' })), true)
  check('a paired LAN peer reaches the api',
    admitted(await probe(lan, port, '/api/session.list', paired)), true)
  check('a Bearer token is accepted too',
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
} finally {
  server?.kill('SIGTERM')
  if (process.env.DSH_E2E_KEEP === undefined) rmSync(workspace, { recursive: true, force: true })
  else console.log(`lanyard e2e: kept ${workspace}`)
}

const failed = results.filter(result => !result.ok)
console.log(`\nlanyard e2e: ${String(results.length - failed.length)}/${String(results.length)} checks passed`)
if (failed.length > 0) process.exit(1)
