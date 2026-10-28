/** The npm payload gate must reject unlisted files even when they match a
 * broad lib/type/locale filename pattern and npm's files globs admit them.
 */
import { describe, expect, it } from 'vitest'
import { missingPermittedPayloadPaths, permittedPayloadPaths } from '../scripts/payload-allowlist.ts'

describe('npm publication inventory', () => {
  it('refuses removal of a reviewed JS and declaration pair even if exports omit both', () => {
    const packed = new Set(permittedPayloadPaths)
    packed.delete('lib/pairing.js')
    packed.delete('lib/types/pairing.d.ts')
    expect(missingPermittedPayloadPaths(packed)).toEqual([
      'lib/pairing.js', 'lib/types/pairing.d.ts',
    ])
  })

  it('accepts every file in the reviewed inventory', () => {
    expect(missingPermittedPayloadPaths(permittedPayloadPaths)).toEqual([])
  })

  it('lists exactly the current seven JS/declaration pairs, six bilingual locale pairs and metadata', () => {
    expect(permittedPayloadPaths.size).toBe(32)
    for (const file of [
      'package.json', 'LICENSE', 'README.md', 'README.zh.md', 'icon.svg', 'cordis.patch.yml',
      'lib/index.js', 'lib/types/index.d.ts', 'lib/keep-awake.js', 'lib/types/keep-awake.d.ts',
      'locale/en.json', 'locale/zh.json', 'locale/tls/en.json', 'locale/tls/zh.json',
    ]) {
      expect(permittedPayloadPaths.has(file), file).toBe(true)
    }
  })

  it.each([
    'lib/undocumented.js',
    'lib/types/undocumented.d.ts',
    'locale/tls/debug.json',
    'locale/experimental/en.json',
    'lib/index.js.map',
    'credentials.json',
  ])('refuses an unreviewed packed path: %s', path => {
    expect(permittedPayloadPaths.has(path)).toBe(false)
  })
})
