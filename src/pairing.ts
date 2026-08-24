/**
 * The pairing surface: the browser half of the token exchange, and the line
 * that tells a person how to pair a device.
 *
 * The browser half is injected into the index document as an inline script (see
 * `./browser-auth.ts` for why that beats a client-plugin bundle here). The
 * pairing line is printed after the Loader settles, for the same reason the
 * shipped URL line is: it is a readiness signal, and a link to a server whose
 * `/api` owner has not mounted yet would be a lie.
 *
 * This row prints alongside the shipped `dsh web:` line rather than replacing
 * it — that line belongs to `@deepseek-ai/dsh-web-app`, which this plugin
 * deliberately leaves unmodified. The shipped line hardcodes `http://` and
 * omits the pairing fragment, so on a TLS deployment this row also names the
 * scheme actually being served.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import qrcodeTerminal from 'qrcode-terminal'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { injectPairingBootstrap } from './browser-auth.ts'
import { resolvePairingToken } from './credentials.ts'
import { AUTH_FRAGMENT_PARAM } from './admission.ts'

/**
 * The bind-dependent LAN snapshot `@deepseek-ai/dsh-web-app` provides. Read
 * structurally through `ctx.get` rather than through a Context augmentation:
 * this plugin does not import that bundle, and re-declaring its service key
 * would collide with its own declaration in any composition that does.
 */
interface WebRuntimeValues {
  /** LAN literals of the active bind; empty on a loopback bind. */
  lanAddresses: string[]
}

/** The scheme a gated carrier answers; the shipped carrier has no such member. */
interface SchemeAwareServer {
  scheme?: 'http' | 'https'
  port: number
  /** The port a remote device reaches; `port` is loopback-only under TLS. */
  networkPort?: number
}

/** Stable Cordis plugin name. */
export const name = 'lanyard-pairing'

/** The carrier this row taps, and the bind-dependent LAN snapshot it reuses. */
export const inject = ['webServer', 'webRuntime']

/** Plugin config: which token to publish, and whether to announce it. */
export interface Config {
  /** Credential reference holding the pairing token; absent leaves the deployment loopback-only. */
  pairingTokenEnv?: string
  /** A literal pairing token, for a composition with no credentials seam. */
  pairingToken?: string
  /** Print the pairing line once the tree has settled. */
  printPairingUrl: boolean
  /**
   * Draw the pairing link as a QR code beneath it. The link carries a 24-byte
   * token in its fragment, which is miserable to type on a phone keyboard;
   * scanning is the point of this plugin's whole workflow.
   */
  printPairingQr: boolean
}

export const Config: z<Config> = z.object({
  pairingTokenEnv: z.string(),
  pairingToken: z.string(),
  printPairingUrl: z.boolean().default(true),
  printPairingQr: z.boolean().default(true),
})

/** What the pairing line says for one bind, or undefined when there is nothing to pair. */
export interface PairingAnnouncement {
  /** Corrected local URL, present only when the shipped `dsh web:` line would name the wrong scheme. */
  local?: string
  /** The pairing link to open once on the other device. */
  pair?: string
}

/**
 * Light border a scanner needs around the code, in modules. Below this the
 * dark modules at the edge merge into a dark terminal background.
 */
const QUIET_ZONE_MODULES = 4

/**
 * Error correction for the code.
 *
 * `M` costs nothing over `L` at the length a pairing link actually reaches,
 * and buys tolerance for the glare and focus of a phone camera pointed at a
 * screen. `Q` and `H` are materially larger for redundancy this never needs:
 * the code is on a monitor, not printed on a crate.
 */
const ERROR_CORRECTION = 'M'

/** Terminal width assumed when stdout does not report a usable one. */
const ASSUMED_COLUMNS = 80

/**
 * The terminal width to lay the code out against.
 *
 * `process.stdout.columns` is not simply present-or-absent: a pty with no
 * window size set reports 0, which is not a narrow terminal but an unknown
 * one. Treating it as narrow refuses to print a code that would have fitted
 * perfectly well.
 * @param reported - `process.stdout.columns`, verbatim.
 */
export function terminalColumns(reported: number | undefined): number {
  return reported !== undefined && reported > 0 ? reported : ASSUMED_COLUMNS
}

/**
 * Bright white on black, held for the whole code.
 *
 * `qrcode-terminal` draws the LIGHT modules as block characters and leaves the
 * dark ones as background, which means it silently assumes a dark terminal: on
 * a light theme every module inverts, and a scanner that does not try both
 * polarities sees nothing. Pinning both colours makes the code render the same
 * way — and at full contrast — whatever theme it lands in.
 */
const LIGHT_ON_DARK = '\u001B[97;40m'
const RESET = '\u001B[0m'

/**
 * Surround the code with a light border, so it does not run into the terminal
 * background. Each character is two modules tall, hence the halved row count.
 * @param rendered - the raw block from the encoder.
 */
function withQuietZone(rendered: string): string {
  const rows = rendered.split('\n').filter(row => row.length > 0)
  const width = [...(rows[0] ?? '')].length
  const side = '█'.repeat(QUIET_ZONE_MODULES)
  const full = '█'.repeat(width + QUIET_ZONE_MODULES * 2)
  const border = Array.from({ length: QUIET_ZONE_MODULES / 2 }, () => full)
  return [...border, ...rows.map(row => `${side}${row}${side}`), ...border].join('\n')
}

/**
 * Width of a rendered block, in terminal columns.
 * @param rendered - a block, with or without escape codes.
 */
export function renderedWidth(rendered: string): number {
  const rows = rendered.replace(/\u001B\[[0-9;]*m/g, '').split('\n').filter(row => row.length > 0)
  return Math.max(0, ...rows.map(row => [...row].length))
}

/**
 * Whether a rendered code fits the terminal it is about to be printed to.
 *
 * A code wider than the terminal wraps, and a wrapped code is not a code — it
 * is noise that no camera will ever read. Better to print the link alone and
 * say so. The size follows the link's length, so a long host or an unusually
 * long token is what pushes it over.
 * @param rendered - the block about to be printed.
 * @param columns - the terminal width.
 */
export function fitsTerminal(rendered: string, columns: number): boolean {
  return renderedWidth(rendered) <= columns
}

/**
 * Render a pairing link as a QR code for the terminal.
 * @param link - the pairing URL to encode, token fragment included.
 * @param colour - emit ANSI colours; false honours `NO_COLOR`.
 * @returns the rendered block, drawn with half-height characters.
 */
export function renderPairingQr(link: string, colour = true): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.setErrorLevel(ERROR_CORRECTION)
    qrcodeTerminal.generate(link, { small: true }, (rendered: string) => {
      const bordered = withQuietZone(rendered)
      if (!colour) return resolve(bordered)
      resolve(bordered.split('\n').map(row => `${LIGHT_ON_DARK}${row}${RESET}`).join('\n'))
    })
  })
}

/**
 * Whether to draw the QR code: asked for, and somewhere it can be read.
 *
 * Block characters piped into a log file are noise, and nobody scans a log
 * file, so a non-terminal stdout skips it while the link itself still prints.
 * @param wanted - the configured `printPairingQr`.
 * @param isTerminal - whether stdout is a TTY.
 */
/**
 * Whether to emit ANSI colour, honouring `NO_COLOR`.
 *
 * https://no-color.org counts the variable as set only "when present and not an
 * empty string", and an empty one is what a shell writes for `NO_COLOR=`. A
 * bare presence check therefore declined colour for a caller who asked for
 * nothing — and declining is not neutral here: the encoder draws light modules
 * as block characters, so an uncoloured code inverts on a light terminal and a
 * scanner that does not try both polarities reads nothing.
 * @param value - the raw environment value, absent when unset.
 */
export function wantsColour(value: string | undefined): boolean {
  return value === undefined || value === ''
}

export function shouldDrawQr(wanted: boolean, isTerminal: boolean): boolean {
  return wanted && isTerminal
}

/**
 * Compose the pairing announcement for one bind.
 * @param scheme - the scheme the carrier actually answers.
 * @param port - the port clients reach.
 * @param lanAddress - the LAN literal to advertise, or undefined on a loopback bind.
 * @param token - the resolved pairing token, or undefined on a tokenless deployment.
 * @returns the lines worth printing; every field is absent when there is nothing to add.
 */
export function pairingAnnouncement(
  scheme: 'http' | 'https', port: number, lanAddress: string | undefined, token: string | undefined,
): PairingAnnouncement {
  return {
    // The shipped line hardcodes http://; naming the real scheme only helps
    // when it is not the one already printed.
    ...scheme === 'https' && { local: `${scheme}://127.0.0.1:${String(port)}` },
    ...lanAddress !== undefined && token !== undefined
      && { pair: `${scheme}://${lanAddress}:${String(port)}/#${AUTH_FRAGMENT_PARAM}=${token}` },
  }
}

/**
 * Publish the browser half and announce the pairing link.
 * @param ctx - plugin context carrying the webServer and webRuntime services.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const token = config.pairingToken ?? await resolvePairingToken(ctx, config.pairingTokenEnv)
  // Without a token there is nothing for the browser half to adopt, and no
  // link to announce: the deployment serves loopback only.
  if (token === undefined) return
  ctx.effect(() => ctx.webServer.tapIndex(injectPairingBootstrap), 'lanyard: pairing bootstrap')
  if (!config.printPairingUrl) return
  const runtime = ctx.get('webRuntime') as WebRuntimeValues | undefined
  const lanAddress = runtime?.lanAddresses[0]
  const announce = async (): Promise<void> => {
    // `port` is what a loopback http client uses, which under TLS is the
    // inherited plaintext listener — not somewhere a phone can reach. A gated
    // carrier reports the reachable one separately; a shipped carrier has no
    // such member and its single port is both.
    const { scheme, port, networkPort } = ctx.webServer as unknown as SchemeAwareServer
    const lines = pairingAnnouncement(scheme ?? 'http', networkPort ?? port, lanAddress, token)
    if (lines.local !== undefined) console.log(`lanyard: serving TLS — the local URL is ${lines.local}`)
    if (lines.pair === undefined) return
    console.log(`lanyard: pair a device by opening ${lines.pair} once`)
    if (!shouldDrawQr(config.printPairingQr, process.stdout.isTTY === true)) return
    // https://no-color.org — an explicit request not to emit escape codes.
    const code = await renderPairingQr(lines.pair, wantsColour(process.env.NO_COLOR))
    const columns = terminalColumns(process.stdout.columns)
    if (!fitsTerminal(code, columns)) {
      console.log(`lanyard: the code needs ${String(renderedWidth(code))} columns and this terminal has ${String(columns)}, so open the link above instead`)
      return
    }
    // Its own block, so the code has clear space above and below it rather
    // than butting against whatever the boot printed either side.
    console.log(`\nlanyard: or scan this with the phone\n\n${code}\n`)
  }
  // Same readiness contract as the shipped URL line: wait for the Loader tree,
  // or print at once in a hand-built context that has no Loader.
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) {
    await announce()
    return
  }
  void settled.then(async () => {
    // The tree can be disposed while the boot was in flight (an early SIGTERM);
    // a pairing link for a dead server would only mislead.
    if (ctx.get('webServer') !== undefined) await announce()
    // Loader reports a failed boot; this row only stays quiet.
  }, () => {})
}
