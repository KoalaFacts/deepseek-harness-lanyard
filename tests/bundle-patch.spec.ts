/**
 * The shipped bundle patch. Nothing else validates this file: a typo in a row
 * name surfaces only as a plugin that never loads, at boot, on a user's
 * machine — so its structure is checked here against the package that has to
 * satisfy it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh: { bundle: { patch: string } }
}

/** One row of the patch list; `!!js` values are kept as their source expression. */
interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  inject?: string[]
  insert?: PatchRow[]
  config?: Record<string, unknown>
}

const patch = parse(
  readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8'),
  { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }] },
) as PatchRow[]

const inserted = patch.flatMap(row => row.insert ?? [])
const disabled = patch.filter(row => row.disabled === true).map(row => row.id)

describe('the bundle patch', () => {
  it('is the file the manifest declares, so `dsh plugin add` treats this package as a bundle', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('disables exactly the two shipped rows it replaces', () => {
    // web-startup because it refuses --host 0.0.0.0; webserver because the
    // gated subclass takes its seat. Anything else disabled here would be
    // this plugin quietly removing a feature it does not own.
    expect(disabled).toEqual(['web-startup', 'webserver'])
  })

  it('inserts one row per plugin module, each with a stable id', () => {
    expect(inserted.map(row => row.id)).toEqual([
      'lanyard-startup', 'lanyard-tls', 'lanyard-webserver', 'lanyard-keep-awake', 'lanyard-pairing',
    ])
  })

  it('names only subpaths this package exports, each backed by a real module', () => {
    for (const row of inserted) {
      const name = row.name ?? ''
      expect([row.id, name.startsWith(`${manifest.name}/`)]).toEqual([row.id, true])
      const subpath = `.${name.slice(manifest.name.length)}`
      const target = (manifest.exports[subpath] as { default?: string } | undefined)?.default
      expect([row.id, target]).toEqual([row.id, expect.stringMatching(/^\.\/lib\/.+\.js$/)])
      // `lib/` is build output, so the check anchors on the source the build
      // emits from: a row naming a module nobody wrote fails here, not at boot.
      const source = join(root, (target ?? '').replace(/^\.\/lib\//, 'src/').replace(/\.js$/, '.ts'))
      expect([row.id, existsSync(source)]).toEqual([row.id, true])
    }
  })

  it('gives the replacement provider the seat the disabled one held', () => {
    // Nothing downstream changes: rows keep injecting `webStartup`, so the
    // replacement must publish that service under a row of its own.
    const startup = inserted.find(row => row.id === 'lanyard-startup')
    expect(startup?.name).toBe('@koalafacts/lanyard/startup')
    expect(startup?.config).toBeUndefined()
  })

  it('injects the credentials seam into every row that resolves a token reference', () => {
    for (const id of ['lanyard-webserver', 'lanyard-pairing']) {
      const row = inserted.find(entry => entry.id === id)
      expect([id, row?.inject]).toEqual([id, expect.arrayContaining(['credentials'])])
      expect([id, row?.config?.pairingTokenEnv]).toEqual([id, { expression: 'ctx.webStartup.pairingTokenEnv' }])
    }
  })

  it('never carries the token itself into a config surface', () => {
    // Config is echoed by `dsh --dump-config`, the plugin-inventory RPC, and
    // crash dumps; only the reference may travel through it.
    for (const row of inserted) {
      expect([row.id, Object.keys(row.config ?? {})]).toEqual([row.id, expect.not.arrayContaining(['pairingToken'])])
    }
  })

  it('turns TLS on exactly when the bind is all-interfaces', () => {
    const tls = inserted.find(row => row.id === 'lanyard-tls')
    expect(tls?.config?.enabled).toEqual({ expression: "(ctx.webStartup.host ?? '127.0.0.1') === '0.0.0.0'" })
  })
})
