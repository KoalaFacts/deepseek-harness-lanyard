/** The gated carrier over a real listener: admission, the privileged pin, and TLS. */
import { connect as tlsConnect } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { generate } from 'selfsigned'
import { GatedWebServer } from '../src/webserver.ts'
import { lanIpv4Addresses } from '../src/tls.ts'

const TOKEN = 'pairing-token_0123456789-ab'
const LAN = lanIpv4Addresses()[0]
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

/** A throwaway self-signed pair on disk, as the tls row would have produced. */
function certificateFiles(): { certPath: string; keyPath: string } {
  const pems = generate([{ name: 'commonName', value: 'dsh' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...lanIpv4Addresses().map(ip => ({ type: 7 as const, ip })),
      ],
    }],
  })
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  writeFileSync(certPath, pems.cert)
  writeFileSync(keyPath, pems.private)
  return { certPath, keyPath }
}

/** One HTTPS GET against the gated carrier, accepting its self-signed certificate. */
function get(host: string, port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const rq = httpsRequest({ host, port, path, method: 'GET', headers, rejectUnauthorized: false },
      (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0) }) })
    rq.on('error', reject); rq.end()
  })
}

/** The response facts a wrapped handler wrote. */
interface Written { status: number; body: string }

/** A response double recording what the gate (or the inner handler) wrote. */
function response(): ServerResponse & Written {
  const written: Written = { status: 0, body: '' }
  return {
    writeHead(status: number) { written.status = status; return this },
    end(body?: string) { written.body = body ?? '' },
    get status() { return written.status },
    get body() { return written.body },
  } as unknown as ServerResponse & Written
}

/** A request whose socket peer the kernel would have filled in. */
function req(url: string, remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

describe('GatedWebServer', () => {
  it('serves TLS and gates an unmodified consumer\'s routes on the pairing token', async () => {
    const { certPath, keyPath } = certificateFiles()
    ctx = new Context()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, pairingToken: TOKEN, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    // Exactly what dsh-client-connection does, unmodified.
    server.register({ kind: 'prefix', path: '/api', handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })
    // The shell must load before a token exists.
    server.register({ kind: 'prefix', path: '/plugins', handler: (_q, res) => { res.writeHead(200); res.end('BUNDLE') } })

    expect(server.scheme).toBe('https')
    const port = server.port

    // A loopback peer is exempt, so this leg only shows the listener is real
    // and routes reach their handlers; the network legs below carry the gate.
    expect(await get('127.0.0.1', port, '/plugins/x/client.js')).toBe(200)
    expect(await get('127.0.0.1', port, '/api/session.list')).toBe(200)
  })

  it('refuses an all-interfaces bind that carries no pairing token', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0 })
    await expect(fiber.await()).rejects.toThrow(/all-interfaces bind requires a pairing token/)
  })

  it('rejects a token that is too weak to guard network access', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: 'short' })
    await expect(fiber.await()).rejects.toThrow(/at least 16 characters/)
  })

  it('refuses a token configured two ways at once', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, pairingToken: TOKEN, pairingTokenEnv: 'DSH_PAIRING_TOKEN',
    })
    await expect(fiber.await()).rejects.toThrow(/either pairingTokenEnv or pairingToken, not both/)
  })

  it('refuses TLS material configured by halves', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: '/tmp/cert.pem' })
    await expect(fiber.await()).rejects.toThrow(/must be configured together/)
  })

  it('resolves the pairing token through the credentials seam before it binds', async () => {
    ctx = new Context()
    ctx.provide('credentials', {
      resolve: (ref: string) => Promise.resolve(ref === 'DSH_PAIRING_TOKEN' ? { value: TOKEN, source: 'env' } : undefined),
    })
    await ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0, pairingTokenEnv: 'DSH_PAIRING_TOKEN' }).await()
    const server = ctx.get('webServer') as GatedWebServer
    expect(server.host).toBe('0.0.0.0')
    // Plain HTTP without TLS material: the gate does not depend on the certificate.
    expect(server.scheme).toBe('http')
  })

  it('fails the load when the configured reference holds no value', async () => {
    ctx = new Context()
    ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) })
    const fiber = ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0, pairingTokenEnv: 'DSH_PAIRING_TOKEN' })
    await expect(fiber.await()).rejects.toThrow(/holds no value/)
  })
})

describe('GatedWebServer admission over a non-loopback peer', () => {
  /**
   * The handler the gate wrapped around one consumer registration. Captured at
   * the seam the whole design rests on: `GatedWebServer.register` must hand
   * `WebServer.register` a handler that has already decided admission.
   */
  async function gatedHandler(path: string, kind: WebRoute['kind'] = 'prefix'): Promise<WebRoute['handler']> {
    const captured: WebRoute[] = []
    const spy = vi.spyOn(WebServer.prototype, 'register').mockImplementation((route: WebRoute) => {
      captured.push(route)
      return () => {}
    })
    ctx = new Context()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN }).await()
    const server = ctx.get('webServer') as GatedWebServer
    server.register({ kind, path, handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })
    spy.mockRestore()
    const route = captured.at(-1)
    if (route === undefined) throw new Error('the gate never reached WebServer.register')
    return route.handler
  }

  it('refuses an anonymous LAN peer and admits one presenting the token', async () => {
    const handler = await gatedHandler('/api')
    const anonymous = response()
    await handler(req('/api/session.list', '192.168.1.5'), anonymous)
    expect([anonymous.status, anonymous.body]).toEqual([403, 'forbidden'])

    for (const headers of [{ cookie: `dsh_auth=${TOKEN}` }, { authorization: `Bearer ${TOKEN}` }]) {
      const paired = response()
      await handler(req('/api/session.list', '192.168.1.5', headers), paired)
      expect([headers, paired.status, paired.body]).toEqual([headers, 200, 'REACHED'])
    }
  })

  it('keeps the configuration plane at the machine even for a paired device', async () => {
    const handler = await gatedHandler('/api')
    for (const endpoint of ['settings.update', 'credentials.set', 'dynamicCordisRunner/invoke']) {
      const paired = response()
      await handler(req(`/api/${endpoint}`, '192.168.1.5', { cookie: `dsh_auth=${TOKEN}` }), paired)
      expect([endpoint, paired.status]).toEqual([endpoint, 403])
      const local = response()
      await handler(req(`/api/${endpoint}`, '127.0.0.1'), local)
      expect([endpoint, local.status]).toEqual([endpoint, 200])
    }
  })

  it('serves the client bundle anonymously but never its source map', async () => {
    const handler = await gatedHandler('/plugins')
    const bundle = response()
    await handler(req('/plugins/ui-theme/client.js', '192.168.1.5'), bundle)
    expect([bundle.status, bundle.body]).toEqual([200, 'REACHED'])

    // sourcemap: true ships the full client source beside every bundle; the
    // shell needs the bundle to boot, never the map.
    const map = response()
    await handler(req('/plugins/ui-theme/client.js.map', '192.168.1.5'), map)
    expect(map.status).toBe(403)

    const pairedMap = response()
    await handler(req('/plugins/ui-theme/client.js.map', '192.168.1.5', { cookie: `dsh_auth=${TOKEN}` }), pairedMap)
    expect(pairedMap.status).toBe(200)
  })

  it('keeps the uncapped dev reload channel off the network entirely', async () => {
    // /plugins/events has no admission of its own and holds a connection open
    // until its client closes; a paired device gains nothing from it and could
    // exhaust the process's sockets with it.
    const handler = await gatedHandler('/plugins/events', 'exact')
    const paired = response()
    await handler(req('/plugins/events', '192.168.1.5', { cookie: `dsh_auth=${TOKEN}` }), paired)
    expect(paired.status).toBe(403)
    const local = response()
    await handler(req('/plugins/events', '127.0.0.1'), local)
    expect(local.status).toBe(200)
  })

  it('refuses an upgrade handshake before protocol negotiation', async () => {
    const captured: { handler: (req: IncomingMessage, socket: unknown, head: Buffer) => unknown }[] = []
    const spy = vi.spyOn(WebServer.prototype, 'registerUpgrade').mockImplementation((route) => {
      captured.push(route as (typeof captured)[number])
      return () => {}
    })
    ctx = new Context()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN }).await()
    const server = ctx.get('webServer') as GatedWebServer
    let negotiated = false
    server.registerUpgrade({ path: '/api/events', handler: () => { negotiated = true } })
    spy.mockRestore()

    const written: string[] = []
    let destroyed = false
    const socket = { write: (chunk: string) => written.push(chunk), destroy: () => { destroyed = true } }
    captured[0]?.handler(req('/api/events', '192.168.1.5'), socket, Buffer.alloc(0))
    expect([written[0], destroyed, negotiated]).toEqual(['HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', true, false])
  })
})

// The whole gate depends on the decrypted socket keeping the underlying
// connection's peer address: a TCP-forwarding proxy in this seat would make
// every request read as loopback and silently admit the entire LAN.
describe.skipIf(LAN === undefined)('GatedWebServer over TLS from a real LAN peer', () => {
  it('carries the real peer address through TLS termination', async () => {
    const lan = LAN as string
    const { certPath, keyPath } = certificateFiles()
    ctx = new Context()
    await ctx.plugin(GatedWebServer, {
      host: '0.0.0.0', port: 0, pairingToken: TOKEN, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    let seenPeer: string | undefined
    server.register({
      kind: 'prefix',
      path: '/api',
      handler: (request, res) => { seenPeer = request.socket.remoteAddress; res.writeHead(200); res.end('REACHED') },
    })

    expect(await get(lan, server.port, '/api/session.list')).toBe(403)
    expect(seenPeer).toBeUndefined()
    expect(await get(lan, server.port, '/api/session.list', { cookie: `dsh_auth=${TOKEN}` })).toBe(200)
    expect(seenPeer).toBe(lan)
  })

  it('answers the same port over TLS only', async () => {
    const lan = LAN as string
    const { certPath, keyPath } = certificateFiles()
    ctx = new Context()
    await ctx.plugin(GatedWebServer, {
      host: '0.0.0.0', port: 0, pairingToken: TOKEN, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    const negotiated = await new Promise<string | false>((resolve, reject) => {
      const socket = tlsConnect({ host: lan, port: server.port, rejectUnauthorized: false }, () => {
        const protocol = socket.getProtocol()
        socket.destroy()
        resolve(protocol ?? false)
      })
      socket.on('error', reject)
    })
    expect(negotiated).toMatch(/^TLSv1/)
  })
})
