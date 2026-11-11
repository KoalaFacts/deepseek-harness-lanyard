/**
 * Source mutation gate: an empty TLS bind host must not reach Node's wildcard
 * listen() behavior. Run the focused constructor regression intact, then
 * remove the literal-host guard and require the assertion to fail.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/webserver.ts')
const original = readFileSync(sourcePath, 'utf8')
const guarded = "    if (isIP(bindHost) !== 4) {\n      throw new Error('lanyard: bind host must be a concrete IPv4 literal; omit --host to serve loopback only')\n    }"
const caseName = 'refuses an empty TLS bind host instead of selecting a wildcard listener'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-bind-host-mutant-'))

interface Assertion {
  fullName?: string
  status?: string
  failureMessages?: string[]
}
interface Report { testResults?: Array<{ assertionResults?: Assertion[] }> }

function run(label: string, expectFailure: boolean): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', 'tests/gated-webserver.spec.ts',
    '-t', caseName, '--reporter=json', '--outputFile', reportPath,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: Vitest did not start: ${result.error.message}`)
  let report: Report
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report }
  catch { throw new Error(`${label}: no Vitest report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(caseName))
  if (matches.length !== 1) throw new Error(`${label}: expected one focused test; found ${matches.length}`)
  const target = matches[0]
  if (target === undefined) throw new Error(`${label}: focused assertion missing`)
  const failure = (target.failureMessages ?? []).join('\n')
  if (!expectFailure && (result.status !== 0 || target.status !== 'passed')) {
    throw new Error(`${label}: baseline failed: ${failure}`)
  }
  if (expectFailure && (result.status === 0 || target.status !== 'failed')) {
    throw new Error(`${label}: missing-host guard mutation survived: ${failure}`)
  }
}

try {
  if (original.split(guarded).length !== 2) throw new Error('bind-host guard anchor missing or ambiguous')
  run('baseline', false)
  writeFileSync(sourcePath, original.replace(guarded, ''))
  try { run('no-literal-guard', true) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('bind-host source restoration failed')
process.stdout.write('Bind-host mutation killed; source restored.\n')
