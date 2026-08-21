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
 * Render a pairing link as a QR code for the terminal.
 * @param link - the pairing URL to encode, token fragment included.
 * @returns the rendered block, drawn with half-height characters.
 */
export function renderPairingQr(link: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(link, { small: true }, (rendered: string) => { resolve(rendered) })
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
    const { scheme, port } = ctx.webServer as unknown as SchemeAwareServer
    const lines = pairingAnnouncement(scheme ?? 'http', port, lanAddress, token)
    if (lines.local !== undefined) console.log(`lanyard: serving TLS — the local URL is ${lines.local}`)
    if (lines.pair === undefined) return
    console.log(`lanyard: pair a device by opening ${lines.pair} once`)
    if (!shouldDrawQr(config.printPairingQr, process.stdout.isTTY === true)) return
    console.log('lanyard: or scan this with the phone')
    console.log(await renderPairingQr(lines.pair))
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
