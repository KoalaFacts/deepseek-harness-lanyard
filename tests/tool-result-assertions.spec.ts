import { describe, expect, it } from 'vitest'
import { hasNoPluginEntries, hasPluginListEntries } from '../scripts/tool-result-assertions.ts'

const denial = 'the user rejected escalating this plugin management operation'

describe('plugin-list absence in a transported tool result', () => {
  it.each([
    ['plain denial', denial],
    ['object denial', { error: denial }],
    ['serialized denial', JSON.stringify({ error: denial })],
    ['text-block denial', [{ type: 'text', text: denial }]],
    ['unrelated key', { error: denial, entriesCount: 0 }],
  ])('accepts %s without weakening the separate denial-marker check', (_name, content) => {
    expect(hasNoPluginEntries(content)).toBe(true)
  })

  it.each([
    ['object entries', { error: denial, entries: [{ name: 'synthetic-plugin' }] }],
    ['serialized entries', JSON.stringify({ error: denial, entries: [{ name: 'synthetic-plugin' }] })],
    ['escaped property name', '{"error":"denied","\\u0065ntries":[]}'],
    ['nested serialized entries', { content: JSON.stringify({ entries: [] }) }],
    ['text-block entries', [{ type: 'text', text: JSON.stringify({ entries: [] }) }]],
    ['joined text blocks with escaped entries', denial + '\n{"\\u0065ntries":[{"name":"synthetic-plugin"}]}'],
    ['invalid JSON', '{"error":"' + denial + '","entries":'],
    ['missing result', undefined],
    ['null result', null],
  ])('does not certify absence for %s', (_name, content) => {
    expect(hasNoPluginEntries(content)).toBe(false)
  })
})

describe('plugin_manager list results after one-shot phone approval', () => {
  const listing = { entries: [{ entryId: 'shipped-tool', enabled: true }], total: 4, nextOffset: 1 }

  it.each([
    ['native object', listing],
    ['serialized JSON', JSON.stringify(listing)],
    ['transported text block', [{ type: 'text', text: JSON.stringify(listing) }]],
    ['double-encoded JSON', JSON.stringify(JSON.stringify(listing))],
  ])('recognizes a real-looking structured listing via %s', (_name, content) => {
    expect(hasPluginListEntries(content)).toBe(true)
  })

  it.each([
    ['denied by Host', denial],
    ['serialized denial', JSON.stringify({ error: denial })],
    ['empty list', { entries: [], total: 0, nextOffset: null }],
    ['unrelated tool payload', { ok: true }],
    ['missing pagination', { entries: [{}], total: 1 }],
    ['invalid count', { entries: [{}], total: 0, nextOffset: null }],
    ['invalid entry', { entries: ['pretend-plugin'], total: 1, nextOffset: null }],
    ['trailing JSON data', JSON.stringify(listing) + ' unexpected'],
    ['ambiguous joined text blocks', [{ type: 'text', text: JSON.stringify(listing) }, { type: 'text', text: denial }]],
    ['malformed JSON', '{"entries":'],
    ['no result', undefined],
  ])('refuses to treat %s as successful execution', (_name, content) => {
    expect(hasPluginListEntries(content)).toBe(false)
  })
})
