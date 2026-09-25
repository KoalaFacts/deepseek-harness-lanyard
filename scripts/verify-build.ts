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

// Data entries — the patch, the manifest, the locale files — are not modules;
// tests/plugin-metadata.spec.ts resolves the locale files the way dsh does.
const modules = Object.keys(manifest.exports).filter(subpath => !subpath.endsWith('.json') && !subpath.endsWith('.yml'))
for (const subpath of modules) {
  const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`
  const loaded = await import(specifier) as Record<string, unknown>
  assert.ok(Object.keys(loaded).length > 0, `${specifier} loaded but exported nothing`)
}

console.log(`lanyard: build verified — ${String(modules.length)} module exports load`)
