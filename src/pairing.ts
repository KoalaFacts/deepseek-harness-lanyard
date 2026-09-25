/**
 * The pairing line: the link, and its QR code, that a person opens once on the
 * phone.
 *
 * Pairing is upstream's own exchange. `dsh-client-connection` (0.1.2 and
 * later) mints a launch token per process, and a browser that opens the root
 * URL carrying it is redirected with a signed session cookie bound to the
 * authority it used — so a device keeps its session across restarts until
 * the cookie expires. What upstream cannot print is a link a phone can use:
 * its own `dsh web:` line names the plaintext loopback listener, and under TLS
 * its LAN address pairs that port with the machine's network address, which
 * nothing answers. This row asks the same connection for the link at the port
 * and scheme a device actually reaches.
 *
 * It prints alongside the shipped `dsh web:` line rather than replacing it —
 * that line belongs to `@deepseek-ai/dsh-web-app`, which this plugin
 * deliberately leaves unmodified — and after the Loader settles, for the same
 * reason that line does: it is a readiness signal, and a link to a server
 * whose `/api` owner has not mounted yet would be a lie.
 * @module
 */

import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import qrcodeTerminal from 'qrcode-terminal'
import type {} from '@deepseek-ai/dsh-host-webserver'

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

/**
 * The part of upstream's `ctx.connection` that issues pairing links, read
 * structurally for the same reason as {@link WebRuntimeValues}.
 */
export interface LaunchLinkIssuer {
  /**
   * @param baseUrl - the clean origin a device will open.
   * @returns the same origin's root, carrying this process's launch token.
   */
  authenticatedUrl: (baseUrl: string) => string
}

/** The scheme a gated carrier answers; the shipped carrier has no such member. */
interface SchemeAwareServer {
  scheme?: 'http' | 'https'
  port: number
  /** The port a remote device reaches; `port` is this machine's loopback listener. */
  networkPort?: number
  /** SHA-256 fingerprint of the certificate the TLS front presents. */
  certificateFingerprint?: string
}

/** Stable Cordis plugin name. */
export const name = 'lanyard-pairing'

/**
 * The carrier this row reads the reachable port from, the bind-dependent LAN
 * snapshot it announces, and the connection that issues the link.
 */
export const inject = ['webServer', 'webRuntime', 'connection']

/** Plugin config: whether to announce the pairing link, and how. */
export interface Config {
  /** Print the pairing line once the tree has settled. */
  printPairingUrl: boolean
  /**
   * Draw the pairing link as a QR code beneath it. The link carries a 43-character
   * launch token, which is miserable to type on a phone keyboard; scanning is
   * the point of this plugin's whole workflow.
   */
  printPairingQr: boolean
}

export const Config: z<Config> = z.object({
  printPairingUrl: z.boolean().default(true),
  printPairingQr: z.boolean().default(true),
})

/**
 * Whether a service can issue pairing links. A connection that predates
 * upstream's browser authentication cannot, and neither can whatever a rename
 * upstream leaves behind.
 * @param candidate - `ctx.connection`, whatever it holds.
 */
export function isLaunchLinkIssuer(candidate: unknown): candidate is LaunchLinkIssuer {
  return typeof (candidate as Partial<LaunchLinkIssuer> | undefined)?.authenticatedUrl === 'function'
}

/**
 * The pairing link for one bind.
 * @param issuer - upstream's connection, which owns the launch token.
 * @param scheme - the scheme the carrier actually answers.
 * @param port - the port a device on the network reaches.
 * @param lanAddress - the LAN literal to advertise, or undefined on a loopback bind.
 * @returns the link, or undefined when there is no network address to pair over.
 */
export function pairingLink(
  issuer: LaunchLinkIssuer, scheme: 'http' | 'https', port: number, lanAddress: string | undefined,
): string | undefined {
  if (lanAddress === undefined) return undefined
  return issuer.authenticatedUrl(`${scheme}://${lanAddress}:${String(port)}/`)
}

/**
 * Interfaces a phone can never share: container and virtual-machine bridges,
 * which exist only inside this machine. Their addresses rank last, are never
 * offered as an alternative link, and never become the pairing address.
 *
 * Linux names them by lowercase prefix, and macOS puts its virtual-machine NAT
 * on `bridge100` and up (`bridge0` is Thunderbolt Bridge, a real link, and
 * stays physical). Matched case-sensitively, so `veth` does not swallow
 * Windows's `vEthernet`.
 */
const MACHINE_INTERNAL_INTERFACE = /^(?:docker|br-|veth|virbr|lxc|lxd|incus|podman|cni|flannel|cali|cilium|weave|vboxnet|vmnet|bridge1\d\d)/

/**
 * Windows's friendly names for the same thing. Only the NAT switches are
 * named: an external Hyper-V switch is also a `vEthernet (…)` adapter, but it
 * carries the machine's real LAN address, so a name this pattern does not know
 * stays physical rather than hiding the one network a phone can join.
 */
const MACHINE_INTERNAL_ADAPTER = /virtualbox|vmware|^vEthernet \((?:WSL|Default Switch|DockerNAT)/i

/**
 * Overlay networks — VPNs and mesh tunnels. A phone on the same overlay can
 * reach them, so they are offered, but after the network the machine is
 * physically on. The unanchored names are Windows adapters ("ZeroTier One
 * [8056c2e21c000001]", "OpenVPN Wintun").
 */
const OVERLAY_INTERFACE = /^(utun|tun|tap|wg|zt|tailscale|ipsec|ppp)|zerotier|openvpn|wireguard|wintun|nordlynx/i

/** How likely an IPv4 literal is to be the home network a phone shares: lower is likelier. */
function rangeRank(address: string): number {
  const [first, second] = address.split('.').map(Number) as [number, number]
  if (first === 192 && second === 168) return 0
  if (first === 10) return 1
  if (first === 172 && second >= 16 && second <= 31) return 2
  // Link-local means no DHCP server answered: the least likely to be shared.
  if (first === 169 && second === 254) return 4
  return 3
}

/** Where an address sits: on the machine's own network, an overlay, or a bridge inside the machine. */
type InterfaceKind = 'physical' | 'overlay' | 'machine-internal'

function interfaceKind(name: string | undefined): InterfaceKind {
  if (name !== undefined && (MACHINE_INTERNAL_INTERFACE.test(name) || MACHINE_INTERNAL_ADAPTER.test(name))) return 'machine-internal'
  if (name !== undefined && OVERLAY_INTERFACE.test(name)) return 'overlay'
  return 'physical'
}

const KIND_RANK: Record<InterfaceKind, number> = { 'physical': 0, 'overlay': 1, 'machine-internal': 2 }

/**
 * Test hooks for the machine's interfaces; production never mutates them. The
 * unit suite must not depend on which adapters the machine running it has.
 */
export const internals = { networkInterfaces }

/** The addresses a pairing link could name, the likeliest first, and which of them a phone could use at all. */
export interface RankedAddresses {
  /** Every address, the one to pair over first. */
  ranked: string[]
  /** The addresses worth offering a phone: everything but machine-internal bridges. */
  offered: string[]
}

/**
 * Order the LAN literals a pairing link could name, most likely reachable from
 * a phone first: the network the machine is physically on before overlays,
 * overlays before bridges that exist only inside the machine, home-network
 * ranges first within each, and interface order last.
 *
 * Upstream's snapshot lists every non-internal IPv4 in interface order, so on
 * a machine running containers or a VPN its first entry can be an address no
 * phone reaches — and the QR code names exactly one.
 * @param addresses - the LAN literals the Host fence trusts, from `webRuntime`.
 * @param interfaces - the machine's interfaces; this machine's by default.
 */
export function rankLanAddresses(
  addresses: readonly string[], interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): RankedAddresses {
  const nameOf = new Map<string, string>()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4') nameOf.set(entry.address, name)
  }
  const ranked = addresses
    .map((address, index) => ({ address, index, kind: interfaceKind(nameOf.get(address)), range: rangeRank(address) }))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.range - b.range || a.index - b.index)
  return {
    ranked: ranked.map(candidate => candidate.address),
    offered: ranked.filter(candidate => candidate.kind !== 'machine-internal').map(candidate => candidate.address),
  }
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
 * @param link - the pairing URL to encode, launch token included.
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
 * Announce the pairing link once the tree has settled.
 * @param ctx - plugin context carrying the webServer, webRuntime and connection services.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const issuer: unknown = ctx.get('connection')
  // Without upstream's browser authentication there is no session for a device
  // to hold, and the gate refuses every network peer it cannot vouch for. Fail
  // the load now rather than print a link that could never work.
  if (!isLaunchLinkIssuer(issuer)) {
    throw new Error(
      'lanyard: this dsh has no browser authentication to pair a device with; lanyard needs '
      + 'dsh 0.1.5-rc.3 or later, whose ctx.connection issues launch-token links',
    )
  }
  if (!config.printPairingUrl) return
  const runtime = ctx.get('webRuntime') as WebRuntimeValues | undefined
  const { ranked, offered } = rankLanAddresses(runtime?.lanAddresses ?? [], internals.networkInterfaces())
  // A loopback bind has no network address to pair over. A tunnelled device
  // (adb reverse, ssh -R) reaches it as a loopback peer and opens the shipped
  // `dsh web:` link like any local browser.
  if (ranked.length === 0) return
  // Only an address a phone could be on is worth a link and a code.
  const lanAddress = offered[0]
  const announce = async (): Promise<void> => {
    // `port` is this machine's plaintext listener, bound to loopback — not
    // somewhere a phone can reach; the gated carrier reports the TLS port as
    // `networkPort`. A shipped carrier has neither that nor a scheme, and is
    // refused just below.
    const { scheme = 'http', port, networkPort, certificateFingerprint } = ctx.webServer as unknown as SchemeAwareServer
    // A LAN address with a plaintext carrier means lanyard's is not the one
    // serving — say, upstream renamed the row this bundle disables — so the
    // network is meeting a carrier without this gate, over plaintext. A link
    // printed now would carry the launch token across it in the clear.
    if (scheme !== 'https') {
      ctx.logger.error(
        'lanyard: stop dsh now — it is serving your network without lanyard\'s TLS carrier or its gate. No pairing '
        + 'link is printed, since it would carry the launch token in the clear; the bundle needs updating for this dsh version',
      )
      return
    }
    // Every address is a bridge inside this machine — Wi-Fi off, say, with
    // Docker running. A code naming one would send the phone nowhere.
    if (lanAddress === undefined) {
      console.log(`lanyard: no network a phone can join — ${ranked.join(', ')} ${ranked.length === 1 ? 'is a container or virtual-machine bridge' : 'are container or virtual-machine bridges'} inside this machine; connect it to your Wi-Fi or Ethernet and restart dsh`)
      return
    }
    const reachable = networkPort ?? port
    const link = pairingLink(issuer, scheme, reachable, lanAddress)
    if (link === undefined) return
    // The shipped line's `(LAN: …)` link pairs the plaintext loopback port with
    // the LAN address and carries the launch token. Nothing answers it, so a
    // passive listener learns nothing — but whoever impersonated this machine
    // on the network would receive the token, so say not to open it.
    console.log(`lanyard: serving your network over TLS on port ${String(reachable)} — do not open the (LAN: …) link on the dsh web line: it is plain http and carries the launch token`)
    console.log(`lanyard: pair a device by opening ${link} once`)
    // The code names one address; a phone on another of this machine's
    // networks gets its own link rather than a guess to edit by hand.
    for (const alternative of offered.filter(address => address !== lanAddress)) {
      console.log(`lanyard: or, from a device on the ${alternative} network: ${String(pairingLink(issuer, scheme, reachable, alternative))}`)
    }
    // The certificate is self-signed, so the phone's warning is the only check
    // there is; this is what makes it a check rather than a formality.
    if (certificateFingerprint !== undefined) {
      console.log(`lanyard: the phone should show certificate SHA-256 ${certificateFingerprint} — if it ever shows another, do not continue`)
    }
    if (!shouldDrawQr(config.printPairingQr, process.stdout.isTTY === true)) return
    // https://no-color.org — an explicit request not to emit escape codes.
    const code = await renderPairingQr(link, wantsColour(process.env.NO_COLOR))
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
