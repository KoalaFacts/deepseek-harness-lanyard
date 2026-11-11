/** Release rehearsals must not request production environment approval. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'
import { parse } from 'yaml'

interface Step {
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string
  environment?: string
  steps: Step[]
}

it('keeps release dry runs in the unprivileged verify job', () => {
  const path = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
  const { jobs } = parse(readFileSync(path, 'utf8')) as { jobs: { verify: Job; tag: Job } }
  const check = jobs.verify.steps.findIndex(step => step.run?.includes('npm run check'))
  const report = jobs.verify.steps.findIndex(step => step.name === 'Report what a dry run would have done')
  expect(jobs.verify.environment).toBeUndefined()
  expect(check).toBeGreaterThan(-1)
  expect(report).toBeGreaterThan(check)
  expect(jobs.verify.steps[report]?.if).toBe('inputs.dry_run == true')
  expect(jobs.verify.steps[report]?.env).toEqual({
    VERSION: '${{ steps.version.outputs.version }}',
    DIST_TAG: '${{ steps.version.outputs.dist_tag }}',
  })
  expect(jobs.verify.steps[report]?.run).toContain('no tag and no Release were created')

  // A step-only guard would still enter this protected environment and wait
  // for an approval on a rehearsal; only the whole-job condition avoids it.
  expect(jobs.tag.if).toBe('inputs.dry_run == false')
  expect(jobs.tag.needs).toBe('verify')
  expect(jobs.tag.environment).toBe('production')
  expect(jobs.tag.steps.some(step => step.name === 'Report what a dry run would have done')).toBe(false)
})

it('refuses a late conflicting tag instead of releasing unverified source', () => {
  const path = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
  const { jobs } = parse(readFileSync(path, 'utf8')) as { jobs: { tag: Job } }
  const script = jobs.tag.steps.find(step => step.name === 'Tag the commit and create the GitHub Release')?.run
  expect(script).toBeDefined()
  expect(script).toContain('git tag "v$VERSION" "$TARGET"')
  expect(script).toContain('git push origin "refs/tags/v$VERSION"')
  expect(script).toContain('git fetch --no-tags origin "refs/tags/v$VERSION"')
  expect(script).toContain('REMOTE_SHA="$(git rev-parse \'FETCH_HEAD^{commit}\')"')
  expect(script).toContain('--verify-tag')
  expect(script).not.toContain('--target "$TARGET"')

  // Execute the actual tag/push guard against a disposable bare Git origin.
  // This tests the late-tag race with Git, without creating a real release.
  const begin = script!.indexOf('git tag "v$VERSION" "$TARGET"')
  const end = script!.indexOf('gh release create "v$VERSION"', begin)
  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  const tagGuard = script!.slice(begin, end)
  const root = mkdtempSync(join(tmpdir(), 'lanyard-release-tag-'))
  const origin = join(root, 'origin.git')
  const local = join(root, 'work')
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  try {
    mkdirSync(local)
    git(root, 'init', '--bare', '-q', origin)
    git(local, 'init', '-q', '-b', 'main')
    git(local, 'config', 'user.name', 'Release Gate Test')
    git(local, 'config', 'user.email', 'release-gate@example.invalid')
    git(local, 'commit', '-q', '--allow-empty', '-m', 'before')
    const prior = git(local, 'rev-parse', 'HEAD')
    git(local, 'remote', 'add', 'origin', origin)
    git(local, 'push', '-q', 'origin', 'main')
    git(local, 'commit', '-q', '--allow-empty', '-m', 'verified')
    const verified = git(local, 'rev-parse', 'HEAD')

    // A competing ref now exists, after the earlier verification passed.
    git(local, 'tag', 'v0.2.0', prior)
    git(local, 'push', '-q', 'origin', 'refs/tags/v0.2.0')
    git(local, 'tag', '-d', 'v0.2.0')
    const rejected = spawnSync('bash', ['-euo', 'pipefail', '-c', tagGuard], {
      cwd: local, encoding: 'utf8',
      env: { ...process.env, VERSION: '0.2.0', TARGET: verified },
    })
    expect(rejected.status).not.toBe(0)
    expect(git(local, 'ls-remote', 'origin', 'refs/tags/v0.2.0').split(/\s+/)[0]).toBe(prior)

    // For a genuinely free tag the same guard creates the verified ref.
    const accepted = spawnSync('bash', ['-euo', 'pipefail', '-c', tagGuard], {
      cwd: local, encoding: 'utf8',
      env: { ...process.env, VERSION: '0.2.1', TARGET: verified },
    })
    expect(accepted.status).toBe(0)
    expect(git(local, 'ls-remote', 'origin', 'refs/tags/v0.2.1').split(/\s+/)[0]).toBe(verified)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
