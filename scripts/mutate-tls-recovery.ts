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
    label: 'valid managed TLS symlink identity preservation',
    from: 'if (hasCertificate && (lstatSync(certPath).isSymbolicLink() || lstatSync(keyPath).isSymbolicLink())) {',
    to: 'if (false /* MUTANT: allow a managed TLS symlink to be severed during renewal */) {',
    file: 'tests/tls.spec.ts',
    test: 'refuses valid linked managed TLS material before renewal can sever its pointer',
    failure: /promise resolved/i,
  },
  {
    label: 'dangling managed TLS identity symlink presence',
    from: 'return lstatSync(path, { throwIfNoEntry: false }) !== undefined',
    to: 'return existsSync(path) /* MUTANT: treat a dangling saved identity link as absent */',
    file: 'tests/tls.spec.ts',
    test: 'refuses to overwrite dangling saved TLS material paths',
    failure: /promise resolved/i,
  },
  {
    label: 'pre-existing TLS material directory owner-only enforcement',
    from: 'if ((statSync(dir).mode & 0o077) !== 0)',
    to: 'if (false /* MUTANT: accept a traversable managed TLS directory */)',
    file: 'tests/tls.spec.ts',
    test: 'refuses an existing world-traversable managed TLS directory until permissions are repaired',
    failure: /promise resolved/i,
  },
  {
    label: 'pre-existing managed TLS private key owner-only enforcement',
    from: 'if (existsSync(keyPath) && (statSync(keyPath).mode & 0o077) !== 0)',
    to: 'if (false /* MUTANT: reuse a group-readable private key */)',
    file: 'tests/tls.spec.ts',
    test: 'refuses an existing group-readable managed private key until permissions are repaired',
    failure: /promise resolved/i,
  },
  {
    label: 'filesystem-preserving lock parent canonicalization',
    from: 'realpathSync.native(dirname(path))',
    to: 'realpathSync.native(dirname(join(path))) /* MUTANT: normalize before resolving symlinks */',
    file: 'tests/tls-writer-lock.spec.ts',
    test: 'coordinates a symlink followed by dot-dot with its filesystem parent across processes',
    failure: /expected true to be false/i,
  },
  {
    label: 'cooperating TLS writer exclusion',
    from: 'for (const lock of locks)',
    to: 'for (const lock of [] as string[]) /* MUTANT: omit writer locks */',
    file: 'tests/tls-writer-lock.spec.ts',
    test: 'excludes a second process until failed first issuance cleans up, then permits retry',
    failure: /expected true to be false/i,
  },
  {
    label: 'first-issue orphan-key cleanup',
    from: 'unlinkSync(keyPath)',
    to: 'void keyPath /* MUTANT: leave orphaned first-issue key */',
    file: 'tests/tls.spec.ts',
    test: 'can retry first-time issuance after a blocked certificate write without an orphan key',
    failure: /expected true to be false/i,
  },
  {
    label: 'expired TLS renewal key rollback',
    from: 'else if (previousIdentity !== undefined)',
    to: 'else if (false /* MUTANT: strand a rotated key next to the saved certificate */)',
    file: 'tests/tls.spec.ts',
    test: 'keeps the old certificate and key matched after an expired certificate renewal cannot publish',
    failure: /expected false to be true/i,
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
  const [target] = matches
  if (matches.length !== 1 || target === undefined) {
    throw new Error(`${label}: expected one targeted test, saw ${matches.length} (status ${result.status})`)
  }
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
process.stdout.write(`TLS source-level mutation gate passed (${mutants.length}/${mutants.length} guards killed).\n`)
