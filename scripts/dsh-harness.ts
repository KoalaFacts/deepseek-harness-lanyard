/**
 * A throwaway `dsh` deployment with this plugin installed, for the end-to-end
 * suites to drive.
 *
 * It installs the PUBLISHED CLI and the PACKED plugin into a temporary
 * DSH_HOME. That is deliberate: a source checkout of the harness would compose
 * something no user runs, and testing against the published packages is what
 * caught a shipped flag going missing.
 *
 * Run directly with `node scripts/…​.ts` — Node strips the types itself, so the
 * suites need no build step and no runner dependency.
 * @module
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:https'
import { request as plainRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { REFUSAL_BODY } from '../src/webserver.ts'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Which `dsh` to test against.
 *
 * Nothing is pinned. A plugin that only works against one frozen release is
 * not working, and a pinned suite proves nothing about the install a person
 * actually performs — it also cannot be pinned honestly, because `dsh` floats
 * its own dependencies through `^` ranges, so pinning the CLI pins nothing
 * below it.
 *
 * `latest` is the CLI's own dist-tag: what `npm i -g @deepseek-ai/dsh` gives
 * you today. `DSH_E2E_VERSION` takes any other tag (`next` is upstream's
 * prerelease channel, and what the nightly adds) or an exact version, for
 * pinning deliberately while bisecting a failure.
 */
const DEFAULT_CLI_SPEC = 'latest'

/** Resolve the requested release. An empty variable is unset, as CI writes it. */
function resolveCliSpec(): string {
  const requested = process.env.DSH_E2E_VERSION
  return requested === undefined || requested === '' ? DEFAULT_CLI_SPEC : requested
}

export const CLI_SPEC: string = resolveCliSpec()

/**
 * Registry states that mean "this could not be tested", not "this is broken".
 *
 * `dsh` publishes as a wave of packages depending on each other by `^` range,
 * so between the first and last publish its own graph does not resolve. That
 * is an upstream publish state; it says nothing about this plugin, and
 * reporting it as a test failure sends someone hunting a regression that does
 * not exist.
 */
export const CLI_PACKAGE = '@deepseek-ai/dsh'

/**
 * The dependency an install failure could not resolve, or undefined when the
 * failure was something else.
 * @param reported - the failing command's combined output.
 * @returns the package name, without the range that follows it.
 */
export function unresolvedDependency(reported: string): string | undefined {
  const missing = /No matching version found for (\S+)/.exec(reported)?.[1]
  if (missing === undefined) return undefined
  // "@scope/name@^1.2.3" — the range separator is the LAST @, since a scoped
  // name opens with one.
  const separator = missing.lastIndexOf('@')
  return separator > 0 ? missing.slice(0, separator) : missing
}

/**
 * Whether an install failure is upstream mid-publish rather than a real one.
 *
 * `dsh` publishes as a wave of packages that depend on each other by `^`
 * range, so between the first and last publish its own graph does not resolve.
 * That says nothing about this plugin. A missing version of the package we
 * actually asked for is different — that is a bad spec, and a real error.
 * @param reported - the failing command's combined output.
 * @param requested - the package this suite asked to install.
 */
export function isUpstreamGraphIncomplete(reported: string, requested: string): boolean {
  const unresolved = unresolvedDependency(reported)
  return unresolved !== undefined && unresolved !== requested
}

/**
 * Install the CLI under test, separating "upstream is unusable right now" from
 * a real failure. Exits 2 with a loud SKIPPED for the former, like the suites
 * do for a host with no LAN interface — never silently green.
 * @param workspace - the throwaway directory to install into.
 * @param spec - the version or dist-tag to install.
 */
function installCli(workspace: string, spec: string): void {
  try {
    run('pnpm', ['add', `${CLI_PACKAGE}@${spec}`], { cwd: workspace })
  } catch (error) {
    const reported = String(error)
    if (!isUpstreamGraphIncomplete(reported, CLI_PACKAGE)) throw error
    console.error(`lanyard e2e: ${CLI_PACKAGE}@${spec} does not currently install — the registry has no ${String(unresolvedDependency(reported))} it depends on.`)
    console.error('lanyard e2e: that is an upstream publish state, not a verdict on this plugin. Nothing was tested.')
    console.error('lanyard e2e: SKIPPED (not passed).')
    process.exit(2)
  }
}

const BOOT_TIMEOUT_MS = 180_000

/** The `package.json` fields these suites read. */
interface Manifest {
  name: string
  version: string
  dsh?: { profile?: { bundles?: string[] } }
}

/** One HTTP answer from the deployment. */
export interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** What one probe sends beyond its target. */
export interface ProbeInit {
  method?: string
  headers?: OutgoingHttpHeaders
  body?: string
}

/** The live deployment handed to a suite. */
export interface Deployment {
  /** Path of the installed `dsh` binary. */
  dsh: string
  /** Environment carrying `DSH_HOME`. */
  env: NodeJS.ProcessEnv
  /** Working directory the CLI was installed into. */
  cwd: string
  /** The port the deployment is serving. */
  port: number
  /** The pairing link the readiness line printed. */
  pairingLink: string
  /** The local URL upstream's own `dsh web:` line printed, launch token included. */
  localUrl: string
  /** PEM of the certificate this deployment generated, for validating probes. */
  ca: string
  /** This plugin's package name. */
  packageName: string
  /** The profile's composed bundle layer list. */
  bundles: string[]
}

/**
 * Run a command to completion, failing loudly.
 * @returns the command's combined output.
 */
export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const done = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(done.status)})\n${done.stdout ?? ''}\n${done.stderr ?? ''}`)
  }
  return `${done.stdout ?? ''}${done.stderr ?? ''}`
}

/**
 * The machine's first non-internal IPv4 literal.
 * @returns the address, or undefined on a host with no LAN interface.
 */
export function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address
  }
  return undefined
}

/**
 * A port free right now. `listen` is asynchronous, so the address is only
 * readable once bound.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address() as AddressInfo
      socket.close(() => { resolve(port) })
    })
  })
}

/**
 * One HTTPS request against the deployment, validated against the certificate
 * that deployment generated.
 *
 * Trusting that certificate rather than switching validation off is what makes
 * every check below a statement about *this* deployment: `rejectUnauthorized:
 * false` accepts anything, so the suite would pass while the address it probed
 * was answered by something else entirely, and the certificate the tls row
 * writes — the one a paired phone is asked to accept — would never be
 * exercised at all.
 *
 * An upgrade request the server accepts resolves as status 101; one it refuses
 * resolves with the refusal like any other answer.
 * @param ca - PEM of the deployment's certificate, from {@link Deployment}.
 * @returns the status, headers and body, so the caller can tell a gate refusal
 * from upstream's own and from the app answering after admission.
 */
export function probe(host: string, port: number, path: string, init: ProbeInit = {}, ca?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body } = init
    const rq = request({ host, port, path, method, headers, timeout: 15_000, ...ca !== undefined && { ca } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }) })
    })
    rq.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 101, headers: res.headers, body: '' })
    })
    rq.on('timeout', () => { rq.destroy(new Error('timed out')) })
    rq.on('error', reject)
    rq.end(body)
  })
}

/**
 * One plain-HTTP GET, for the loopback listener upstream's own URL line names.
 * @param url - an `http://` URL.
 */
export function plainGet(url: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const rq = plainRequest(url, { method: 'GET', timeout: 15_000 }, (res) => {
      res.resume()
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' }) })
    })
    rq.on('timeout', () => { rq.destroy(new Error('timed out')) })
    rq.on('error', reject)
    rq.end()
  })
}

/** Headers opening a WebSocket, as a browser sends them. */
export function upgradeHeaders(): OutgoingHttpHeaders {
  return {
    'connection': 'Upgrade',
    'upgrade': 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64'),
  }
}

/**
 * The body the shipped client posts for one Gateway call.
 * @param method - `namespace/method`.
 * @param args - the named arguments.
 */
export function rpcCall(method: string, args: Record<string, unknown> = {}): ProbeInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${method}`, method, payload: { args } }),
  }
}

/**
 * Whether upstream answered a Gateway call with success — the claim a paired
 * device needs, which "the gate did not refuse" is not.
 */
export function succeeded(answer: Answer): boolean {
  if (answer.status !== 200) return false
  try {
    return (JSON.parse(answer.body) as { result?: { ok?: unknown } }).result?.ok === true
  } catch {
    return false
  }
}

/** The `name=value` pair of the session cookie an answer set, if it set one. */
export function sessionCookie(answer: Answer): string | undefined {
  const header = [answer.headers['set-cookie'] ?? []].flat().find(value => value.startsWith('dsh-auth-'))
  return header?.split(';')[0]
}

/**
 * Whether THIS GATE refused. `dsh-client-connection` also answers 403
 * `forbidden` from its Host fence and 401 `unauthorized` without a session, so
 * status alone cannot tell this gate from upstream behind it; the gate's
 * refusal carries its own marker.
 */
export const refused = (answer: Answer): boolean => answer.status === 403 && answer.body === REFUSAL_BODY

/**
 * Whether the request passed the gate and reached whatever owns the route —
 * which may still refuse it. Defined against the gate's own marker rather than
 * as the negation of a spelling: a hardcoded copy that drifted would turn every
 * genuine refusal into a reported admission. Never enough on its own for a
 * claim that something *works*: upstream's 401 satisfies it too, which is how
 * this suite once passed a paired device that could not reach anything.
 */
export const admitted = (answer: Answer): boolean => !refused(answer)

/** The spawned CLI: stdin is ignored, both output streams are piped. */
type DshProcess = ChildProcessByStdio<null, Readable, Readable>

/** The two readiness lines under test: lanyard's pairing link and upstream's own URL line. */
interface ReadinessLines {
  pairingLink: string
  localUrl: string
}

/** Wait for both readiness lines; they print after the Loader settles, in either order. */
function awaitReadiness(server: DshProcess): Promise<ReadinessLines> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`no readiness lines within ${String(BOOT_TIMEOUT_MS)}ms:\n${output}`))
    }, BOOT_TIMEOUT_MS)
    const read = (chunk: Buffer | string): void => {
      output += String(chunk)
      const pairingLink = /lanyard: pair a device by opening (\S+) once/.exec(output)?.[1]
      const localUrl = /dsh web: (\S+)/.exec(output)?.[1]
      if (pairingLink === undefined || localUrl === undefined) return
      clearTimeout(timer)
      resolve({ pairingLink, localUrl })
    }
    server.stdout.on('data', read)
    server.stderr.on('data', read)
    server.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh exited (${String(code)}) before serving:\n${output}`))
    })
  })
}

/**
 * Stand up a deployment, hand it to `body`, and always tear it down.
 * @param body - receives the live deployment facts.
 * @returns whatever `body` returned.
 */
export async function withDshDeployment<T>(body: (deployment: Deployment) => Promise<T>): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), 'lanyard-e2e-'))
  const home = join(workspace, 'home')
  let server: DshProcess | undefined
  try {
    console.log(`lanyard e2e: workspace ${workspace}`)
    console.log('lanyard e2e: packing the plugin as a publishable tarball')
    run('pnpm', ['pack', '--pack-destination', workspace], { cwd: ROOT })
    const { name, version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest
    const tarball = join(workspace, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)

    console.log(`lanyard e2e: installing the published CLI @deepseek-ai/dsh@${CLI_SPEC}`)
    writeFileSync(join(workspace, 'package.json'), '{"name":"lanyard-e2e","private":true}\n')
    installCli(workspace, CLI_SPEC)
    const dsh = join(workspace, 'node_modules', '.bin', 'dsh')
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }

    console.log('lanyard e2e: dsh plugin add')
    run(dsh, ['plugin', '--profile', 'web', 'add', tarball], { cwd: workspace, env })
    const profile = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8')) as Manifest

    const port = await freePort()
    console.log(`lanyard e2e: booting dsh on 0.0.0.0:${String(port)}`)
    server = spawn(dsh, [
      '--profile', 'web', '--host', '0.0.0.0', '--port', String(port), '--no-open',
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })

    const { pairingLink, localUrl } = await awaitReadiness(server)

    // The tls row writes its material to `dshHomePath('lanyard-tls')`, which is
    // this DSH_HOME. Reading it rather than waving certificate validation
    // through is what ties every probe below to this deployment — and it is
    // asserted rather than assumed, because a wrong path that silently fell
    // back to trusting anything would leave the suite green and meaningless.
    const certPath = join(home, 'lanyard-tls', 'cert.pem')
    if (!existsSync(certPath)) {
      throw new Error(
        `lanyard e2e: expected the deployment's certificate at ${certPath} and found none; `
        + 'the tls row may write elsewhere in this version, and probes must not fall back to trusting any certificate',
      )
    }
    const ca = readFileSync(certPath, 'utf8')

    return await body({
      dsh, env, cwd: workspace, port, pairingLink, localUrl, packageName: name, ca,
      bundles: profile.dsh?.profile?.bundles ?? [],
    })
  } finally {
    server?.kill('SIGTERM')
    if (process.env.DSH_E2E_KEEP === undefined) rmSync(workspace, { recursive: true, force: true })
    else console.log(`lanyard e2e: kept ${workspace}`)
  }
}

/** Records assertions and reports them the way both suites print. */
export interface Recorder {
  /** Compare one observation against what it must be. */
  check: <T>(what: string, actual: T, expected: T) => void
  /** Print the tally, failing the process when anything did not hold. */
  report: (label: string) => void
}

/** A tiny assertion recorder shared by the suites. */
export function recorder(): Recorder {
  const results: { ok: boolean }[] = []
  return {
    check<T>(what: string, actual: T, expected: T): void {
      const ok = actual === expected
      results.push({ ok })
      console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}  →  ${String(actual)}${ok ? '' : `  (expected ${String(expected)})`}`)
    },
    report(label: string): void {
      const failed = results.filter(result => !result.ok)
      console.log(`\n${label}: ${String(results.length - failed.length)}/${String(results.length)} checks passed`)
      if (failed.length > 0) process.exitCode = 1
    },
  }
}

/**
 * The machine's LAN address, refusing to pass vacuously without one.
 * @returns the address; exits with code 2 when the host has no LAN interface.
 */
export function requireLan(): string {
  const lan = lanAddress()
  if (lan !== undefined) return lan
  console.error('lanyard e2e: this host has no non-loopback IPv4 address, so the LAN half cannot be exercised.')
  console.error('lanyard e2e: SKIPPED (not passed) — run it somewhere with a LAN interface.')
  process.exit(2)
}
