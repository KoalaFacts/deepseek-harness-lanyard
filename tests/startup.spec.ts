/**
 * The command-line provider: the flag family it accepts, and the usage errors
 * that keep an unauthenticated network bind from ever happening.
 */
import { describe, expect, it } from 'vitest'
import type { Command } from 'commander'
import { resolveStartupValues, webCommand, type WebStartupValues } from '../src/startup.ts'

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

  it('accepts the all-interfaces bind upstream refuses, given a pairing token', () => {
    // This is the whole point of replacing the stock provider: upstream calls
    // program.error() here, because without authentication the bind hands
    // remote code execution to the network.
    expect(parse(['--host', '0.0.0.0', '--pairing-token-env', 'DSH_PAIRING_TOKEN'])).toEqual({
      host: '0.0.0.0', trustedHosts: [], openBrowser: true, pairingTokenEnv: 'DSH_PAIRING_TOKEN',
    })
  })

  it('still refuses an all-interfaces bind with no pairing token', () => {
    expect(parse(['--host', '0.0.0.0'])).toBeInstanceOf(Error)
    expect(String(parse(['--host', '0.0.0.0']))).toMatch(/requires --pairing-token-env/)
  })

  it('accepts --trusted-host without a pairing token, as the row it replaces does', () => {
    // The flag declares an authority for dsh-client-connection's Host fence,
    // which is what a loopback bind behind a tunnel or reverse proxy needs.
    // That peer reads as loopback here and is admitted either way, so demanding
    // a token refused a working stock invocation and protected nothing.
    expect(parse(['--trusted-host', 'app.internal']))
      .toEqual({ trustedHosts: ['app.internal'], openBrowser: true })
  })

  it('accepts --trusted-host alongside a token, in argument order', () => {
    expect(parse([
      '--pairing-token-env', 'DSH_PAIRING_TOKEN',
      '--trusted-host', 'app.internal', 'app2.internal',
    ])).toEqual({
      trustedHosts: ['app.internal', 'app2.internal'], openBrowser: true, pairingTokenEnv: 'DSH_PAIRING_TOKEN',
    })
  })

  it('refuses a non-numeric port', () => {
    expect(String(parse(['--port', '80a']))).toMatch(/--port must be a number/)
  })

  it('carries --keep-awake through, and omits it when absent', () => {
    expect(parse(['--keep-awake'])).toEqual({ trustedHosts: [], openBrowser: true, keepAwake: true })
    expect(parse([])).not.toHaveProperty('keepAwake')
  })

  it('documents the pairing flags in its help text', () => {
    const help = webCommand().helpInformation()
    expect(help).toContain('--pairing-token-env')
    expect(help).toContain('--keep-awake')
    expect(help).toContain('at least 16 characters of A-Za-z0-9_-')
  })
})
