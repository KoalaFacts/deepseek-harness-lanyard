/**
 * `qrcode-terminal` ships no types. Only the one call this plugin makes is
 * declared, rather than a speculative transcription of the whole module.
 */
declare module 'qrcode-terminal' {
  interface GenerateOptions {
    /** Render with half-block characters, halving the height. */
    small?: boolean
  }
  const qrcodeTerminal: {
    /**
     * Render `text` as a QR code drawn with block characters.
     * @param text - the payload to encode.
     * @param options - rendering options.
     * @param callback - receives the rendered block.
     */
    generate: (text: string, options: GenerateOptions, callback: (rendered: string) => void) => void
  }
  export default qrcodeTerminal
}
