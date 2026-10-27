/**
 * Source-level mutation gate for TLS identity recovery. The baseline case must
 * pass; removing each named guard must make its specific Vitest case fail.
 * Always restore the checked-out source before returning or throwing.
 * This deliberately uses the actual module and test suite, not a facsimile.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface Mutant {
  label: string
  from: string
  to: string
  file: string
  test: string
  failure: RegExp
}

const mutants: Mutant[] = [
  {
    label: 'first-issue orphan-key cleanup',
    from: 'unlinkSync(keyPath)',
    to: 'void keyPath /* MUTANT: leave orphaned first-issue key */',
    file: 'tests/tls.spec.ts',
    test: 'can retry first-time issuance after a blocked certificate write without an orphan key',
    failure: /expected true to be false/i,
  },
  {
    label: 'rename-failure temporary-file cleanup',
    from: 'try { unlinkSync(temp) }',
    to: 'try { void temp /* MUTANT: retain failed rename temp */ }',
    file: 'tests/tls-rename-retry.spec.ts',
    test: 'removes only the temp it created on rename failure and retries with the saved key',
    failure: /expected true to be false/i,
  },
  {
    label: 'incomplete saved identity fail-closed guard',
    from: 'if (hasCertificate !== hasKey)',
    to: 'if (false /* MUTANT: accept an incomplete saved identity */)',
    file: 'tests/tls.spec.ts',
    test: 'refuses to overwrite a surviving identity file when cert.pem is missing',
    failure: /promise resolved/i,
  },
]

const root = process.cwd()
const sourcePath = resolve(root, 'src/tls.ts')
const original = readFileSync(sourcePath, 'utf8')
const reportsDir = mkdtempSync(join(tmpdir(), 'lanyard-tls-mutants-'))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function runTest(mutant: Mutant, label: string, expectFailure: boolean): void {
  const reportPath = join(reportsDir, label + '.json')
  const result = spawnSync(pnpm, [
    'exec', 'vitest', 'run', mutant.file,
    '-t', mutant.test, '--reporter=json', '--outputFile', reportPath,
  ], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 })
  if (result.error) throw new Error(`${label}: could not run Vitest: ${result.error.message}`)
  let report: { testResults?: Array<{ assertionResults?: Array<{
    fullName?: string; status?: string; failureMessages?: string[]
  }> }> }
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    throw new Error(`${label}: no readable Vitest JSON report (status ${result.status}); ${result.stderr}`)
  }
  const matches = (report.testResults ?? [])
    .flatMap(suite => suite.assertionResults ?? [])
    .filter(test => test.fullName?.includes(mutant.test))
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one targeted test, saw ${matches.length} (status ${result.status})`)
  }
  const target = matches[0]
  if (!expectFailure) {
    if (result.status !== 0 || target.status !== 'passed') {
      throw new Error(`${label}: baseline failed: ${(target.failureMessages ?? []).join('\n')}`)
    }
    return
  }
  if (result.status === 0 || target.status !== 'failed') {
    throw new Error(`${label}: mutation survived: target ${target.status}, status ${result.status}`)
  }
  const failureText = (target.failureMessages ?? []).join('\n')
  if (!mutant.failure.test(failureText)) {
    throw new Error(`${label}: target failed for an unrelated reason: ${failureText}`)
  }
  process.stdout.write(`Killed ${mutant.label}: targeted Vitest assertion failed as expected.\n`)
}

try {
  for (const [index, mutant] of mutants.entries()) {
    if (original.split(mutant.from).length !== 2) {
      throw new Error(`Mutation anchor is missing or ambiguous for ${mutant.label}`)
    }
    const id = String(index)
    runTest(mutant, id + '-baseline', false)
    writeFileSync(sourcePath, original.replace(mutant.from, mutant.to))
    try {
      runTest(mutant, id + '-mutant', true)
    } finally {
      writeFileSync(sourcePath, original)
    }
  }
} finally {
  writeFileSync(sourcePath, original)
  rmSync(reportsDir, { recursive: true, force: true })
}
if (readFileSync(sourcePath, 'utf8') !== original) {
  throw new Error('TLS source restoration failed')
}
process.stdout.write('TLS source-level mutation gate passed (3/3 guards killed).\n')
