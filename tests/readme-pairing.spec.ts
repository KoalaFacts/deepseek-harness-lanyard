/**
 * `README.md` and `README.zh.md` are a translation pair.
 *
 * A rule stated in AGENTS.md and checked nowhere is a rule that rots: the
 * usual failure is an English-only edit that leaves the translation quietly
 * describing an older plugin. This does not judge the prose — it holds the two
 * files to the same structure, which is what drifts first.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name: string): string => readFileSync(join(root, name), 'utf8')
const english = read('README.md')
const chinese = read('README.zh.md')

/** Heading levels in document order; the prose differs, the skeleton must not. */
const headingLevels = (markdown: string): number[] =>
  [...markdown.matchAll(/^(#{1,6}) /gm)].map(match => (match[1] ?? '').length)

/**
 * Fenced code blocks with trailing comments stripped. The commands a reader
 * copies must be identical; the comment explaining one is prose, and belongs
 * in the reader's language. A `#` with no space before it — the `#auth=`
 * fragment of a pairing link — is part of a URL, not a comment.
 */
const codeBlocks = (markdown: string): string[] =>
  [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)]
    .map(match => (match[1] ?? '').replace(/[ \t]+#.*$/gm, '').trimEnd())

/** Table rows, so a row added to one table is not missed in the other. */
const tableRowCount = (markdown: string): number =>
  markdown.split('\n').filter(line => line.startsWith('| ')).length

describe('the README translation pair', () => {
  it('has the same heading skeleton', () => {
    expect(headingLevels(chinese)).toEqual(headingLevels(english))
  })

  it('carries identical commands, whatever language their comments are in', () => {
    expect(codeBlocks(chinese)).toEqual(codeBlocks(english))
  })

  it('documents the same number of table rows', () => {
    expect(tableRowCount(chinese)).toBe(tableRowCount(english))
  })

  it('links to its counterpart', () => {
    expect(english).toContain('[简体中文](README.zh.md)')
    expect(chinese).toContain('[English](README.md)')
  })

  it('names the published package, not the old one', () => {
    for (const [name, body] of [['README.md', english], ['README.zh.md', chinese]] as const) {
      expect([name, body.includes('@koalafacts/deepseek-harness-lanyard')]).toEqual([name, true])
      expect([name, /@koalafacts\/lanyard[^-]/.test(body)]).toEqual([name, false])
    }
  })
})
