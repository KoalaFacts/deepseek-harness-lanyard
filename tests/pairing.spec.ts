/** The pairing link, its QR code, and the row that announces them. */
import jsQR from 'jsqr'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  fitsTerminal, isLaunchLinkIssuer, pairingLink, rankLanAddresses, renderPairingQr, renderedWidth, shouldDrawQr,
  terminalColumns, type Config as PairingConfig, type LaunchLinkIssuer, wantsColour,
} from '../src/pairing.ts'
import * as Pairing from '../src/pairing.ts'

/** A launch token of the length upstream mints: 32 random bytes, base64url. */
const LAUNCH_TOKEN = 'nWXNEOWudT5Vfz4m2-h1bY2lU-pBvOB2oHCufgtaH2E'
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.restoreAllMocks() })

/** Upstream's link issuer as a stand-in; the real one is exercised in `upstream-session.spec.ts`. */
const issuer: LaunchLinkIssuer = {
  authenticatedUrl: (baseUrl: string) => `${baseUrl}?token=${LAUNCH_TOKEN}`,
}

describe('pairingLink', () => {
  it('asks upstream for the link at the scheme and port a device reaches', () => {
    expect(pairingLink(issuer, 'https', 3080, '192.168.1.5')).toBe(`https://192.168.1.5:3080/?token=${LAUNCH_TOKEN}`)
  })

  it('hands upstream the clean origin root, so the token is upstream\'s to add', () => {
    const asked: string[] = []
    pairingLink({ authenticatedUrl: (baseUrl) => { asked.push(baseUrl); return baseUrl } }, 'https', 3080, '192.168.1.5')
    expect(asked).toEqual(['https://192.168.1.5:3080/'])
  })

  it('has no link on a loopback bind with no LAN address to advertise', () => {
    expect(pairingLink(issuer, 'http', 3080, undefined)).toBeUndefined()
  })
})

describe('rankLanAddresses', () => {
  /** A machine's interfaces as node reports them, from name → IPv4 literal. */
  function interfaces(table: Record<string, string>): Parameters<typeof rankLanAddresses>[1] {
    return Object.fromEntries(Object.entries(table).map(([name, address]) => [name, [{
      address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`,
    }]])) as Parameters<typeof rankLanAddresses>[1]
  }

  // Each rule is checked where the others point the other way, so a ranking
  // that ignored it could not pass on the strength of the rest.

  it('puts the network the machine is on ahead of a container bridge, whatever their ranges', () => {
    // Upstream lists interfaces in the order the OS reports them, and a bridge
    // routinely comes first — minikube's even sits in 192.168: the code would
    // name an address no phone reaches.
    const machine = interfaces({ 'br-5f2': '192.168.49.1', 'en0': '10.1.2.3' })
    expect(rankLanAddresses(['192.168.49.1', '10.1.2.3'], machine)).toEqual({
      ranked: ['10.1.2.3', '192.168.49.1'], offered: ['10.1.2.3'],
    })
  })

  it('offers an overlay after the physical network, even in a likelier range', () => {
    // WireGuard subnets are routinely 192.168.x; ranked on range alone, the
    // tunnel would win over the network the machine is physically on.
    const machine = interfaces({ wg0: '192.168.100.2', eth0: '10.0.0.5' })
    expect(rankLanAddresses(['192.168.100.2', '10.0.0.5'], machine)).toEqual({
      ranked: ['10.0.0.5', '192.168.100.2'], offered: ['10.0.0.5', '192.168.100.2'],
    })
  })

  it('recognises the names Windows and macOS give the same adapters', () => {
    // VirtualBox's host-only network sits in 192.168 on every Windows machine
    // that has it installed; ranked as physical, the code would name it.
    expect(rankLanAddresses(['192.168.56.1', '10.0.0.5'], interfaces({
      'VirtualBox Host-Only Network': '192.168.56.1', 'Wi-Fi': '10.0.0.5',
    }))).toEqual({ ranked: ['10.0.0.5', '192.168.56.1'], offered: ['10.0.0.5'] })
    expect(rankLanAddresses(['192.168.191.5', '10.1.1.2'], interfaces({
      'ZeroTier One [8056c2e21c000001]': '192.168.191.5', 'Ethernet': '10.1.1.2',
    }))).toEqual({ ranked: ['10.1.1.2', '192.168.191.5'], offered: ['10.1.1.2', '192.168.191.5'] })
    // macOS puts virtual-machine NAT on bridge100 and up.
    expect(rankLanAddresses(['192.168.64.1', '10.0.1.7'], interfaces({ bridge100: '192.168.64.1', en0: '10.0.1.7' })))
      .toEqual({ ranked: ['10.0.1.7', '192.168.64.1'], offered: ['10.0.1.7'] })
  })

  it('ranks an overlay a phone can join ahead of a bridge it never can', () => {
    const machine = interfaces({ docker0: '172.17.0.1', tailscale0: '100.101.102.103' })
    expect(rankLanAddresses(['172.17.0.1', '100.101.102.103'], machine)).toEqual({
      ranked: ['100.101.102.103', '172.17.0.1'], offered: ['100.101.102.103'],
    })
  })

  it('prefers home-network ranges among physical interfaces, then keeps interface order', () => {
    const machine = interfaces({ eth1: '203.0.113.9', eth0: '10.0.0.5', wlan0: '192.168.1.5', eth2: '10.0.0.6' })
    expect(rankLanAddresses(['203.0.113.9', '10.0.0.5', '192.168.1.5', '10.0.0.6'], machine).ranked)
      .toEqual(['192.168.1.5', '10.0.0.5', '10.0.0.6', '203.0.113.9'])
  })

  it('treats an address it cannot place as the machine\'s own network, and link-local as a last resort', () => {
    expect(rankLanAddresses(['169.254.3.4', '203.0.113.9'], interfaces({})).ranked).toEqual(['203.0.113.9', '169.254.3.4'])
  })
})

describe('isLaunchLinkIssuer', () => {
  it('recognises a connection that issues launch-token links, and nothing else', () => {
    expect(isLaunchLinkIssuer(issuer)).toBe(true)
    for (const candidate of [undefined, {}, { authenticatedUrl: 'x' }, { requestRejection: () => undefined }]) {
      expect([candidate, isLaunchLinkIssuer(candidate)]).toEqual([candidate, false])
    }
  })
})

describe('the pairing QR code', () => {
  const link = `https://192.168.1.5:3080/?token=${LAUNCH_TOKEN}`

  /**
   * Decode a rendered block the way a phone camera would.
   *
   * Two things this must not do. Describing the block ("looks square, uses
   * block characters") would pass for something no camera can read. And
   * decoding with inversion enabled would accept a code whose polarity is
   * backwards — which is what the encoder emits unaided, since it draws the
   * LIGHT modules as block characters and assumes a dark terminal. So the
   * colours this plugin actually prints are applied here, and inversion is
   * refused.
   */
  function decode(rendered: string): string | undefined {
    // Block characters are painted bright white by the emitted escape codes,
    // the background black; strip the codes and honour that mapping.
    const rows = rendered.replace(/\u001B\[[0-9;]*m/g, '').split('\n').filter(row => row.length > 0)
    // Every character carries two vertically stacked modules.
    const modules = rows.flatMap((row) => {
      const top: boolean[] = []
      const bottom: boolean[] = []
      for (const character of row) {
        top.push(character === '█' || character === '▀')
        bottom.push(character === '█' || character === '▄')
      }
      return [top, bottom]
    })
    const height = modules.length
    const width = modules[0]?.length ?? 0
    const scale = 4
    const pixels = new Uint8ClampedArray(width * scale * height * scale * 4)
    for (let y = 0; y < height * scale; y++) {
      for (let x = 0; x < width * scale; x++) {
        // A block character is a LIGHT module (white); a space is dark.
        const lightModule = modules[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true
        const value = lightModule ? 255 : 0
        const at = (y * width * scale + x) * 4
        pixels[at] = value
        pixels[at + 1] = value
        pixels[at + 2] = value
        pixels[at + 3] = 255
      }
    }
    return jsQR(pixels, width * scale, height * scale, { inversionAttempts: 'dontInvert' })?.data
  }

  it('decodes back to the exact pairing link', async () => {
    // The whole feature is "the phone scans it and lands on the paired URL".
    expect(decode(await renderPairingQr(link))).toBe(link)
  })

  it('carries the token, so a scan pairs rather than just opening the GUI', async () => {
    const other = link.replace('nWXNEOWud', 'dUWOENXWn')
    expect(decode(await renderPairingQr(other))).toBe(other)
  })

  it('pins the colours that make the polarity right in any terminal', async () => {
    // The decode above proves the LAYOUT: block characters are the light
    // modules. It cannot prove what a terminal paints them, because stripping
    // the escape codes and assuming that mapping would pass whether or not the
    // codes were emitted. So the contract is asserted directly: block
    // characters must be painted bright white (light modules) and the
    // background black (dark modules). Without this the encoder's own output
    // inverts on a light theme.
    const rows = (await renderPairingQr(link)).split('\n')
    expect(rows.every(row => row.startsWith('\u001B[97;40m') && row.endsWith('\u001B[0m'))).toBe(true)
  })

  it('emits no escape codes when colour is declined', async () => {
    expect(await renderPairingQr(link, false)).not.toContain('\u001B')
  })

  it('carries a light border, so it does not merge into the terminal', async () => {
    const rows = (await renderPairingQr(link, false)).split('\n').filter(row => row.length > 0)
    const first = rows[0] ?? ''
    // A full row of light modules, top and bottom, and the same at each side.
    expect([...first].every(character => character === '█')).toBe(true)
    expect(rows.every(row => row.startsWith('████') && row.endsWith('████'))).toBe(true)
  })

  it('fits an ordinary 80-column terminal at the length a real link reaches', async () => {
    // The size follows the link's length, so this is the property that keeps a
    // realistic deployment scannable rather than wrapped.
    const realistic = 'https://192.168.100.200:31080/?token=' + 'a'.repeat(43)
    const code = await renderPairingQr(realistic, false)
    expect(fitsTerminal(code, 80)).toBe(true)
    expect(code.split('\n').filter(row => row.length > 0).length).toBeLessThan(30)
  })

  it('measures its width ignoring the escape codes it is wrapped in', async () => {
    const coloured = await renderPairingQr(link)
    const plain = await renderPairingQr(link, false)
    // Counting escape codes as width would make every code look unfittable.
    expect(renderedWidth(coloured)).toBe(renderedWidth(plain))
  })

  it('treats an unreported terminal width as unknown, not as narrow', () => {
    // A pty with no window size reports 0. Reading that as a zero-column
    // terminal refuses every code, which a real boot under `script` showed.
    expect(terminalColumns(0)).toBe(80)
    expect(terminalColumns(undefined)).toBe(80)
    expect(terminalColumns(120)).toBe(120)
  })

  it('reports not fitting rather than printing a code that would wrap', async () => {
    const code = await renderPairingQr(link, false)
    expect(fitsTerminal(code, renderedWidth(code))).toBe(true)
    expect(fitsTerminal(code, renderedWidth(code) - 1)).toBe(false)
  })
})

describe('shouldDrawQr', () => {
  it('draws only where someone could scan it', () => {
    expect(shouldDrawQr(true, true)).toBe(true)
    // Block characters in a log file are noise, and nobody scans a log file.
    expect(shouldDrawQr(true, false)).toBe(false)
    expect(shouldDrawQr(false, true)).toBe(false)
  })
})

describe('the pairing row', () => {
  /**
   * Mount the row with the LAN snapshot web-app would have provided and the
   * connection upstream would have provided.
   * @param server - a real carrier by default; a stand-in reports a gated one's ports.
   */
  async function mount(
    config: Partial<PairingConfig>,
    { lanAddresses = ['192.168.1.5'], connection = issuer as unknown, server, onError }: {
      lanAddresses?: string[]
      connection?: unknown
      server?: { scheme: 'https'; port: number; networkPort: number; certificateFingerprint?: string }
      onError?: (line: string) => void
    } = {},
  ): Promise<string[]> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { printed.push(line) })
    ctx = new Context()
    if (onError !== undefined) vi.spyOn(ctx.logger, 'error').mockImplementation(((line: unknown) => { onError(String(line)) }) as never)
    ctx.provide('webRuntime', { lanAddresses, trustedHosts: lanAddresses })
    ctx.provide('connection', connection)
    if (server === undefined) await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    else ctx.provide('webServer', server)
    // Schemastery fills printPairingUrl from its default, as the Loader does.
    await ctx.plugin(Pairing, config as PairingConfig).await()
    return printed
  }

  it('never prints a pairing link a plaintext carrier would answer, and says to stop', async () => {
    // A LAN address beside a carrier with no TLS means lanyard's carrier is
    // not the one serving: the network meets no gate, and the link would carry
    // the launch token in the clear.
    const errors: string[] = []
    const printed = await mount({}, { onError: (line) => { errors.push(line) } })
    expect(printed).toEqual([])
    expect(errors).toEqual([expect.stringMatching(/^lanyard: stop dsh now .*without lanyard's TLS carrier.*in the clear/)])
  })

  it('names the TLS port a device reaches, never the loopback one, and the certificate to expect', async () => {
    // `port` is this machine's plaintext listener, bound to loopback; a link
    // naming it sends the phone to a port nothing on the network answers.
    const printed = await mount({}, { server: { scheme: 'https', port: 3080, networkPort: 3443, certificateFingerprint: 'AB:CD:EF' } })
    expect(printed).toEqual([
      'lanyard: serving your network over TLS on port 3443 — do not open the (LAN: …) link on the dsh web line: it is plain http and carries the launch token',
      `lanyard: pair a device by opening https://192.168.1.5:3443/?token=${LAUNCH_TOKEN} once`,
      'lanyard: the phone should show certificate SHA-256 AB:CD:EF — if it ever shows another, do not continue',
    ])
  })

  it('pairs over the likeliest address, and offers a link for each other one a phone could share', async () => {
    const printed = await mount({}, {
      lanAddresses: ['10.8.0.2', '192.168.1.5'],
      server: { scheme: 'https', port: 3080, networkPort: 3443, certificateFingerprint: 'AB:CD:EF' },
    })
    expect(printed.slice(1, 3)).toEqual([
      `lanyard: pair a device by opening https://192.168.1.5:3443/?token=${LAUNCH_TOKEN} once`,
      `lanyard: or, from a device on the 10.8.0.2 network: https://10.8.0.2:3443/?token=${LAUNCH_TOKEN}`,
    ])
  })

  it('fails the load on a dsh whose connection cannot issue pairing links', async () => {
    // A connection from before upstream's browser authentication: there is no
    // session to pair, and the gate refuses every network peer anyway.
    await expect(mount({}, { connection: { rpc: {} } })).rejects.toThrow(/no browser authentication to pair a device with.*dsh 0\.1\.5-rc\.3 or later/)
  })

  it('prints nothing when the line is turned off', async () => {
    expect(await mount({ printPairingUrl: false })).toEqual([])
  })

  it('has no link to print on a loopback bind', async () => {
    // A tunnelled device (adb reverse, ssh -R) reaches this deployment as a
    // loopback peer and opens the shipped dsh web link instead.
    expect(await mount({}, { lanAddresses: [] })).toEqual([])
  })
})

// https://no-color.org counts the variable as set only "when present and not an
// empty string". Declining colour is not neutral: the encoder draws light
// modules as block characters, so an uncoloured code inverts on a light
// terminal and a scanner that does not try both polarities reads nothing.
describe('wantsColour', () => {
  it('emits colour when NO_COLOR is unset', () => {
    expect(wantsColour(undefined)).toBe(true)
  })

  it('emits colour when NO_COLOR is present but empty, which `NO_COLOR=` sets', () => {
    expect(wantsColour('')).toBe(true)
  })

  it('declines colour for any non-empty value', () => {
    expect([wantsColour('1'), wantsColour('true'), wantsColour('0')]).toEqual([false, false, false])
  })
})
