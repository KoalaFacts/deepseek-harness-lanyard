/**
 * Gate on the shipped artifact, not on the sources the tests import.
 *
 * Two properties only `lib/` can prove: every subpath the `exports` map (and
 * therefore `cordis.patch.yml`) names actually resolves and loads, and the
 * pairing bootstrap still serializes to working page source after the build.
 * That second one is the fragile half — `bootstrapAuthToken` reaches the
 * browser through `Function.prototype.toString`, so any build step that
 * rewrote its body to reference module scope would emit a script that throws
 * in the page while every source-level test kept passing.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
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

const { pairingBootstrapScript } = await import(manifest.name) as {
  pairingBootstrapScript: () => string
}

/** What the fake page recorded while the built bootstrap ran against it. */
interface FakePage {
  stored: Record<string, string>
  cookie: string
}

const token = 'pairing-token_0123456789-ab'
const page: FakePage = { stored: {}, cookie: '' }
runInNewContext(pairingBootstrapScript().replace(/^<script>/, '').replace(/<\/script>$/, ''), {
  URLSearchParams,
  location: { hash: `#auth=${token}`, pathname: '/', search: '', protocol: 'https:' },
  localStorage: {
    getItem: (key: string): string | null => page.stored[key] ?? null,
    setItem: (key: string, value: string): void => { page.stored[key] = value },
  },
  document: {
    set cookie(value: string) { page.cookie = value },
    get cookie(): string { return page.cookie },
  },
  history: { replaceState: (): void => {} },
})
assert.equal(page.cookie, `dsh_auth=${token}; path=/; SameSite=Strict; Secure`,
  'the built pairing bootstrap did not publish the cookie; the build rewrote its serialized body')

console.log(`lanyard: build verified — ${String(Object.keys(manifest.exports).length)} exports load, pairing bootstrap runs`)
