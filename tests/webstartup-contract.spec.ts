/**
 * The contract this plugin takes on by replacing a shipped row.
 *
 * `lanyard-startup` sits in the seat `web-startup` held, so every row the
 * shipped `@deepseek-ai/dsh-web-app` bundle configures from `ctx.webStartup`
 * must still find what it reads. A field the replacement forgets does not
 * fail: the consuming row's schema quietly substitutes its default, which is
 * how the shipped `--no-open` flag went missing once already.
 *
 * The same goes for the ids the patch disables. `applyEntryPatches` *warns and
 * skips* a patch whose id it cannot find, so an upstream rename would leave
 * the stock carrier mounted beside the gated one instead of failing loudly.
 *
 * Both are checked against the installed bundle, never a copy of it, so a
 * harness upgrade that moves either contract fails here first.
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
const shippedPatchPath = require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')
const shippedPatchSource = readFileSync(shippedPatchPath, 'utf8')

interface PatchRow { id?: string; disabled?: boolean; insert?: PatchRow[] }

const shippedRows = (parse(shippedPatchSource, {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }],
}) as PatchRow[]).flatMap(row => [row, ...row.insert ?? []])
const shippedIds = new Set(shippedRows.map(row => row.id).filter((id): id is string => id !== undefined))

const ourPatch = parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }],
}) as PatchRow[]

/** Every `webStartup` field the shipped bundle reads from its `!!js` config. */
const readFields = new Set(
  [...shippedPatchSource.matchAll(/ctx\.webStartup\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1] as string),
)

/** Every field this provider can publish, sampled from a maximal invocation. */
function publishedFields(): Set<string> {
  const program: Command = webCommand().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  let keys: string[] = []
  program.action(() => { keys = Object.keys(resolveStartupValues(program)) })
  program.parse([
    '--host', '0.0.0.0', '--port', '3080', '--no-open', '--keep-awake',
    '--pairing-token-env', 'DSH_PAIRING_TOKEN', '--trusted-host', 'app.internal',
  ], { from: 'user' })
  return new Set(keys)
}

describe('the webStartup contract lanyard-startup takes over', () => {
  it('reads the bundle actually installed, not a vendored copy', () => {
    expect(shippedPatchPath).toContain('@deepseek-ai/dsh-web-app')
    expect(readFields.size).toBeGreaterThan(0)
  })

  it('publishes every field the shipped rows read', () => {
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

  it('disables only ids the shipped bundle actually defines', () => {
    // applyEntryPatches warns and skips an id it cannot find; a rename upstream
    // would leave the stock carrier mounted beside the gated one.
    for (const row of ourPatch.filter(entry => entry.disabled === true)) {
      expect([row.id, shippedIds.has(row.id ?? '')]).toEqual([row.id, true])
    }
  })

  it('inserts ids that do not collide with shipped rows', () => {
    for (const row of ourPatch.flatMap(entry => entry.insert ?? [])) {
      expect([row.id, shippedIds.has(row.id ?? '')]).toEqual([row.id, false])
    }
  })
})
