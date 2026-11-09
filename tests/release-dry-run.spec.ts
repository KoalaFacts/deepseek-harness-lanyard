/** Release rehearsals must not request production environment approval. */
import { readFileSync } from 'node:fs'
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
