/**
 * The `dsh --profile web` command-line provider, replacing the stock
 * `web-startup` row.
 *
 * Upstream refuses `--host 0.0.0.0` outright (`program.error`), for a good
 * reason: with no authentication an all-interfaces bind hands remote code
 * execution to the network. `lanyard` supplies that authentication, so this
 * provider lifts the refusal and replaces it with the condition that makes the
 * bind safe — an all-interfaces bind requires a pairing token.
 *
 * It parses the same flag family as the stock provider so nothing else in the
 * composition changes: rows keep injecting `webStartup` and reading it from
 * lazy config.
 * @module
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { PAIRING_TOKEN_REQUIREMENT } from './admission.ts'
import { GENERATE_TOKEN_HINT } from './credentials.ts'

/** Stable Cordis plugin name. */
export const name = 'lanyard-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** `--pairing-token-env`: the credential reference holding the pairing token. */
  pairingTokenEnv?: string
  /** `--keep-awake`, absent when the invocation did not name it. */
  keepAwake?: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  trustedHost?: string[]
  pairingTokenEnv?: string
  keepAwake?: boolean
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI (lanyard: LAN serving behind a pairing token).')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host; 0.0.0.0 serves the LAN and requires --pairing-token-env')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable; requires a pairing token)')
    .option('--pairing-token-env <name>', `name of the credential holding the pairing token every non-loopback client must present (${PAIRING_TOKEN_REQUIREMENT}); read from the environment, the credential store, or a .env layer`)
    .option('--keep-awake', 'hold the platform sleep inhibitor while dsh serves, so idle sleep cannot cut off sessions or paired devices')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
  DSH_PAIRING_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))") \\
    dsh --profile web --host 0.0.0.0 --pairing-token-env DSH_PAIRING_TOKEN
                                             serve the LAN over TLS behind the pairing token
`)
}

/**
 * Read one invocation's flags into the provided values, rejecting a usage error
 * through the program so commander owns the message and the exit code.
 * @param program - the parsed program, used for its `error` channel.
 * @returns the values to publish as {@link WEB_STARTUP_SERVICE}.
 */
export function resolveStartupValues(program: Command): WebStartupValues {
  const options = program.opts<WebOptions>()
  // The /api surface executes code as this process, so every path that admits a
  // non-loopback caller requires the pairing token. Only its reference travels
  // here; whether it resolves, and to a well-formed token, is settled where the
  // token is used.
  if (options.host === '0.0.0.0' && options.pairingTokenEnv === undefined) {
    program.error(`error: --host 0.0.0.0 exposes remote code execution to the network, so it requires --pairing-token-env; ${GENERATE_TOKEN_HINT}`)
  }
  if (options.trustedHost !== undefined && options.trustedHost.length > 0 && options.pairingTokenEnv === undefined) {
    program.error('error: --trusted-host requires a pairing token — without one no non-loopback request is admitted')
  }
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  return {
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    trustedHosts: options.trustedHost ?? [],
    ...options.pairingTokenEnv !== undefined && { pairingTokenEnv: options.pairingTokenEnv },
    ...options.keepAwake === true && { keepAwake: true },
  }
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. On a
 * rejected invocation (and on `--help`) nothing is provided, so no server binds.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    ctx.provide(WEB_STARTUP_SERVICE, resolveStartupValues(program))
  })
  parseCmdline(ctx, program)
}
