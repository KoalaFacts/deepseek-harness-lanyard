/** The pairing line and the index tap that makes the link work. */
import jsQR from 'jsqr'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { pairingAnnouncement, renderPairingQr, shouldDrawQr, type Config as PairingConfig } from '../src/pairing.ts'
import * as Pairing from '../src/pairing.ts'
import { AUTH_COOKIE_NAME } from '../src/admission.ts'

const TOKEN = 'pairing-token_0123456789-ab'
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.restoreAllMocks() })

describe('pairingAnnouncement', () => {
  it('names the pairing link for a LAN bind serving TLS', () => {
    expect(pairingAnnouncement('https', 3080, '192.168.1.5', TOKEN)).toEqual({
      local: 'https://127.0.0.1:3080',
      pair: `https://192.168.1.5:3080/#auth=${TOKEN}`,
    })
  })

  it('says nothing on a loopback bind with no LAN address to advertise', () => {
    expect(pairingAnnouncement('http', 3080, undefined, TOKEN)).toEqual({})
  })

  it('says nothing without a token, because there is nothing to pair', () => {
    expect(pairingAnnouncement('https', 3080, '192.168.1.5', undefined)).toEqual({ local: 'https://127.0.0.1:3080' })
  })

  it('corrects the scheme only when the shipped line would be wrong', () => {
    // `@deepseek-ai/dsh-web-app` hardcodes http:// in its own URL line; naming
    // the real scheme only helps when TLS made that line inaccurate.
    expect(pairingAnnouncement('http', 3080, undefined, TOKEN).local).toBeUndefined()
    expect(pairingAnnouncement('https', 3080, undefined, TOKEN).local).toBe('https://127.0.0.1:3080')
  })
})

describe('the pairing QR code', () => {
  const link = 'https://192.168.1.5:3080/#auth=pairing-token_0123456789-ab'

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
    const other = link.replace('0123456789', '9876543210')
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

  it('fits an ordinary terminal', async () => {
    const rows = (await renderPairingQr(link, false)).split('\n').filter(row => row.trim() !== '')
    expect(rows.length).toBeLessThan(30)
    expect([...(rows[0] ?? '')].length).toBeLessThan(50)
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
  /** Mount the row over a real carrier, with the LAN snapshot web-app would have provided. */
  async function mount(config: Partial<PairingConfig>, lanAddresses: string[] = ['192.168.1.5']): Promise<string[]> {
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { printed.push(line) })
    ctx = new Context()
    ctx.provide('webRuntime', { lanAddresses, trustedHosts: lanAddresses })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    // Schemastery fills printPairingUrl from its default, as the Loader does.
    await ctx.plugin(Pairing, config as PairingConfig).await()
    return printed
  }

  it('taps the index so the shell adopts the token before its first /api request', async () => {
    await mount({ pairingToken: TOKEN })
    const server = ctx?.get('webServer') as WebServer
    const injected = server.applyIndexTaps('<html><head></head><body></body></html>')
    expect(injected).toContain('<script>')
    expect(injected).toContain(AUTH_COOKIE_NAME)
  })

  it('announces the pairing link once the tree has settled', async () => {
    const printed = await mount({ pairingToken: TOKEN })
    expect(printed).toEqual([`lanyard: pair a device by opening http://192.168.1.5:${String((ctx?.get('webServer') as WebServer).port)}/#auth=${TOKEN} once`])
  })

  it('stays silent, and taps nothing, on a deployment with no token', async () => {
    const printed = await mount({})
    const server = ctx?.get('webServer') as WebServer
    expect(server.applyIndexTaps('<html><head></head></html>')).toBe('<html><head></head></html>')
    expect(printed).toEqual([])
  })

  it('taps the index but prints nothing when the line is turned off', async () => {
    const printed = await mount({ pairingToken: TOKEN, printPairingUrl: false })
    const server = ctx?.get('webServer') as WebServer
    expect(server.applyIndexTaps('<html><head></head></html>')).toContain('<script>')
    expect(printed).toEqual([])
  })

  it('has no link to print on a loopback bind, but still publishes the browser half', async () => {
    // A tunnelled device (adb reverse, ssh -R) reaches this deployment as a
    // loopback peer and needs no token; there is simply no LAN link to show.
    const printed = await mount({ pairingToken: TOKEN }, [])
    const server = ctx?.get('webServer') as WebServer
    expect(server.applyIndexTaps('<html><head></head></html>')).toContain('<script>')
    expect(printed).toEqual([])
  })
})
