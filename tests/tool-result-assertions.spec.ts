import { describe, expect, it } from 'vitest'
import { hasNoPluginEntries } from '../scripts/tool-result-assertions.ts'

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
