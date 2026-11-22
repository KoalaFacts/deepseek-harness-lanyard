/** Mutation gate for the narrowly paired web/listProviders method. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourcePath = resolve('src/webserver.ts')
const original = readFileSync(sourcePath, 'utf8')
const anchor = "export const DEFAULT_PAIRED_METHODS: readonly string[] = ['web/listProviders']"
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-web-method-mutant-'))
const caseName = 'admits only listProviders, never the web namespace as a whole'

interface Assertion { fullName?: string; status?: string; failureMessages?: string[] }
interface Report { testResults?: Array<{ assertionResults?: Assertion[] }> }

function run(label: string, shouldPass: boolean): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', 'tests/admission.spec.ts',
    '-t', caseName, '--reporter=json', '--outputFile', reportPath,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: Vitest did not start: ${result.error.message}`)
  let report: Report
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report }
  catch { throw new Error(`${label}: unreadable Vitest report (exit ${String(result.status)}): ${result.stderr}`) }
  const matches = (report.testResults ?? []).flatMap(s => s.assertionResults ?? [])
    .filter(test => test.fullName?.includes(caseName))
  if (matches.length !== 1) throw new Error(`${label}: expected one targeted test, got ${matches.length}`)
  const target = matches[0]
  if (!target) throw new Error(`${label}: target missing`)
  if (shouldPass ? (result.status !== 0 || target.status !== 'passed')
    : (result.status === 0 || target.status !== 'failed'))
    throw new Error(`${label}: unexpected test outcome: ${(target.failureMessages ?? []).join('\n')}`)
}

try {
  if (original.split(anchor).length !== 2) throw new Error('Exact-method anchor missing or ambiguous')
  run('baseline', true)
  // A regression that removes the one reviewed exception must fail the positive case.
  writeFileSync(sourcePath, original.replace(anchor,
    "export const DEFAULT_PAIRED_METHODS: readonly string[] = []"))
  try { run('removed-exception', false) }
  finally { writeFileSync(sourcePath, original) }
  // A regression that grants the entire web namespace must fail negative cases.
  const namespaceAnchor = "pairedNamespaces: new Set(DEFAULT_PAIRED_NAMESPACES)"
  if (original.split(namespaceAnchor).length !== 2) throw new Error('Namespace anchor missing or ambiguous')
  writeFileSync(sourcePath, original.replace(namespaceAnchor,
    "pairedNamespaces: new Set([...DEFAULT_PAIRED_NAMESPACES, 'web'])"))
  try { run('open-web-namespace', false) }
  finally { writeFileSync(sourcePath, original) }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) throw new Error('Mutation source restoration failed')
process.stdout.write('Exact web method and namespace mutants killed; source restored.\n')
