/** Verify the files npm would ship, not just the files in the checkout.
 * The release job publishes with --ignore-scripts: checking the same packing
 * mode after build avoids silently rebuilding a different payload on publish.
 * A dry run publishes nothing; the separate DSH e2e proves tarball installation.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { permittedPayloadPaths } from './payload-allowlist.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  exports: Record<string, string | { types?: string; default?: string }>
}
const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
})
if (run.error) throw run.error
assert.equal(run.status, 0, 'npm pack dry run failed:\n' + run.stderr + '\n' + run.stdout)
const response: unknown = JSON.parse(run.stdout)
assert.ok(Array.isArray(response) && response.length === 1, 'npm pack must describe one package')
const packed = response[0] as { name?: unknown; version?: unknown; files?: unknown }
assert.equal(packed.name, manifest.name)
assert.equal(packed.version, manifest.version)
assert.ok(Array.isArray(packed.files) && packed.files.length > 0, 'npm pack yielded no files')
const paths = new Set<string>()
for (const item of packed.files) {
  const path = (item as { path?: unknown })?.path
  assert.ok(typeof path === 'string' && path.length > 0, 'invalid packed file path')
  assert.ok(!path.includes('\\') && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'noncanonical packed path: ' + path)
  assert.ok(!paths.has(path), 'duplicate packed file: ' + path)
  paths.add(path)
}
const metadata = new Set(['package.json', 'LICENSE', 'README.md', 'README.zh.md', 'icon.svg', 'cordis.patch.yml'])
const required = new Set(metadata)
for (const target of Object.values(manifest.exports)) {
  if (typeof target === 'string') {
    for (const language of ['en', 'zh']) {
      required.add(target.replaceAll('*', language).replace(/^\.\//, ''))
    }
  } else {
    assert.ok(target.types && target.default, 'each module export needs JS and types')
    required.add(target.default.replace(/^\.\//, ''))
    required.add(target.types.replace(/^\.\//, ''))
  }
}
for (const dir of ['', 'startup/', 'tls/', 'webserver/', 'pairing/', 'keep-awake/']) {
  for (const lang of ['en', 'zh']) required.add('locale/' + dir + lang + '.json')
}
for (const path of required) assert.ok(paths.has(path), 'npm would omit required file: ' + path)
// New exports alone must not authorize accidental runtime or translation files.
// A separately enumerated inventory makes a new pack member an explicit review.
const unexpected = [...paths].filter(path => !permittedPayloadPaths.has(path))
assert.deepEqual(unexpected, [], 'unexpected packed files: ' + unexpected.join(', '))
let modules = 0
for (const path of paths) {
  if (path.startsWith('lib/') && path.endsWith('.js')) {
    modules++
    assert.ok(paths.has('lib/types/' + path.slice(4, -3) + '.d.ts'), 'missing declaration for ' + path)
  }
  if (path.startsWith('lib/types/') && path.endsWith('.d.ts')) {
    assert.ok(paths.has('lib/' + path.slice('lib/types/'.length, -5) + '.js'), 'missing JS for ' + path)
  }
}
assert.ok(modules > 0, 'no runtime JavaScript was packed')
console.log('lanyard: npm publish payload verified (' + paths.size + ' files, ' + modules + ' JS modules, 12 translations; dry-run only)')
