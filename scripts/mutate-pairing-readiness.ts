/**
 * Source-level mutation gate for delayed pairing readiness. The pairing row
 * must catch a throwing initial upstream Connection lookup, then use the current authentication service, not a launch-token
 * issuer captured before the Loader settled, must refresh the LAN snapshot, and the concrete-LAN warning must
 * not disappear just because the user selected a specific interface. Both
 * checks mutate the real source under focused Vitest cases. This is a source mutation of
 * the real module under the real Vitest cases, not a model of the function.
 * Always restore the checked-out source, including on assertion failure.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/pairing.ts')
const original = readFileSync(sourcePath, 'utf8')
const activationGuarded = "  let issuer: unknown\n  try {\n    issuer = ctx.get('connection')\n  } catch {\n    // Cordis may throw during an initial service replacement, before the\n    // readiness callback can apply its separate guard. The diagnostic may\n    // contain the launch token: reject with the fixed missing-auth message.\n    issuer = undefined\n  }"
const activationUnsafe = "  const issuer: unknown = ctx.get('connection')"
const activationCaseName = "fails pairing activation without leaking a throwing initial connection lookup"
const guarded = "      currentIssuer = ctx.get('connection')"
const lanSnapshotCaseName = 'refreshes the LAN address snapshot after delayed readiness'
const legacyRuntimeCaseName = 'pairs a concrete LAN bind without querying a broken legacy webRuntime'
const legacyRuntimeGuarded = "    const runtime = (host === undefined || host === '0.0.0.0')\n      ? ctx.get('webRuntime') as WebRuntimeValues | undefined\n      : undefined"
const legacyRuntimeUnsafe = "    const runtime = ctx.get('webRuntime') as WebRuntimeValues | undefined"
const lanSnapshotGuarded = "  if (!config.printPairingUrl) return\n  const announce = async (): Promise<void> => {\n    // A delayed Loader may replace the listener or refresh its LAN snapshot.\n    // Resolve both at announcement time, not at plugin activation, so a phone\n    // never receives a link naming an interface the current server does not use.\n    const server = ctx.webServer as unknown as SchemeAwareServer\n    const host = server.host\n    // Concrete binds on current dsh do not need the legacy webRuntime service.\n    // Skip that optional lookup: a broken getter must not break pairing with\n    // an otherwise healthy TLS listener bound to one known IPv4 address.\n    const runtime = (host === undefined || host === '0.0.0.0')\n      ? ctx.get('webRuntime') as WebRuntimeValues | undefined\n      : undefined\n"
const lanSnapshotUnsafe = "  if (!config.printPairingUrl) return\n  const server = ctx.webServer as unknown as SchemeAwareServer\n  const host = server.host\n  // Concrete binds on current dsh do not need the legacy webRuntime service.\n  // Skip that optional lookup: a broken getter must not break pairing with\n  // an otherwise healthy TLS listener bound to one known IPv4 address.\n  const runtime = (host === undefined || host === '0.0.0.0')\n    ? ctx.get('webRuntime') as WebRuntimeValues | undefined\n    : undefined\n  const announce = async (): Promise<void> => {\n"
const serviceGuarded = "    try {\n      if (ctx.get('webServer') !== undefined) await announce()\n    } catch {\n      // A service can be replaced or fail during Loader readiness. The\n      // accessor's error may contain session data; never let it escape the\n      // detached readiness promise or copy its diagnostic to a log.\n      ctx.logger.error('lanyard: TLS service unavailable at pairing readiness; restart dsh to retry')\n    }"
const serviceUnsafe = "    if (ctx.get('webServer') !== undefined) await announce()"
const serviceCaseName = 'does not leak a failing webServer lookup after delayed readiness'
const immediateServiceCaseName = 'does not leak a failing webServer lookup without Loader'
const immediateServiceGuarded = "  if (settled === undefined) {\n    // Hand-built contexts without Loader announce immediately. Their errors\n    // need the same nonsecret recovery path as delayed readiness callbacks.\n    try {\n      await announce()\n    } catch {\n      ctx.logger.error('lanyard: TLS service unavailable at pairing readiness; restart dsh to retry')\n    }\n    return\n  }"
const immediateServiceUnsafe = "  if (settled === undefined) {\n    await announce()\n    return\n  }"
const unsafe = "      currentIssuer = issuer /* MUTANT: use stale startup issuer */"
const caseName = 'does not print a stale launch token when the connection is'
const warningGuarded = "    console.log(`lanyard: serving your network over TLS on port ${String(reachable)}`\n      + ' — do not open the (LAN: …) link on the dsh web line: it is plain http and carries the launch token')"
const warningUnsafe = "    console.log(`lanyard: serving your network over TLS on port ${String(reachable)}`\n      + (host === undefined || host === '0.0.0.0'\n        ? ' — do not open the (LAN: …) link on the dsh web line: it is plain http and carries the launch token' : ''))"
const warningCaseName = 'warns concrete LAN bind users not to open the upstream plaintext token link'
const carrierSnapshotCaseName = 'keeps one TLS carrier snapshot when webServer changes during pairing'
const carrierSnapshotGuarded = "    const { scheme = 'http', networkPort, certificateFingerprint } = server"
const carrierSnapshotUnsafe = "    const { scheme = 'http', networkPort, certificateFingerprint } = ctx.webServer as unknown as SchemeAwareServer"
const loaderReadinessCaseName = 'refuses a throwing Loader'
const loaderReadinessGuarded = "  const settled = (() => {\n    try {\n      return ctx.get('loader')?.await()\n    } catch {\n      // Upstream can replace Loader during startup. Its getter or await()\n      // may throw a diagnostic with a launch token; never propagate it.\n      throw new Error('lanyard: could not read DSH startup readiness; no pairing link was printed; restart dsh to retry')\n    }\n  })()"
const loaderReadinessUnsafe = "  const settled = ctx.get('loader')?.await()"
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-pairing-readiness-mutant-'))

interface Assertion {
  fullName?: string
  status?: string
  failureMessages?: string[]
}
interface Report { testResults?: Array<{ assertionResults?: Assertion[] }> }

function run(label: string, expectFailure: boolean, focus = caseName): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', 'tests/pairing.spec.ts',
    '-t', focus, '--reporter=json', '--outputFile', reportPath,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: Vitest did not start: ${result.error.message}`)
  let report: Report
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report }
  catch { throw new Error(`${label}: no readable Vitest JSON report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(focus))
  const count = focus === caseName || focus === loaderReadinessCaseName ? 2 : 1
  if (matches.length !== count) throw new Error(`${label}: expected ${count} delayed readiness cases, got ${matches.length}`)
  const failures = matches.flatMap(test => test.failureMessages ?? []).join('\\n')
  if (!expectFailure) {
    if (result.status !== 0 || matches.some(test => test.status !== 'passed'))
      throw new Error(`${label}: baseline did not pass: ${failures}`)
  } else if (focus === serviceCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('lanyard: TLS service unavailable'))) {
      throw new Error(`${label}: unguarded TLS-service lookup survived or failed for another reason: ${failures}`)
    }
  } else if (focus === immediateServiceCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('upstream TLS-service getter'))) {
      throw new Error(`${label}: unguarded immediate TLS-service lookup survived or failed for another reason: ${failures}`)
    }
  } else if (focus === loaderReadinessCaseName) {
    if (result.status === 0 || matches.some(test =>
      test.status !== 'failed' || !(test.failureMessages ?? []).some(message =>
        message.includes('AssertionError:')
        && message.includes("expected 'Error: upstream Loader")
        && message.includes("to be 'Error: lanyard:")))) {
      throw new Error(`${label}: unguarded Loader readiness survived or failed for another reason: ${failures}`)
    }
  } else if (focus === activationCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('to contain')
        && message.includes('lanyard: this dsh has no browser auth'))) {
      throw new Error(`${label}: unguarded initial Connection lookup survived or failed for another reason: ${failures}`)
    }
  } else if (focus === lanSnapshotCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('to include'))) {
      throw new Error(`${label}: stale-LAN-snapshot mutant survived or failed for another reason: ${failures}`)
    }
  } else if (focus === legacyRuntimeCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message => message.includes('synthetic legacy runtime failure'))) {
      throw new Error(`${label}: an unnecessary legacy runtime lookup survived or failed for another reason: ${failures}`)
    }
  } else if (focus === carrierSnapshotCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('to be'))) {
      throw new Error(`${label}: mixed-server snapshot mutant survived or failed for another reason: ${failures}`)
    }
  } else if (focus === warningCaseName) {
    const failure = matches[0]
    if (result.status === 0 || failure?.status !== 'failed'
      || !(failure.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('do not open'))) {
      throw new Error(`${label}: omitted plaintext-link warning survived or failed for another reason: ${failures}`)
    }
  } else {
    // Vitest abbreviates long quoted values inside assertion failures. The
    // stale-issuer mutant does fail both focused tests, but the expected
    // refreshed token and refusal can be truncated in the JSON report.
    // Identify each intended failed assertion without requiring full tokens.
    const failedAtExpectedAssertion = (variant: 'replaced' | 'unavailable', target: string): boolean => {
      const test = matches.find(candidate => candidate.fullName?.includes(`connection is ${variant} before readiness`))
      return test?.status === 'failed' && (test.failureMessages ?? []).some(message =>
        message.includes('AssertionError:') && message.includes('to include') && message.includes(target))
    }
    if (result.status === 0
      || !failedAtExpectedAssertion('replaced', 'lanyard: pair a device by opening')
      || !failedAtExpectedAssertion('unavailable', 'lanyard: browser authentication is no')) {
      throw new Error(`${label}: stale-issuer mutant survived or failed for another reason: ${failures}`)
    }
  }
}

try {
  if (original.split(activationGuarded).length !== 2) throw new Error('initial pairing lookup guard anchor missing or ambiguous')
  run('activation-baseline', false, activationCaseName)
  writeFileSync(sourcePath, original.replace(activationGuarded, activationUnsafe))
  try { run('unguarded-activation', true, activationCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(loaderReadinessGuarded).length !== 2) throw new Error('Loader readiness guard anchor missing or ambiguous')
  run('loader-readiness-baseline', false, loaderReadinessCaseName)
  writeFileSync(sourcePath, original.replace(loaderReadinessGuarded, loaderReadinessUnsafe))
  try { run('unguarded-loader-readiness', true, loaderReadinessCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(guarded).length !== 2) throw new Error('pairing readiness guard anchor missing or ambiguous')
  run('baseline', false)
  writeFileSync(sourcePath, original.replace(guarded, unsafe))
  try { run('stale-issuer', true) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(lanSnapshotGuarded).length !== 2) throw new Error('LAN snapshot timing anchor missing or ambiguous')
  run('lan-snapshot-baseline', false, lanSnapshotCaseName)
  writeFileSync(sourcePath, original.replace(lanSnapshotGuarded, lanSnapshotUnsafe))
  try { run('stale-lan-snapshot', true, lanSnapshotCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(legacyRuntimeGuarded).length !== 2) throw new Error('legacy runtime lookup guard anchor missing or ambiguous')
  run('legacy-runtime-baseline', false, legacyRuntimeCaseName)
  writeFileSync(sourcePath, original.replace(legacyRuntimeGuarded, legacyRuntimeUnsafe))
  try { run('unnecessary-legacy-runtime-lookup', true, legacyRuntimeCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(serviceGuarded).length !== 2) throw new Error('pairing TLS-service guard anchor missing or ambiguous')
  run('tls-service-baseline', false, serviceCaseName)
  writeFileSync(sourcePath, original.replace(serviceGuarded, serviceUnsafe))
  try { run('unguarded-tls-service', true, serviceCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(immediateServiceGuarded).length !== 2) throw new Error('immediate TLS-service guard anchor missing or ambiguous')
  run('immediate-tls-service-baseline', false, immediateServiceCaseName)
  writeFileSync(sourcePath, original.replace(immediateServiceGuarded, immediateServiceUnsafe))
  try { run('unguarded-immediate-tls-service', true, immediateServiceCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(carrierSnapshotGuarded).length !== 2) throw new Error('TLS carrier snapshot guard anchor missing or ambiguous')
  run('carrier-snapshot-baseline', false, carrierSnapshotCaseName)
  writeFileSync(sourcePath, original.replace(carrierSnapshotGuarded, carrierSnapshotUnsafe))
  try { run('mixed-server-snapshot', true, carrierSnapshotCaseName) }
  finally { writeFileSync(sourcePath, original) }
  if (original.split(warningGuarded).length !== 2) throw new Error('concrete LAN warning anchor missing or ambiguous')
  run('concrete-warning-baseline', false, warningCaseName)
  writeFileSync(sourcePath, original.replace(warningGuarded, warningUnsafe))
  try { run('missing-concrete-warning', true, warningCaseName) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('pairing source restoration failed')
process.stdout.write('Pairing activation, readiness, LAN and TLS carrier snapshots, and concrete-LAN plaintext warning source mutations killed; source restored.\n')
