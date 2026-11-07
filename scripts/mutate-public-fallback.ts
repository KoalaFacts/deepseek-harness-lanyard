/**
 * Mutation gate for anonymous HTTP writes through both public seats.
 * Future fallback or explicitly public named writers must not inherit anonymous GET/HEAD.
 * Restore source even when the intentionally unsafe mutation fails unexpectedly.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/webserver.ts')
const original = readFileSync(sourcePath, 'utf8')
const guarded = `      const posture = this.fallbackAdmission === 'public'
        && req.method !== 'GET' && req.method !== 'HEAD' ? 'gated' : this.fallbackAdmission`
const unsafe = `      const posture = this.fallbackAdmission`
const caseName = 'requires a session for unsafe methods at the public fallback'
const namedCase = 'never grants anonymous writes to an explicitly public named route'
const apiNamedCase = 'keeps API sessions and pins despite an explicitly public registrar'
const apiFallbackCase = 'never grants anonymous fallback access to API endpoints after a routing change'
const driftCase = 'keeps the shipped API pin when a configured prefix drifts'
const pinnedFallbackCase = 'keeps loopback-only route pins even when a public fallback takes the request'
const pinnedFallbackGuard = `    // A known loopback-only path stays private even if an upstream routing
    // change sends it to a different named seat or the public SPA fallback.
    // Compare the decoded spelling too: a future route owner may interpret
    // percent-encoded separators before dispatching a desktop-only action.
    if (this.loopbackOnlyPaths.some(path => raw === path || decoded === path)) {
      return isLoopbackAddress(req.socket.remoteAddress)
    }`
const driftEndpointGuard = 'endpointOf(reading, DEFAULT_API_PATH_PREFIX)'
const apiSeatGuard = "    if (routePath === this.apiPathPrefix || routePath.startsWith(`${this.apiPathPrefix}/`)) return 'gated'"
const apiRequestGuard = " && !isApiRequest"
const namedGuard = "    if (admission === 'public' && !excluded && !isApiRequest && !isKnownApiRequest && (req.method === 'GET' || req.method === 'HEAD')) return true"
const unsafeNamed = "    if (admission === 'public' && !excluded) return true"
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-public-fallback-mutant-'))

function run(label: string, expectFailure: boolean, selectedCase = caseName, testFile = 'tests/gated-webserver.spec.ts'): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', testFile,
    '-t', selectedCase, '--reporter=json', '--outputFile', reportPath,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: Vitest did not start: ${result.error.message}`)
  let report: { testResults?: Array<{ assertionResults?: Array<{
    fullName?: string; status?: string; failureMessages?: string[]
  }> }> }
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) }
  catch { throw new Error(`${label}: no readable Vitest JSON report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(selectedCase))
  if (matches.length !== 1) throw new Error(`${label}: expected one target test, got ${matches.length}`)
  const [target] = matches
  if (target === undefined) throw new Error(`${label}: target was absent`)
  const failure = (target.failureMessages ?? []).join('\n')
  if (!expectFailure) {
    if (result.status !== 0 || target.status !== 'passed')
      throw new Error(`${label}: baseline failed: ${failure}`)
  } else if (result.status === 0 || target.status !== 'failed' || !/403/.test(failure) || !/200/.test(failure)) {
    throw new Error(`${label}: mutation survived or failed for another reason: ${failure}`)
  }
}

try {
  if (original.split(guarded).length !== 2) throw new Error('public fallback guard anchor missing or ambiguous')
  if (original.split(namedGuard).length !== 2) throw new Error('named public route guard anchor missing or ambiguous')
  if (original.split(apiSeatGuard).length !== 2) throw new Error('API route posture guard anchor missing or ambiguous')
  if (original.split(apiRequestGuard).length !== 2) throw new Error('API request exception guard anchor missing or ambiguous')
  if (original.split(driftEndpointGuard).length !== 2) throw new Error('known API path fallback anchor missing or ambiguous')
  if (original.split(pinnedFallbackGuard).length !== 2) throw new Error('loopback-only fallback pin anchor missing or ambiguous')
  run('baseline', false)
  // The shared permits() guard also protects the fallback. Remove both layers
  // in this mutant, or it still refuses anonymous writes for the correct reason.
  writeFileSync(sourcePath, original.replace(guarded, unsafe).replace(namedGuard, unsafeNamed))
  try { run('mutant', true) }
  finally { writeFileSync(sourcePath, original) }
  run('named-baseline', false, namedCase)
  writeFileSync(sourcePath, original.replace(namedGuard, unsafeNamed))
  try { run('named-mutant', true, namedCase) }
  finally { writeFileSync(sourcePath, original) }
  run('api-named-baseline', false, apiNamedCase)
  // Both the route posture and the request guard independently defend /api.
  // Remove both only in this negative control to demonstrate the regression.
  writeFileSync(sourcePath, original.replace(apiSeatGuard, '').replace(apiRequestGuard, ''))
  try { run('api-named-mutant', true, apiNamedCase) }
  finally { writeFileSync(sourcePath, original) }
  run('api-fallback-baseline', false, apiFallbackCase)
  writeFileSync(sourcePath, original.replace(apiRequestGuard, ''))
  try { run('api-fallback-mutant', true, apiFallbackCase) }
  finally { writeFileSync(sourcePath, original) }
  run('pinned-fallback-baseline', false, pinnedFallbackCase)
  writeFileSync(sourcePath, original.replace(pinnedFallbackGuard, ''))
  try { run('pinned-fallback-mutant', true, pinnedFallbackCase) }
  finally { writeFileSync(sourcePath, original) }
  run('api-drift-baseline', false, driftCase, 'tests/policy-config.spec.ts')
  // Removing only the known-prefix endpoint pin must let a paired browser
  // reach /api/settings/update when the configured prefix is stale.
  writeFileSync(sourcePath, original.replace(driftEndpointGuard, 'undefined'))
  try { run('api-drift-mutant', true, driftCase, 'tests/policy-config.spec.ts') }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('public fallback source restoration failed')
process.stdout.write('Anonymous write-method, known-API drift and API public-exemption mutations killed; source restored.\n')
