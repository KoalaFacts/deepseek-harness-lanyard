/** The gated carrier over a real listener: admission, the privileged pin, and TLS. */
import { connect as tlsConnect } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { generate } from 'selfsigned'
import { assertRegistrarsWrapped, GatedWebServer, REFUSAL_BODY } from '../src/webserver.ts'
import type { Config } from '../src/webserver.ts'
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
    const port = server.networkPort

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
    expect([anonymous.status, anonymous.body]).toEqual([403, REFUSAL_BODY])

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

    // `end` carries the bytes and closes; `write` + `destroy` could drop them.
    // Recording both shows the refusal does not go out through the lossy pair.
    const ended: string[] = []
    const written: string[] = []
    let destroyed = false
    const socket = {
      end: (chunk: string) => ended.push(chunk),
      write: (chunk: string) => written.push(chunk),
      destroy: () => { destroyed = true },
    }
    captured[0]?.handler(req('/api/events', '192.168.1.5'), socket, Buffer.alloc(0))
    expect([ended[0]?.startsWith('HTTP/1.1 403 Forbidden'), ended[0]?.endsWith(REFUSAL_BODY), written.length, destroyed, negotiated])
      .toEqual([true, true, 0, false, false])
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

    expect(await get(lan, server.networkPort, '/api/session.list')).toBe(403)
    expect(seenPeer).toBeUndefined()
    expect(await get(lan, server.networkPort, '/api/session.list', { cookie: `dsh_auth=${TOKEN}` })).toBe(200)
    expect(seenPeer).toBe(lan)
  })

  it('reports a loopback port that answers plain http, and a network port that answers TLS', async () => {
    const { certPath, keyPath } = certificateFiles()
    ctx = new Context()
    await ctx.plugin(GatedWebServer, {
      host: '0.0.0.0', port: 0, pairingToken: TOKEN, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    // Distinct listeners: `port` is the inherited plaintext server, which every
    // consumer of that member builds `http://127.0.0.1:${port}` from, and
    // `networkPort` is the TLS front a paired device connects to. Reporting the
    // TLS port as `port` pointed the browser handoff at https over http.
    expect(server.port).not.toBe(server.networkPort)
    server.register({ kind: 'prefix', path: '/plugins', handler: (_q, res) => { res.writeHead(200); res.end('BUNDLE') } })
    const plain = await new Promise<number>((resolve, reject) => {
      const rq = httpRequest({ host: '127.0.0.1', port: server.port, path: '/plugins/x/client.js', method: 'GET' },
        (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0) }) })
      rq.on('error', reject); rq.end()
    })
    expect(plain).toBe(200)
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
      const socket = tlsConnect({ host: lan, port: server.networkPort, rejectUnauthorized: false }, () => {
        const protocol = socket.getProtocol()
        socket.destroy()
        resolve(protocol ?? false)
      })
      socket.on('error', reject)
    })
    expect(negotiated).toMatch(/^TLSv1/)
  })
})

// The fallback seat answers every request no named route matched — in the
// shipped Web composition that is dsh-host-frontend-static serving the built
// SPA. It is a third registration path, so overriding register/registerUpgrade
// alone left the whole frontend reachable from the LAN with no token.
describe('the fallback seat', () => {
  /** The handler the gate actually handed to `WebServer.registerFallback`. */
  async function gatedFallback(config: Partial<Config> = {}): Promise<WebRoute['handler']> {
    const captured: WebRoute['handler'][] = []
    const spy = vi.spyOn(WebServer.prototype, 'registerFallback')
      .mockImplementation((handler: WebRoute['handler']) => { captured.push(handler); return () => {} })
    ctx = new Context()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN, ...config }).await()
    const server = ctx.get('webServer') as GatedWebServer
    server.registerFallback((_q, res) => { res.writeHead(200); res.end('DIST') })
    spy.mockRestore()
    const handler = captured.at(-1)
    if (handler === undefined) throw new Error('the gate never reached WebServer.registerFallback')
    return handler
  }

  it('serves the built frontend to an anonymous LAN peer, so a first pairing load resolves', async () => {
    const handler = await gatedFallback()
    for (const path of ['/', '/assets/index-ClqxG24t.js', '/assets/vendor-CjyC-hUb.css']) {
      const anonymous = response()
      await handler(req(path, '192.168.1.5'), anonymous)
      expect([path, anonymous.status, anonymous.body]).toEqual([path, 200, 'DIST'])
    }
  })

  it('never lets a source map ride the public exemption, however it is spelled', async () => {
    const handler = await gatedFallback()
    // The literal, then the escape dsh-host-frontend-static decodes back to it.
    for (const path of ['/assets/index.js.map', '/assets/index.js.ma%70', '/assets/index.js%2Emap']) {
      const anonymous = response()
      await handler(req(path, '192.168.1.5'), anonymous)
      expect([path, anonymous.status, anonymous.body]).toEqual([path, 403, REFUSAL_BODY])
      const paired = response()
      await handler(req(path, '192.168.1.5', { cookie: `dsh_auth=${TOKEN}` }), paired)
      expect([path, paired.status]).toEqual([path, 200])
    }
  })

  it('denies a pathname whose escapes do not decode rather than letting it through', async () => {
    const handler = await gatedFallback()
    const malformed = response()
    await handler(req('/assets/%E0%A4%A.js', '192.168.1.5'), malformed)
    expect([malformed.status, malformed.body]).toEqual([403, REFUSAL_BODY])
  })

  it('gates the seat entirely when a deployment configures it that way', async () => {
    const handler = await gatedFallback({ fallbackAdmission: 'gated' })
    const anonymous = response()
    await handler(req('/assets/index.js', '192.168.1.5'), anonymous)
    expect([anonymous.status, anonymous.body]).toEqual([403, REFUSAL_BODY])
    const paired = response()
    await handler(req('/assets/index.js', '192.168.1.5', { cookie: `dsh_auth=${TOKEN}` }), paired)
    expect(paired.status).toBe(200)
  })

  it('pins the seat to this machine when a deployment configures it that way', async () => {
    const handler = await gatedFallback({ fallbackAdmission: 'loopback-only' })
    const paired = response()
    await handler(req('/assets/index.js', '192.168.1.5', { cookie: `dsh_auth=${TOKEN}` }), paired)
    expect([paired.status, paired.body]).toEqual([403, REFUSAL_BODY])
    const local = response()
    await handler(req('/assets/index.js', '127.0.0.1'), local)
    expect(local.status).toBe(200)
  })
})

// A percent-encoded suffix slipped the exclusion on the client-bundle prefix
// too: dsh-client-modules decodes the pathname before resolving a file.
describe('percent-encoded paths on a public route', () => {
  it('excludes a source map under the bundle prefix however it is spelled', async () => {
    for (const path of ['/plugins/ui-theme/client.js.map', '/plugins/ui-theme/client.js.ma%70']) {
      const captured: WebRoute[] = []
      const spy = vi.spyOn(WebServer.prototype, 'register')
        .mockImplementation((route: WebRoute) => { captured.push(route); return () => {} })
      ctx = new Context()
      await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN }).await()
      const server = ctx.get('webServer') as GatedWebServer
      server.register({ kind: 'prefix', path: '/plugins', handler: (_q, res) => { res.writeHead(200); res.end('BUNDLE') } })
      spy.mockRestore()
      const handler = captured.at(-1)?.handler
      if (handler === undefined) throw new Error('the gate never reached WebServer.register')
      const anonymous = response()
      await handler(req(path, '192.168.1.5'), anonymous)
      expect([path, anonymous.status, anonymous.body]).toEqual([path, 403, REFUSAL_BODY])
      await ctx.fiber.dispose(); ctx = undefined
    }
  })
})

// The guard whose absence is the reason the fallback seat went ungated: some of
// the seats wrapped looks exactly like all of them from inside this class.
describe('assertRegistrarsWrapped', () => {
  it('accepts the WebServer this plugin was written against', () => {
    expect(() => { assertRegistrarsWrapped() }).not.toThrow()
  })

  it('fails the load when the harness grows a registration seat this gate does not wrap', () => {
    class Grown {
      register(): void {}
      registerUpgrade(): void {}
      registerFallback(): void {}
      registerStream(): void {}
    }
    expect(() => { assertRegistrarsWrapped(Grown.prototype) })
      .toThrow(/"registerStream".*does not put behind admission/s)
  })
})
