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

  it('refuses a non-numeric port', () => {
    expect(String(parse(['--port', '80a']))).toMatch(/--port must be a number/)
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
    const help = webCommand().helpInformation().replace(/\s+/g, ' ')
    expect(help).toContain('--keep-awake')
    expect(help).toContain('--network-port')
    expect(help).toContain('0.0.0.0 also serves your network over TLS')
    // The default the help names is the one the carrier applies.
    expect(help).toContain(`(default ${String(DEFAULT_NETWORK_PORT)})`)
  })
})
