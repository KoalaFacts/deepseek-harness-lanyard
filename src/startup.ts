/**
 * The `dsh --profile web` command-line provider, replacing the stock
 * `web-startup` row.
 *
 * Upstream refuses `--host 0.0.0.0` outright (`program.error`), and the reason
 * it gives — the bind would expose remote code execution to the network — is
 * one lanyard answers rather than ignores. Every request upstream serves now
 * requires its own browser session, minted from the launch token `dsh web`
 * prints; what the stock composition still lacks for a network bind is
 * transport security and a configuration plane that stays at the machine. The
 * gated carrier supplies both and refuses an all-interfaces bind without TLS
 * material, so this provider lifts the refusal and the carrier holds the line.
 *
 * It parses the same flag family as the stock provider so nothing else in the
 * composition changes: rows keep injecting `webStartup` and reading it from
 * lazy config. That contract is total — a shipped row reading a field this
 * provider does not publish would silently fall back to its schema default —
 * so `tests/webstartup-contract.spec.ts` checks it against the shipped
 * `@deepseek-ai/dsh-web-app` patch rather than against a copy of it.
 * @module
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

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
  /** `--no-open` inverted: whether to open the Web UI in the default browser. */
  openBrowser: boolean
  /** `--keep-awake`, absent when the invocation did not name it. */
  keepAwake?: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  /** Commander's `--no-open` counterpart: true unless the flag was passed. */
  open?: boolean
  port?: string
  trustedHost?: string[]
  keepAwake?: boolean
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI (lanyard: your own network, over TLS).')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host; 0.0.0.0 serves your network over TLS and prints a link to pair a device')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--keep-awake', 'hold the platform sleep inhibitor while dsh serves, so idle sleep cannot cut off sessions or paired devices')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           serve your network over TLS; scan the printed code to pair a phone
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
  // `--host 0.0.0.0` passes here on purpose; the carrier is where the bind is
  // refused unless TLS material came with it. Keeping the condition beside the
  // listener, not the flag, means a composition that configures the carrier
  // directly meets the same refusal.
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  return {
    // Always published, like the shipped provider: the consuming row's schema
    // defaults it to true, so omitting it would quietly disable `--no-open`.
    openBrowser: options.open ?? true,
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    trustedHosts: options.trustedHost ?? [],
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
