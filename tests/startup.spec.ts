/**
 * The command-line provider: the flag family it accepts, and the usage errors
 * it still raises. Whether an all-interfaces bind may proceed is the carrier's
 * decision, not this provider's — see `gated-webserver.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { Command } from 'commander'
import { resolveStartupValues, webCommand, type WebStartupValues } from '../src/startup.ts'
import { DEFAULT_NETWORK_PORT } from '../src/webserver.ts'

/**
 * Parse one invocation the way `parseCmdline` does, without a launcher.
 * @param argv - the inner arguments, as `dsh` hands them to the app.
 * @returns the published values, or the usage error commander raised.
 */
function parse(argv: string[]): WebStartupValues | Error {
  const program: Command = webCommand().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  let values: WebStartupValues | undefined
  program.action(() => { values = resolveStartupValues(program) })
  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    return error as Error
  }
  if (values === undefined) throw new Error('the action published nothing')
  return values
}

describe('the lanyard web command line', () => {
  it('publishes the stock flag family unchanged', () => {
    expect(parse(['--host', '127.0.0.1', '--port', '8080'])).toEqual({
      host: '127.0.0.1', port: 8080, trustedHosts: [], openBrowser: true,
    })
  })

  it('publishes nothing when the invocation named no flags but the defaults', () => {
    expect(parse([])).toEqual({ trustedHosts: [], openBrowser: true })
  })

  it('carries the shipped --no-open flag, which replacing the row must not drop', () => {
    // The consuming row defaults openBrowser to true, so a provider that
    // omitted the field would disable this flag without any error.
    expect(parse(['--no-open'])).toEqual({ trustedHosts: [], openBrowser: false })
  })

  it('accepts the all-interfaces bind upstream refuses', () => {
    // This is the whole point of replacing the stock provider: upstream calls
    // program.error() here. What makes the bind safe — upstream's session on
    // every request, and TLS, which the carrier insists on — is not a flag.
    expect(parse(['--host', '0.0.0.0'])).toEqual({ host: '0.0.0.0', trustedHosts: [], openBrowser: true })
  })

  it('accepts --trusted-host, in argument order, as the row it replaces does', () => {
    // The flag declares an authority for dsh-client-connection's Host fence,
    // which is what a loopback bind behind a tunnel or reverse proxy needs.
    expect(parse(['--trusted-host', 'app.internal', 'app2.internal']))
      .toEqual({ trustedHosts: ['app.internal', 'app2.internal'], openBrowser: true })
  })

  it.each([
    'https://dsh.example',
    'https://dsh.example/',
    'https://dsh.example/ui/',
    'https://dsh.example/café/',
    'https://dsh.example/a"b/',
    'https://dsh.example/a<b>/',
    'https://dsh.example/a`b/',
    'https://dsh.example/a{b}/',
    'https://dsh.example/a^b/',
    'https://dsh.example/a%5Eb/',
    'https://dsh.example/café/a^b/',
    'https://dsh.example/café/a"b/',
    'https://dsh.example/文档/📱/',
    'https://dsh.example/العربية/',
    'https://dsh.example/caf%C3%A9/',
    'https://dsh.example/👩‍💻/',
    'https://dsh.example//',
    'http://localhost:3080/',
    'https://[::1]:3443/',
  ])('accepts an absolute --public-url base, including supported path prefixes: %s', (url) => {
    expect(parse(['--public-url', url])).toMatchObject({ publicUrl: url })
  })

  it.each([
    'https://dsh.example/workspace/..',
    'https://dsh.example/café/..',
    'https://dsh.example/a"b/%2e%2e/',
    'https://dsh.example/a^b/..',
    'https://dsh.example/a^b/%2e%2e/',
    'https://dsh.example/a%5Eb/%2e%2e/',
    'https://dsh.example/a<b>\\other',
    'https://dsh.example/café/%2e%2e/',
    'https://dsh.example/café\\other',
    'https://dsh.example/%2e/',
    'https://dsh.example\\\\other',
    'https://dsh.example?token=1',
    'https://user@dsh.example/',
  ])('rejects a rewritten or unsafe --public-url %s', (url) => {
    expect(String(parse(['--public-url', url]))).toContain('--public-url must be an absolute HTTP(S) root')
  })

  it.each([
    ['NEXT LINE', '\u0085'],
    ['non-breaking space', '\u00a0'],
    ['em space', '\u2003'],
    ['line separator', '\u2028'],
    ['ideographic space', '\u3000'],
    ['byte-order mark', '\uFEFF'],
    ['zero-width space', '\u200B'],
    ['word joiner', '\u2060'],
    ['Arabic letter mark', '\u061C'],
    ['left-to-right mark', '\u200E'],
    ['right-to-left mark', '\u200F'],
    ['right-to-left override', '\u202E'],
    ['left-to-right isolate', '\u2066'],
    ['pop directional isolate', '\u2069'],
  ])('refuses raw Unicode whitespace, invisible separators or bidi controls in --public-url (%s)', (_label, whitespace) => {
    expect(String(parse(['--public-url', `https://dsh.example/café/a${whitespace}b/`])))
      .toContain('--public-url must be an absolute HTTP(S) root')
  })

  it('refuses a non-numeric port', () => {
    expect(String(parse(['--port', '80a']))).toMatch(/--port must be a number/)
  })

  it.each([
    ['--port', '65536'],
    ['--network-port', '65536'],
    ['--port', '999999999999999999999999999999999999'],
    ['--network-port', '999999999999999999999999999999999999'],
  ])('rejects out-of-range %s %s before starting a listener', (flag, value) => {
    expect(String(parse([flag, value]))).toMatch(new RegExp(`${flag} must be an integer between 0 and 65535`))
  })

  it('preserves zero for OS-assigned ports and allows the highest TCP port', () => {
    expect(parse(['--port', '0', '--network-port', '0'])).toMatchObject({ port: 0, networkPort: 0 })
    expect(parse(['--port', '65535'])).toMatchObject({ port: 65535 })
    expect(parse(['--network-port', '65535'])).toMatchObject({ networkPort: 65535 })
  })

  it('carries --network-port through, and refuses a non-numeric one', () => {
    // The port devices on the network reach over TLS; `--port` stays this
    // machine's plaintext listener, exactly as the stock provider means it.
    expect(parse(['--host', '0.0.0.0', '--port', '3080', '--network-port', '8443'])).toEqual({
      host: '0.0.0.0', port: 3080, networkPort: 8443, trustedHosts: [], openBrowser: true,
    })
    expect(parse([])).not.toHaveProperty('networkPort')
    expect(String(parse(['--network-port', '84a']))).toMatch(/--network-port must be a number/)
  })

  it('carries --keep-awake through, and omits it when absent', () => {
    expect(parse(['--keep-awake'])).toEqual({ trustedHosts: [], openBrowser: true, keepAwake: true })
    expect(parse([])).not.toHaveProperty('keepAwake')
  })

  it('documents the network bind, its port, and --keep-awake in its help text', () => {
    // Commander wraps at the terminal width, so a phrase may span lines.
    let rendered = ''
    webCommand().configureOutput({ writeOut: text => { rendered += text } }).outputHelp()
    const help = rendered.replace(/\s+/g, ' ')
    expect(help).toContain('--keep-awake')
    expect(help).toContain('--network-port')
    expect(help).toContain('use this computer\'s assigned LAN IPv4 on the 0.2.1 line')
    expect(help).toContain('legacy 0.2.0 also accepts 0.0.0.0')
    expect(help).toContain('dsh --profile web --host 192.168.1.5')
    expect(help).toContain('dsh --profile web --host 192.168.1.5 --network-port 8443')
    // The CLI must not invite bearer-token QR use before TLS peer verification.
    expect(help).toContain('Open the printed token-free HTTPS address on the phone first.')
    expect(help).toContain('Verify the complete SHA-256 certificate fingerprint before opening any token-bearing link or scanning the QR code.')
    expect(help).toContain('If you cannot verify and trust the certificate, do not pair.')
    // The default the help names is the one the carrier applies.
    expect(help).toContain(`(default ${String(DEFAULT_NETWORK_PORT)})`)
  })
})
