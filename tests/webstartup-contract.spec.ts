/**
 * The contract this plugin takes on by replacing two shipped rows.
 *
 * `lanyard-startup` sits in the seat `web-startup` held, so every row the
 * shipped `@deepseek-ai/dsh-web-app` bundle configures from `ctx.webStartup`
 * must still find what it reads. A field the replacement forgets does not
 * fail: the consuming row's schema quietly substitutes its default, which is
 * how the shipped `--no-open` flag went missing once already.
 *
 * `lanyard-webserver` sits in the seat `webserver` held, and a key the shipped
 * row sets that the replacement does not is dropped the same quiet way — which
 * is how the Web profile's gzip went missing.
 *
 * The same goes for the ids the patch disables. `applyEntryPatches` *warns and
 * skips* a patch whose id it cannot find, so an upstream rename would leave
 * the stock carrier mounted beside the gated one instead of failing loudly.
 *
 * All of it is checked against the installed bundle, never a copy of it, and
 * against every patch file that bundle declares, so a harness upgrade that
 * moves any of these contracts fails here first.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { Command } from 'commander'
import { resolveStartupValues, webCommand } from '../src/startup.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const shippedManifestPath = require.resolve('@deepseek-ai/dsh-web-app/package.json')
const shippedManifest = JSON.parse(readFileSync(shippedManifestPath, 'utf8')) as {
  dsh: { bundle: { patch: string | string[] } }
}

/** Every patch file the installed bundle declares — one path, or a list of them. */
const shippedPatchPaths = [shippedManifest.dsh.bundle.patch].flat()
  .map(relative => join(dirname(shippedManifestPath), relative))
const shippedPatchSources = shippedPatchPaths.map(path => readFileSync(path, 'utf8'))

interface PatchRow { id?: string; disabled?: boolean; insert?: PatchRow[]; config?: Record<string, unknown> }

const yamlOptions = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }],
}

const shippedRows = shippedPatchSources
  .flatMap(source => parse(source, yamlOptions) as PatchRow[] | null ?? [])
  .flatMap(row => [row, ...row.insert ?? []])
const shippedIds = new Set(shippedRows.map(row => row.id).filter((id): id is string => id !== undefined))

const ourPatch = parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), yamlOptions) as PatchRow[]
const ourInserted = ourPatch.flatMap(row => row.insert ?? [])

/** Every `webStartup` field the shipped bundle reads from its `!!js` config. */
const readFields = new Set(shippedPatchSources.flatMap(source =>
  [...source.matchAll(/ctx\.webStartup\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1] as string)))

/** Every field this provider can publish, sampled from a maximal invocation. */
function publishedFields(): Set<string> {
  const program: Command = webCommand().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  let keys: string[] = []
  program.action(() => { keys = Object.keys(resolveStartupValues(program)) })
  program.parse([
    '--host', '0.0.0.0', '--port', '3080', '--network-port', '3443', '--no-open', '--keep-awake',
    '--trusted-host', 'app.internal',
  ], { from: 'user' })
  return new Set(keys)
}

describe('the rows lanyard takes over', () => {
  it('reads the bundle actually installed, not a vendored copy', () => {
    expect(shippedManifestPath).toContain('@deepseek-ai/dsh-web-app')
    expect(shippedPatchPaths.length).toBeGreaterThan(0)
    expect(readFields.size).toBeGreaterThan(0)
  })

  it('publishes every webStartup field the shipped rows read', () => {
    // A missing field is silent: the consuming row's schema default takes
    // over, so the flag simply stops working.
    const published = publishedFields()
    expect([...readFields].filter(field => !published.has(field))).toEqual([])
  })

  it('still offers every flag the shipped provider offers', () => {
    const ours = webCommand().helpInformation()
    for (const flag of ['--host', '--port', '--trusted-host', '--no-open']) {
      expect([flag, ours.includes(flag)]).toEqual([flag, true])
    }
  })

  it('restates every config key the shipped carrier row sets', () => {
    // A key left out falls back to the carrier's schema default — `compression`
    // defaults to none, so the Web profile's gzip would quietly switch off.
    const shipped = shippedRows.find(row => row.id === 'webserver' && row.config !== undefined)
    const ours = ourInserted.find(row => row.id === 'lanyard-webserver')
    expect(shipped).toBeDefined()
    const missing = Object.keys(shipped?.config ?? {}).filter(key => !(key in (ours?.config ?? {})))
    expect(missing).toEqual([])
  })

  it('restates the shipped carrier\'s literal settings with the same values', () => {
    // Host and port are expressions over webStartup and are restated as such;
    // a literal the shipped row sets is a deployment decision to keep.
    const shipped = shippedRows.find(row => row.id === 'webserver' && row.config !== undefined)
    const ours = ourInserted.find(row => row.id === 'lanyard-webserver')
    for (const [key, value] of Object.entries(shipped?.config ?? {})) {
      if (typeof value === 'object') continue
      expect([key, ours?.config?.[key]]).toEqual([key, value])
    }
  })

  it('disables only ids the shipped bundle actually defines', () => {
    // applyEntryPatches warns and skips an id it cannot find; a rename upstream
    // would leave the stock carrier mounted beside the gated one.
    for (const row of ourPatch.filter(entry => entry.disabled === true)) {
      expect([row.id, shippedIds.has(row.id ?? '')]).toEqual([row.id, true])
    }
  })

  it('inserts ids that do not collide with shipped rows', () => {
    for (const row of ourInserted) {
      expect([row.id, shippedIds.has(row.id ?? '')]).toEqual([row.id, false])
    }
  })
})
