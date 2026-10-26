/** Whether the browser fixture's tool result excludes plugin-list entries. */
export function hasNoPluginEntries(content: unknown): boolean {
  if (content === null || content === undefined
    || (typeof content !== 'string' && typeof content !== 'object')) return false

  const inspect = (value: unknown, depth: number): boolean => {
    // Malformed or excessively wrapped results cannot prove absence.
    if (depth > 32) return false
    if (typeof value === 'string') {
      const text = value.trim()
      if (/^[\[{\"]/.test(text)) {
        try {
          return inspect(JSON.parse(text) as unknown, depth + 1)
        } catch {
          return false
        }
      }
      // Providers may join text blocks. A JSON fragment after prose is not
      // plain text and cannot establish absence without a structured parse.
      if (/[{}\[\]]/.test(text)) return false
      return !text.includes('"entries"')
    }
    if (Array.isArray(value)) return value.every(item => inspect(item, depth + 1))
    if (value !== null && typeof value === 'object') {
      return !Object.hasOwn(value, 'entries')
        && Object.values(value).every(item => inspect(item, depth + 1))
    }
    return true
  }
  return inspect(content, 0)
}
