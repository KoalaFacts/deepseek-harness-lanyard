/**
 * Gate on the shipped artifact, not on the sources the tests import.
 *
 * One property only `lib/` can prove: every subpath the `exports` map (and
 * therefore `cordis.patch.yml`) names actually resolves and loads. A row whose
 * module emits to the wrong place, or imports something only the sources can
 * reach, passes every source-level test and fails at boot on a user's machine.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
}

for (const subpath of Object.keys(manifest.exports)) {
  if (subpath.endsWith('.json') || subpath.endsWith('.yml')) continue
  const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`
  const loaded = await import(specifier) as Record<string, unknown>
  assert.ok(Object.keys(loaded).length > 0, `${specifier} loaded but exported nothing`)
}

console.log(`lanyard: build verified — ${String(Object.keys(manifest.exports).length)} exports load`)
