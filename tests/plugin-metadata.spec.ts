/**
 * What dsh reads from this package before it runs any of it: whether to admit
 * it, and what the Plugins page shows for it.
 *
 * Both fail quietly. A peer range dsh's check rejects — 0.1.7 onwards; earlier
 * releases check nothing — makes an install refuse and a boot skip the bundle
 * with one line on stderr; a locale file the `exports` map does not expose is
 * simply not found, and the page falls back to technical names. So both are
 * checked here the way dsh reads them.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import { parse } from 'yaml'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  icon?: string
  engines: Record<string, string>
  peerDependencies: Record<string, string>
  dsh: { manifestVersion?: number }
}

interface PatchRow { id?: string; name?: string; insert?: PatchRow[] }

/** Every module the bundle patch inserts, enumerated from the patch rather than listed from memory. */
const rowModules = (parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }],
}) as PatchRow[]).flatMap(row => row.insert ?? []).map(row => row.name ?? '')

/** The languages every locale directory must carry, mirroring the README pair. */
const LANGUAGES = ['en', 'zh']

/** dsh's own admission rule: every DSH peer must match, and prereleases take part. */
const admits = (range: string, version: string): boolean => semver.satisfies(version, range, { includePrerelease: true })

describe('what the Plugins page shows', () => {
  it('declares the manifest format dsh reads', () => {
    expect(manifest.dsh.manifestVersion).toBe(1)
  })

  it('resolves a title and a description for the bundle and every row it inserts, in every language', () => {
    for (const specifier of [manifest.name, ...rowModules]) {
      const english = require.resolve(`${specifier}/locale/en.json`)
      for (const language of LANGUAGES) {
        // Resolved through the package's own exports map, exactly as dsh does,
        // and from the same directory as the English file, which dsh requires.
        const file = require.resolve(`${specifier}/locale/${language}.json`)
        expect([specifier, language, dirname(file)]).toEqual([specifier, language, dirname(english)])
        const { meta } = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
        for (const field of ['title', 'description'] as const) {
          const value = meta?.[field]
          expect([specifier, language, field, typeof value === 'string' && value.trim() !== '']).toEqual([specifier, language, field, true])
        }
      }
    }
  })

  it('ships an icon dsh will render', () => {
    // dsh's reader: a manifest-relative SVG, PNG, JPEG or WebP file of at most
    // 256 KiB that stays inside the package after its links are resolved.
    const icon = manifest.icon ?? ''
    expect(['.svg', '.png', '.jpg', '.jpeg', '.webp']).toContain(extname(icon).toLowerCase())
    const file = realpathSync(join(root, icon))
    expect(relative(realpathSync(root), file).startsWith('..')).toBe(false)
    expect(statSync(file).size).toBeLessThanOrEqual(256 * 1024)
    expect(readFileSync(file, 'utf8').trimStart().startsWith('<svg')).toBe(true)
  })

  it('publishes the icon and every locale file in the package itself', () => {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })) as [{ files: { path: string }[] }]
    const shipped = new Set(packed.files.map(file => file.path))
    const wanted = [
      manifest.icon?.replace(/^\.\//, '') ?? '',
      ...[manifest.name, ...rowModules].flatMap(specifier => LANGUAGES.map(language =>
        relative(root, require.resolve(`${specifier}/locale/${language}.json`)).split('\\').join('/'))),
    ]
    expect(wanted.filter(path => !shipped.has(path))).toEqual([])
  })
})

describe('whether dsh admits it', () => {
  const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

  it('states one supported window, for every DSH peer and for engines.dsh alike', () => {
    // dsh checks each DSH peer against its single runtime version, so peers
    // that disagreed would only mean the narrowest one decides.
    expect(dshPeers.length).toBeGreaterThan(0)
    expect(new Set([...dshPeers.map(([, range]) => range), manifest.engines.dsh])).toEqual(new Set([manifest.engines.dsh]))
  })

  it('admits the dsh these suites run against', () => {
    // The installed web-app bundle: the lockfile's `latest` in CI, upstream's
    // `next` in the nightly contract job.
    const installed = (JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-web-app/package.json'), 'utf8')) as { version: string }).version
    for (const [name, range] of dshPeers) expect([name, installed, admits(range, installed)]).toEqual([name, installed, true])
  })

  it('does not admit the next minor line\'s prereleases', () => {
    // Prereleases take part in dsh's matching, so `<0.2.0` would admit
    // 0.2.0-rc.1 — a line nothing here has been run against.
    for (const [name, range] of dshPeers) {
      expect([name, admits(range, '0.2.0-rc.1'), admits(range, '0.2.0')]).toEqual([name, false, false])
    }
  })
})
