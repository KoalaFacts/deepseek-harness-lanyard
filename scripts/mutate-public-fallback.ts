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
const namedGuard = "    if (admission === 'public' && !excluded && (req.method === 'GET' || req.method === 'HEAD')) return true"
const unsafeNamed = "    if (admission === 'public' && !excluded) return true"
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-public-fallback-mutant-'))

function run(label: string, expectFailure: boolean, selectedCase = caseName): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', 'tests/gated-webserver.spec.ts',
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
  run('baseline', false)
  writeFileSync(sourcePath, original.replace(guarded, unsafe))
  try { run('mutant', true) }
  finally { writeFileSync(sourcePath, original) }
  run('named-baseline', false, namedCase)
  writeFileSync(sourcePath, original.replace(namedGuard, unsafeNamed))
  try { run('named-mutant', true, namedCase) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('public fallback source restoration failed')
process.stdout.write('Anonymous fallback and named-route write-method mutations killed; source restored.\n')
