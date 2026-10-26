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

/**
 * A successfully executed plugin_manager/list_plugins response, as carried by
 * the real Agent's next model request. A generic tool message (including
 * permission denial or an error string) is not evidence of execution.
 *
 * The shipped tool returns a JSON object with entries, total and nextOffset.
 * The AI adapter may transport it as a string or one text content block.
 */
export function hasPluginListEntries(content: unknown): boolean {
  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > 8) return false
    if (typeof value === 'string') {
      try {
        return inspect(JSON.parse(value) as unknown, depth + 1)
      } catch {
        return false
      }
    }
    if (Array.isArray(value)) return value.length === 1 && inspect(value[0], depth + 1)
    if (value === null || typeof value !== 'object') return false
    if ('type' in value || 'content' in value) {
      if (value.type === 'text' && typeof value.text === 'string') return inspect(value.text, depth + 1)
      if ('content' in value) return inspect(value.content, depth + 1)
      return false
    }
    if (!('entries' in value) || !('total' in value) || !('nextOffset' in value)) return false
    const { entries, total, nextOffset } = value
    return Array.isArray(entries) && entries.length > 0
      && entries.every(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      && typeof total === 'number' && Number.isSafeInteger(total) && total >= entries.length
      && (nextOffset === null
        || (typeof nextOffset === 'number' && Number.isSafeInteger(nextOffset)
          && nextOffset >= entries.length && nextOffset < total))
  }
  return inspect(content, 0)
}
