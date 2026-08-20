/** The pairing line and the index tap that makes the link work. */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { pairingAnnouncement, type Config as PairingConfig } from '../src/pairing.ts'
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
