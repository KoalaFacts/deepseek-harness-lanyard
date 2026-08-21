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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:https'
import type { OutgoingHttpHeaders } from 'node:http'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The CLI release the suites pin to by default, so an ordinary run is
 * reproducible. `DSH_E2E_VERSION=newest` tracks the registry instead — what
 * the nightly does, because this plugin's real exposure is upstream drift.
 */
const DEFAULT_CLI_VERSION = '0.1.1-rc.1'

/**
 * The most recently published version of a package.
 *
 * Not the `latest` dist-tag: these packages publish prereleases without moving
 * that tag, so `latest` still points at an ancient build. The registry lists
 * versions in publish order, which is the notion "newest release" means here.
 * @param name - the package to look up.
 * @returns the last published version string.
 */
export function newestPublished(name: string): string {
  const listed: unknown = JSON.parse(run('npm', ['view', name, 'versions', '--json']))
  const versions = Array.isArray(listed) ? (listed as string[]) : [String(listed)]
  const newest = versions.at(-1)
  if (newest === undefined) throw new Error(`no published versions found for ${name}`)
  return newest
}

/** Resolve the requested CLI release. An empty variable is unset, as CI writes it. */
function resolveCliVersion(): string {
  const requested = process.env.DSH_E2E_VERSION
  if (requested === undefined || requested === '') return DEFAULT_CLI_VERSION
  return requested === 'newest' ? newestPublished('@deepseek-ai/dsh') : requested
}

export const CLI_VERSION: string = resolveCliVersion()
export const TOKEN = 'e2e-token_0123456789-abcdef'

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
  body: string
}

/** The live deployment handed to a suite. */
export interface Deployment {
  /** Path of the installed `dsh` binary. */
  dsh: string
  /** Environment carrying `DSH_HOME` and the pairing token. */
  env: NodeJS.ProcessEnv
  /** Working directory the CLI was installed into. */
  cwd: string
  /** The port the deployment is serving. */
  port: number
  /** The pairing link the readiness line printed. */
  pairingLink: string
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
 * One HTTPS request against the deployment, accepting its self-signed cert.
 * @returns the status and body, so the caller can tell a gate refusal from the
 * app answering after admission.
 */
export function probe(host: string, port: number, path: string, headers: OutgoingHttpHeaders = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const rq = request({ host, port, path, method: 'GET', headers, rejectUnauthorized: false, timeout: 15_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
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
export const refused = (answer: Answer): boolean => answer.status === 403 && answer.body === 'lanyard: forbidden'

/** Whether the request passed the gate and reached whatever owns the route. */
export const admitted = (answer: Answer): boolean => !refused(answer)

/** The spawned CLI: stdin is ignored, both output streams are piped. */
type DshProcess = ChildProcessByStdio<null, Readable, Readable>

/** Wait for the readiness line, which is also the pairing link under test. */
function awaitPairingLink(server: DshProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`no pairing line within ${String(BOOT_TIMEOUT_MS)}ms:\n${output}`))
    }, BOOT_TIMEOUT_MS)
    const read = (chunk: Buffer | string): void => {
      output += String(chunk)
      const match = /lanyard: pair a device by opening (\S+) once/.exec(output)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolve(match[1])
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

    console.log(`lanyard e2e: installing the published CLI @deepseek-ai/dsh@${CLI_VERSION}`)
    writeFileSync(join(workspace, 'package.json'), '{"name":"lanyard-e2e","private":true}\n')
    run('pnpm', ['add', `@deepseek-ai/dsh@${CLI_VERSION}`], { cwd: workspace })
    const dsh = join(workspace, 'node_modules', '.bin', 'dsh')
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_E2E_TOKEN: TOKEN }

    console.log('lanyard e2e: dsh plugin add')
    run(dsh, ['plugin', '--profile', 'web', 'add', tarball], { cwd: workspace, env })
    const profile = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8')) as Manifest

    const port = await freePort()
    console.log(`lanyard e2e: booting dsh on 0.0.0.0:${String(port)}`)
    server = spawn(dsh, [
      '--profile', 'web', '--host', '0.0.0.0', '--port', String(port),
      '--no-open', '--pairing-token-env', 'DSH_E2E_TOKEN',
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })

    const pairingLink = await awaitPairingLink(server)
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
