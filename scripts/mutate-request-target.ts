/**
 * Source-level mutation gate for malformed HTTP request targets.
 * The actual GatedWebServer test must pass intact and fail on the old parser.
 * Restore checked-out source after every outcome.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/webserver.ts')
const original = readFileSync(sourcePath, 'utf8')
const guarded = "    let raw: string\n    try {\n      raw = new URL(req.url ?? '/', 'http://x').pathname\n    } catch {\n      // node:http accepts malformed absolute-form request targets such as\n      // \"http://[\". Never let their URL parse errors escape a route promise\n      // (or let an unparsable target use the public fallback exemption).\n      return false\n    }"
const unsafe = "    const raw = new URL(req.url ?? '/', 'http://x').pathname"
const caseName = "refuses malformed absolute request targets without throwing from the fallback seat"
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-target-mutant-'))

function run(label: string, expectFailure: boolean): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', 'tests/gated-webserver.spec.ts',
    '-t', caseName, '--reporter=json', '--outputFile', reportPath,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: Vitest did not start: ${result.error.message}`)
  let report: { testResults?: Array<{ assertionResults?: Array<{
    fullName?: string; status?: string; failureMessages?: string[]
  }> }> }
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) }
  catch { throw new Error(`${label}: no readable Vitest JSON report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(caseName))
  if (matches.length !== 1) throw new Error(`${label}: expected one target test, got ${matches.length}`)
  const [target] = matches
  if (target === undefined) throw new Error(`${label}: target was absent`)
  const failure = (target.failureMessages ?? []).join('\n')
  if (!expectFailure) {
    if (result.status !== 0 || target.status !== 'passed')
      throw new Error(`${label}: baseline failed: ${failure}`)
  } else if (result.status === 0 || target.status !== 'failed' || !/Invalid URL|promise rejected/i.test(failure)) {
    throw new Error(`${label}: mutation survived or failed for another reason: ${failure}`)
  }
}

try {
  if (original.split(guarded).length !== 2) throw new Error('request-target guard anchor missing or ambiguous')
  run('baseline', false)
  writeFileSync(sourcePath, original.replace(guarded, unsafe))
  try { run('mutant', true) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('request-target source restoration failed')
process.stdout.write('Malformed request-target mutation killed; source restored.\n')
