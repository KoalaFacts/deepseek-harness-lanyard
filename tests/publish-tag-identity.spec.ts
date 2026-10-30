/** The credential-bearing publish job must never resolve a mutable release tag
 * after verifying it. A dry run must stop in the unprivileged verify job.
 * Execute the real tag-identity guard against a disposable local Git remote:
 * both an extra commit on main and a tag force-move are deliberately realistic.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  id?: string
  name?: string
  if?: string
  uses?: string
  with?: { ref?: string }
  run?: string
}

interface WorkflowJob {
  if?: string
  needs?: string
  environment?: string
  permissions?: Record<string, string>
  outputs?: Record<string, string>
  steps: WorkflowStep[]
}

const workflowPath = fileURLToPath(new URL('../.github/workflows/publish-npm.yml', import.meta.url))
const { jobs, permissions } = parse(readFileSync(workflowPath, 'utf8')) as {
  permissions: Record<string, string>
  jobs: { verify: WorkflowJob; publish: WorkflowJob }
}
const tagGuard = jobs.publish.steps.find(step => step.name === 'Refuse a release tag changed after verification')

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

describe('publish-npm commit identity', () => {
  it('pins real publication to the verified SHA and keeps dry runs out of production', () => {
    const pin = jobs.verify.steps.find(step => step.id === 'pin')
    expect(pin?.run).toContain('tag_sha=$TAG_SHA')
    expect(jobs.verify.outputs?.tag_sha).toBe('${{ steps.pin.outputs.tag_sha }}')
    expect(jobs.publish.needs).toBe('verify')

    // The rehearsal is deliberately unprivileged, even though it runs npm publish --dry-run.
    expect(permissions).toEqual({ contents: 'read' })
    expect(jobs.verify.environment).toBeUndefined()
    expect(jobs.verify.permissions?.['id-token']).not.toBe('write')
    const rehearsals = jobs.verify.steps.filter(step => step.run?.includes('npm publish '))
    expect(rehearsals).toHaveLength(1)
    expect(rehearsals[0]?.if).toBe('inputs.dry_run == true')
    expect(rehearsals[0]?.run).toContain('--dry-run')
    expect(rehearsals[0]?.run).toContain('--ignore-scripts')

    // The credential-bearing job cannot execute during a dry run.
    expect(jobs.publish.if).toBe('inputs.dry_run == false')
    expect(jobs.publish.environment).toBe('production')
    expect(jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    const checkout = jobs.publish.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.ref).toBe('${{ needs.verify.outputs.tag_sha }}')

    const guardIndex = jobs.publish.steps.indexOf(tagGuard!)
    const publishIndexes = jobs.publish.steps
      .map((step, index) => step.run?.includes('npm publish ') ? index : -1)
      .filter(index => index >= 0)
    expect(guardIndex).toBeGreaterThan(0)
    expect(publishIndexes).toHaveLength(1)
    for (const index of publishIndexes) {
      expect(guardIndex).toBeLessThan(index)
      expect(jobs.publish.steps[index]?.run).toContain('--provenance')
      expect(jobs.publish.steps[index]?.run).not.toContain('--dry-run')
    }
    expect(tagGuard?.run).toContain('FETCH_HEAD^{commit}')
    expect(tagGuard?.run).toContain('git rev-parse HEAD')
  })

  it('accepts the same lightweight or annotated tag, but rejects a move or deletion', () => {
    expect(tagGuard?.run).toBeTruthy()
    const root = mkdtempSync(join(tmpdir(), 'lanyard-tag-pin-'))
    try {
      const source = join(root, 'source')
      const remote = join(root, 'remote.git')
      const publisher = join(root, 'publisher')
      git(root, 'init', '--bare', remote)
      git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
      git(root, 'init', '-b', 'main', source)
      git(source, 'config', 'user.name', 'Local CI fixture')
      git(source, 'config', 'user.email', 'ci@example.invalid')
      writeFileSync(join(source, 'payload.txt'), 'reviewed payload A\n')
      git(source, 'add', 'payload.txt')
      git(source, 'commit', '-m', 'verified A')
      const verified = git(source, 'rev-parse', 'HEAD')
      git(source, 'tag', 'v0.2.0')
      git(source, 'remote', 'add', 'origin', remote)
      git(source, 'push', 'origin', 'main', '--tags')
      git(root, 'clone', remote, publisher)

      const runGuard = () => spawnSync('bash', ['-c', tagGuard!.run!], {
        cwd: publisher,
        encoding: 'utf8',
        env: { ...process.env, VERSION: '0.2.0', VERIFIED_SHA: verified },
      })
      expect(runGuard().status).toBe(0)

      // Both commits remain on main: the old ancestor gate alone accepts B.
      writeFileSync(join(source, 'payload.txt'), 'unreviewed payload B\n')
      git(source, 'add', 'payload.txt')
      git(source, 'commit', '-m', 'later main B')
      git(source, 'push', 'origin', 'main')
      git(source, 'tag', '-f', 'v0.2.0')
      git(source, 'push', '--force', 'origin', 'v0.2.0')
      const moved = runGuard()
      expect(moved.status).not.toBe(0)
      expect(String(moved.stdout) + String(moved.stderr)).toContain('moved after verification')

      // Annotated tags resolve through the ^{commit} peel to the same SHA.
      git(source, 'tag', '-fa', 'v0.2.0', verified, '-m', 'annotated reviewed A')
      git(source, 'push', '--force', 'origin', 'v0.2.0')
      expect(runGuard().status).toBe(0)

      // A correct remote tag cannot bless an accidentally different checkout.
      git(publisher, 'fetch', 'origin', 'main')
      git(publisher, 'checkout', '--detach', 'FETCH_HEAD')
      const wrongHead = runGuard()
      expect(wrongHead.status).not.toBe(0)
      expect(String(wrongHead.stdout) + String(wrongHead.stderr)).toContain('checkout is not the verified commit')
      git(publisher, 'checkout', '--detach', verified)
      expect(runGuard().status).toBe(0)

      // A transport failure is not evidence that the tag is still unchanged.
      git(publisher, 'remote', 'set-url', 'origin', join(root, 'missing-origin.git'))
      expect(runGuard().status).not.toBe(0)
      git(publisher, 'remote', 'set-url', 'origin', remote)
      expect(runGuard().status).toBe(0)

      git(source, 'push', 'origin', ':refs/tags/v0.2.0')
      expect(runGuard().status).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
