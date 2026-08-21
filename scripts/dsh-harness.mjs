/**
 * A throwaway `dsh` deployment with this plugin installed, for the end-to-end
 * suites to drive.
 *
 * It installs the PUBLISHED CLI and the PACKED plugin into a temporary
 * DSH_HOME. That is deliberate: a source checkout of the harness would compose
 * something no user runs, and testing against the published packages is what
 * caught a shipped flag going missing.
 * @module
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:https'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CLI_VERSION = process.env.DSH_E2E_VERSION ?? '0.1.1-rc.1'
export const TOKEN = 'e2e-token_0123456789-abcdef'

const BOOT_TIMEOUT_MS = 180_000

/** Run a command to completion, failing loudly. */
export function run(command, args, options = {}) {
  const done = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(done.status)})\n${done.stdout ?? ''}\n${done.stderr ?? ''}`)
  }
  return `${done.stdout ?? ''}${done.stderr ?? ''}`
}

/** The machine's first non-internal IPv4 literal, or undefined. */
export function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address
  }
  return undefined
}

/** A port free right now. `listen` is asynchronous, so the address is only readable once bound. */
export function freePort() {
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
 * @returns the status and body, so the caller can tell a gate refusal from the
 * app answering after admission.
 */
export function probe(host, port, path, headers = {}) {
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
 * answers 403 with the body `forbidden`, so status alone cannot tell admission
 * from the fence behind it; the gate's refusal carries its own marker.
 */
export const refused = answer => answer.status === 403 && answer.body === 'lanyard: forbidden'

/** Whether the request passed the gate and reached whatever owns the route. */
export const admitted = answer => !refused(answer)

/**
 * Stand up a deployment, hand it to `body`, and always tear it down.
 * @param body - receives the live deployment facts.
 * @returns whatever `body` returned.
 */
export async function withDshDeployment(body) {
  const workspace = mkdtempSync(join(tmpdir(), 'lanyard-e2e-'))
  const home = join(workspace, 'home')
  let server
  try {
    console.log(`lanyard e2e: workspace ${workspace}`)
    console.log('lanyard e2e: packing the plugin as a publishable tarball')
    run('pnpm', ['pack', '--pack-destination', workspace], { cwd: ROOT })
    const { name, version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const tarball = join(workspace, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)

    console.log(`lanyard e2e: installing the published CLI @deepseek-ai/dsh@${CLI_VERSION}`)
    writeFileSync(join(workspace, 'package.json'), '{"name":"lanyard-e2e","private":true}\n')
    run('pnpm', ['add', `@deepseek-ai/dsh@${CLI_VERSION}`], { cwd: workspace })
    const dsh = join(workspace, 'node_modules', '.bin', 'dsh')
    const env = { ...process.env, DSH_HOME: home, DSH_E2E_TOKEN: TOKEN }

    console.log('lanyard e2e: dsh plugin add')
    run(dsh, ['plugin', '--profile', 'web', 'add', tarball], { cwd: workspace, env })
    const profile = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))

    const port = await freePort()
    console.log(`lanyard e2e: booting dsh on 0.0.0.0:${String(port)}`)
    server = spawn(dsh, [
      '--profile', 'web', '--host', '0.0.0.0', '--port', String(port),
      '--no-open', '--pairing-token-env', 'DSH_E2E_TOKEN',
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })

    let output = ''
    const pairingLink = await new Promise((resolve, reject) => {
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

    return await body({
      dsh, env, cwd: workspace, port, pairingLink, packageName: name,
      bundles: profile.dsh?.profile?.bundles ?? [],
    })
  } finally {
    server?.kill('SIGTERM')
    if (process.env.DSH_E2E_KEEP === undefined) rmSync(workspace, { recursive: true, force: true })
    else console.log(`lanyard e2e: kept ${workspace}`)
  }
}

/** A tiny assertion recorder shared by the suites. */
export function recorder() {
  const results = []
  return {
    check(what, actual, expected) {
      const ok = actual === expected
      results.push({ what, ok })
      console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}  →  ${actual}${ok ? '' : `  (expected ${expected})`}`)
    },
    report(label) {
      const failed = results.filter(result => !result.ok)
      console.log(`\n${label}: ${String(results.length - failed.length)}/${String(results.length)} checks passed`)
      if (failed.length > 0) process.exitCode = 1
    },
  }
}

/** Refuse to pass vacuously on a host with no LAN interface. */
export function requireLan() {
  const lan = lanAddress()
  if (lan !== undefined) return lan
  console.error('lanyard e2e: this host has no non-loopback IPv4 address, so the LAN half cannot be exercised.')
  console.error('lanyard e2e: SKIPPED (not passed) — run it somewhere with a LAN interface.')
  process.exit(2)
}
