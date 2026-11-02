/**
 * Source-level mutation gate for delayed pairing readiness. The pairing row
 * must use the current upstream authentication service, not a launch-token
 * issuer captured before the Loader settled. This is a source mutation of
 * the real module under the real Vitest cases, not a model of the function.
 * Always restore the checked-out source, including on assertion failure.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/pairing.ts')
const original = readFileSync(sourcePath, 'utf8')
const guarded = "      currentIssuer = ctx.get('connection')"
const unsafe = "      currentIssuer = issuer /* MUTANT: use stale startup issuer */"
const caseName = 'does not print a stale launch token when the connection is'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-pairing-readiness-mutant-'))

interface Assertion {
  fullName?: string
  status?: string
  failureMessages?: string[]
}
interface Report { testResults?: Array<{ assertionResults?: Assertion[] }> }

function run(label: string, expectFailure: boolean): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', 'tests/pairing.spec.ts',
    '-t', caseName, '--reporter=json', '--outputFile', reportPath,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: Vitest did not start: ${result.error.message}`)
  let report: Report
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report }
  catch { throw new Error(`${label}: no readable Vitest JSON report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(caseName))
  if (matches.length !== 2) throw new Error(`${label}: expected two delayed readiness cases, got ${matches.length}`)
  const failures = matches.flatMap(test => test.failureMessages ?? []).join('\\n')
  if (!expectFailure) {
    if (result.status !== 0 || matches.some(test => test.status !== 'passed'))
      throw new Error(`${label}: baseline did not pass: ${failures}`)
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
  if (original.split(guarded).length !== 2) throw new Error('pairing readiness guard anchor missing or ambiguous')
  run('baseline', false)
  writeFileSync(sourcePath, original.replace(guarded, unsafe))
  try { run('stale-issuer', true) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('pairing source restoration failed')
process.stdout.write('Delayed pairing issuer source mutation killed; source restored.\n')
