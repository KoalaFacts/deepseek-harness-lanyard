/**
 * Source-level mutation gate for a throwing upstream Connection service lookup.
 * The actual wrapped HTTP handler must refuse an authenticated-looking LAN
 * peer, rather than propagating a potentially secret-bearing Cordis exception.
 * Restore the checked-out product source after every outcome.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/webserver.ts')
const original = readFileSync(sourcePath, 'utf8')
const guarded = "    if (!isLoopbackAddress(req.socket.remoteAddress)) {\n      let authority: unknown\n      try {\n        authority = this.ctx.get('connection')\n      } catch {\n        // The service lookup can itself throw while Connection is replaced or\n        // torn down. Its error may carry session diagnostics: refuse a network\n        // peer without rejecting the route promise or logging the exception.\n        return false\n      }\n      if (!admit(req, authority)) return false\n    }"
const unsafe = "    if (!admit(req, this.ctx.get('connection'))) return false"
const caseName = 'refuses a LAN peer when the connection service lookup itself throws'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-connection-lookup-mutant-'))

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
  catch { throw new Error(`${label}: no readable Vitest JSON report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(caseName))
  if (matches.length !== 1) throw new Error(`${label}: expected one focused test, got ${matches.length}`)
  const target = matches[0]
  if (target === undefined) throw new Error(`${label}: target missing`)
  const failure = (target.failureMessages ?? []).join('\n')
  if (!expectFailure) {
    if (result.status !== 0 || target.status !== 'passed')
      throw new Error(`${label}: baseline failed: ${failure}`)
  } else if (result.status === 0 || target.status !== 'failed'
    || !failure.includes('synthetic connection lookup secret')) {
    throw new Error(`${label}: original direct lookup survived, or failed for another reason: ${failure}`)
  }
}

try {
  if (original.split(guarded).length !== 2) throw new Error('Connection lookup guard anchor missing or ambiguous')
  run('baseline', false)
  writeFileSync(sourcePath, original.replace(guarded, unsafe))
  try { run('unguarded-lookup', true) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('Connection lookup source restoration failed')
process.stdout.write('Connection lookup exception mutation killed; source restored.\n')
