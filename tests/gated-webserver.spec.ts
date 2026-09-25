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

const SESSION = 'dsh-auth-test=v1.valid'
const LAN = lanIpv4Addresses()[0]
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.restoreAllMocks() })

/**
 * A context with upstream's connection stood in for: exactly one cookie is a
 * session. The real one is exercised in `upstream-session.spec.ts`.
 */
function withSession(): Context {
  const context = new Context()
  context.provide('connection', {
    requestRejection: (request: IncomingMessage) => request.headers.cookie === SESSION ? undefined : 401,
  })
  return context
}

/** A throwaway self-signed pair on disk, as the tls row would have produced. */
function certificateFiles(): { certPath: string; keyPath: string; ca: string } {
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
  return { certPath, keyPath, ca: pems.cert }
}

/** One HTTPS GET against the gated carrier, validated against its own certificate. */
function get(host: string, port: number, path: string, headers: Record<string, string> = {}, ca?: string):
Promise<{ status: number; encoding: string | undefined }> {
  return new Promise((resolve, reject) => {
    const rq = httpsRequest({ host, port, path, method: 'GET', headers, ...ca !== undefined && { ca } }, (res) => {
      res.resume()
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, encoding: res.headers['content-encoding'] }) })
    })
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
  it('serves TLS and hands a loopback peer to an unmodified consumer\'s routes', async () => {
    const { certPath, keyPath, ca } = certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath }).await()
    const server = ctx.get('webServer') as GatedWebServer
    // Exactly what dsh-client-connection does, unmodified.
    server.register({ kind: 'prefix', path: '/api', handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })

    expect(server.scheme).toBe('https')
    // A loopback peer is exempt, so this leg only shows the listener is real
    // and routes reach their handlers; the network legs below carry the gate.
    expect((await get('127.0.0.1', server.networkPort, '/api/session/list', {}, ca)).status).toBe(200)
  })

  it('refuses an all-interfaces bind that has no TLS material', async () => {
    // The launch token and the session cookie are what authenticate a device;
    // over plaintext, anyone on the network could read either.
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0 })
    await expect(fiber.await()).rejects.toThrow(/all-interfaces bind requires TLS material/)
  })

  it('refuses TLS material configured by halves', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: '/tmp/cert.pem' })
    await expect(fiber.await()).rejects.toThrow(/must be configured together/)
  })

  it('passes the inherited carrier\'s own fields through, compression included', async () => {
    // The TLS branch rebuilds the config it hands `super`, which is exactly
    // where a field upstream added — gzip for the Web profile — got dropped.
    const { certPath, keyPath, ca } = certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, compression: 'gzip',
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    server.register({
      kind: 'exact',
      path: '/large',
      handler: (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(8192)) },
    })
    const answer = await get('127.0.0.1', server.networkPort, '/large', { 'accept-encoding': 'gzip' }, ca)
    expect(answer).toEqual({ status: 200, encoding: 'gzip' })
  })

  it('validates the inherited carrier\'s fields exactly as the stock carrier does', async () => {
    // The schema composes upstream's own, so a value the stock row would refuse
    // is refused here too rather than reaching the inherited constructor.
    for (const Carrier of [WebServer, GatedWebServer]) {
      ctx = new Context()
      const fiber = ctx.plugin(Carrier, { host: '127.0.0.1', port: 0, compressionLevel: 12 })
      await expect(fiber.await()).rejects.toThrow(/compressionLevel expected number <= 9/)
      await ctx.fiber.dispose(); ctx = undefined
    }
  })
})

describe('GatedWebServer admission over a non-loopback peer', () => {
  /**
   * The handler the gate wrapped around one consumer registration. Captured at
   * the seam the whole design rests on: `GatedWebServer.register` must hand
   * `WebServer.register` a handler that has already decided admission.
   */
  async function gatedHandler(path: string, kind: WebRoute['kind'] = 'prefix', context = withSession()):
  Promise<WebRoute['handler']> {
    const captured: WebRoute[] = []
    const spy = vi.spyOn(WebServer.prototype, 'register').mockImplementation((route: WebRoute) => {
      captured.push(route)
      return () => {}
    })
    ctx = context
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0 }).await()
    const server = ctx.get('webServer') as GatedWebServer
    server.register({ kind, path, handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })
    spy.mockRestore()
    const route = captured.at(-1)
    if (route === undefined) throw new Error('the gate never reached WebServer.register')
    return route.handler
  }

  it('refuses an anonymous LAN peer and admits one upstream\'s session vouches for', async () => {
    const handler = await gatedHandler('/api')
    const anonymous = response()
    await handler(req('/api/session/list', '192.168.1.5'), anonymous)
    expect([anonymous.status, anonymous.body]).toEqual([403, REFUSAL_BODY])

    const paired = response()
    await handler(req('/api/session/list', '192.168.1.5', { cookie: SESSION }), paired)
    expect([paired.status, paired.body]).toEqual([200, 'REACHED'])
  })

  it('refuses every LAN peer while no connection is mounted to vouch for it', async () => {
    // Connection mounts after the carrier and can be disposed before it; in
    // between, and in a composition without it, the network gets nothing.
    const handler = await gatedHandler('/api', 'prefix', new Context())
    const paired = response()
    await handler(req('/api/session/list', '192.168.1.5', { cookie: SESSION }), paired)
    expect([paired.status, paired.body]).toEqual([403, REFUSAL_BODY])
    const local = response()
    await handler(req('/api/session/list', '127.0.0.1'), local)
    expect(local.status).toBe(200)
  })

  it('refuses a LAN peer when the connection predates upstream\'s browser authentication', async () => {
    const context = new Context()
    context.provide('connection', { rpc: {}, fetch: {} })
    const handler = await gatedHandler('/api', 'prefix', context)
    const paired = response()
    await handler(req('/api/session/list', '192.168.1.5', { cookie: SESSION }), paired)
    expect([paired.status, paired.body]).toEqual([403, REFUSAL_BODY])
  })

  it('keeps the configuration plane at the machine even for a paired device', async () => {
    const handler = await gatedHandler('/api')
    for (const endpoint of ['settings/update', 'credentials/set', 'dynamicCordisRunner/invoke', 'session/openWorkspacePath']) {
      const paired = response()
      await handler(req(`/api/${endpoint}`, '192.168.1.5', { cookie: SESSION }), paired)
      expect([endpoint, paired.status]).toEqual([endpoint, 403])
      const local = response()
      await handler(req(`/api/${endpoint}`, '127.0.0.1'), local)
      expect([endpoint, local.status]).toEqual([endpoint, 200])
    }
  })

  it('pins a method however its separator is spelled', async () => {
    // Upstream rejects a `%` in an endpoint today; one that starts decoding
    // would read `%2F` as the separator, so both readings are classified.
    const handler = await gatedHandler('/api')
    const paired = response()
    await handler(req('/api/session%2FopenWorkspacePath', '192.168.1.5', { cookie: SESSION }), paired)
    expect([paired.status, paired.body]).toEqual([403, REFUSAL_BODY])
  })

  it('serves the client bundles only to a device holding a session', async () => {
    // The session cookie is set on the redirect before the first page load, so
    // nothing the loaded page fetches needs an anonymous exemption any more.
    const handler = await gatedHandler('/plugins')
    const anonymous = response()
    await handler(req('/plugins/ui-theme/client.js', '192.168.1.5'), anonymous)
    expect([anonymous.status, anonymous.body]).toEqual([403, REFUSAL_BODY])
    for (const path of ['/plugins/ui-theme/client.js', '/plugins/ui-theme/client.js.map']) {
      const paired = response()
      await handler(req(path, '192.168.1.5', { cookie: SESSION }), paired)
      expect([path, paired.status]).toEqual([path, 200])
    }
  })

  it('keeps the dev reload channel and the desktop opener off the network entirely', async () => {
    // /plugins/events has no admission of its own and holds a connection open
    // until its client closes; /open-in-app/open launches an application on
    // this machine's desktop. A paired device gains nothing from either.
    for (const path of ['/plugins/events', '/open-in-app/open']) {
      const handler = await gatedHandler(path, 'exact')
      const paired = response()
      await handler(req(path, '192.168.1.5', { cookie: SESSION }), paired)
      expect([path, paired.status]).toEqual([path, 403])
      const local = response()
      await handler(req(path, '127.0.0.1'), local)
      expect([path, local.status]).toEqual([path, 200])
      await ctx?.fiber.dispose(); ctx = undefined
    }
  })

  it('refuses an upgrade handshake before protocol negotiation', async () => {
    const captured: { handler: (req: IncomingMessage, socket: unknown, head: Buffer) => unknown }[] = []
    const spy = vi.spyOn(WebServer.prototype, 'registerUpgrade').mockImplementation((route) => {
      captured.push(route as (typeof captured)[number])
      return () => {}
    })
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0 }).await()
    const server = ctx.get('webServer') as GatedWebServer
    let negotiated = false
    server.registerUpgrade({ path: '/api/remote.mux', handler: () => { negotiated = true } })
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
    captured[0]?.handler(req('/api/remote.mux', '192.168.1.5'), socket, Buffer.alloc(0))
    expect([ended[0]?.startsWith('HTTP/1.1 403 Forbidden'), ended[0]?.endsWith(REFUSAL_BODY), written.length, destroyed, negotiated])
      .toEqual([true, true, 0, false, false])

    captured[0]?.handler(req('/api/remote.mux', '192.168.1.5', { cookie: SESSION }), socket, Buffer.alloc(0))
    expect(negotiated).toBe(true)
  })
})

// The whole gate depends on the decrypted socket keeping the underlying
// connection's peer address: a TCP-forwarding proxy in this seat would make
// every request read as loopback and silently lift the session requirement.
describe.skipIf(LAN === undefined)('GatedWebServer over TLS from a real LAN peer', () => {
  it('carries the real peer address through TLS termination', async () => {
    const lan = LAN as string
    const { certPath, keyPath, ca } = certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath }).await()
    const server = ctx.get('webServer') as GatedWebServer
    let seenPeer: string | undefined
    server.register({
      kind: 'prefix',
      path: '/api',
      handler: (request, res) => { seenPeer = request.socket.remoteAddress; res.writeHead(200); res.end('REACHED') },
    })

    expect((await get(lan, server.networkPort, '/api/session/list', {}, ca)).status).toBe(403)
    expect(seenPeer).toBeUndefined()
    expect((await get(lan, server.networkPort, '/api/session/list', { cookie: SESSION }, ca)).status).toBe(200)
    expect(seenPeer).toBe(lan)
  })

  it('reports a loopback port that answers plain http, and a network port that answers TLS', async () => {
    const { certPath, keyPath } = certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath }).await()
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
    const { certPath, keyPath, ca } = certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath }).await()
    const server = ctx.get('webServer') as GatedWebServer
    const negotiated = await new Promise<string | false>((resolve, reject) => {
      const socket = tlsConnect({ host: lan, port: server.networkPort, ca }, () => {
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
// alone once left the whole frontend reachable from the LAN.
describe('the fallback seat', () => {
  /** The handler the gate actually handed to `WebServer.registerFallback`. */
  async function gatedFallback(config: Partial<Config> = {}): Promise<WebRoute['handler']> {
    const captured: WebRoute['handler'][] = []
    const spy = vi.spyOn(WebServer.prototype, 'registerFallback')
      .mockImplementation((handler: WebRoute['handler']) => { captured.push(handler); return () => {} })
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, ...config }).await()
    const server = ctx.get('webServer') as GatedWebServer
    server.registerFallback((_q, res) => { res.writeHead(200); res.end('DIST') })
    spy.mockRestore()
    const handler = captured.at(-1)
    if (handler === undefined) throw new Error('the gate never reached WebServer.registerFallback')
    return handler
  }

  it('lets the pairing exchange and the built frontend through to a device holding no session yet', async () => {
    // Pairing is `GET /?token=…` from a device with nothing to present; the
    // seat's owner authenticates the index itself.
    const handler = await gatedFallback()
    for (const path of ['/?token=launch-token', '/', '/assets/index-ClqxG24t.js', '/assets/vendor-CjyC-hUb.css']) {
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
      await handler(req(path, '192.168.1.5', { cookie: SESSION }), paired)
      expect([path, paired.status]).toEqual([path, 200])
    }
  })

  it('denies a pathname whose escapes do not decode rather than letting it through', async () => {
    const handler = await gatedFallback()
    const malformed = response()
    await handler(req('/assets/%E0%A4%A.js', '192.168.1.5'), malformed)
    expect([malformed.status, malformed.body]).toEqual([403, REFUSAL_BODY])
  })

  it('closes pairing to new devices when a deployment gates the seat', async () => {
    const handler = await gatedFallback({ fallbackAdmission: 'gated' })
    for (const path of ['/?token=launch-token', '/assets/index.js']) {
      const anonymous = response()
      await handler(req(path, '192.168.1.5'), anonymous)
      expect([path, anonymous.status, anonymous.body]).toEqual([path, 403, REFUSAL_BODY])
    }
    const paired = response()
    await handler(req('/assets/index.js', '192.168.1.5', { cookie: SESSION }), paired)
    expect(paired.status).toBe(200)
  })

  it('pins the seat to this machine when a deployment configures it that way', async () => {
    const handler = await gatedFallback({ fallbackAdmission: 'loopback-only' })
    const paired = response()
    await handler(req('/assets/index.js', '192.168.1.5', { cookie: SESSION }), paired)
    expect([paired.status, paired.body]).toEqual([403, REFUSAL_BODY])
    const local = response()
    await handler(req('/assets/index.js', '127.0.0.1'), local)
    expect(local.status).toBe(200)
  })
})

// A percent-encoded suffix slipped the exclusion on a public route too: the
// handlers behind the gate decode the pathname before resolving a file.
describe('percent-encoded paths on a public route', () => {
  it('excludes a source map however it is spelled', async () => {
    for (const path of ['/bundles/ui-theme/client.js.map', '/bundles/ui-theme/client.js.ma%70']) {
      const captured: WebRoute[] = []
      const spy = vi.spyOn(WebServer.prototype, 'register')
        .mockImplementation((route: WebRoute) => { captured.push(route); return () => {} })
      ctx = withSession()
      await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, publicPaths: ['/bundles'] }).await()
      const server = ctx.get('webServer') as GatedWebServer
      server.register({ kind: 'prefix', path: '/bundles', handler: (_q, res) => { res.writeHead(200); res.end('BUNDLE') } })
      spy.mockRestore()
      const handler = captured.at(-1)?.handler
      if (handler === undefined) throw new Error('the gate never reached WebServer.register')
      const bundle = response()
      await handler(req('/bundles/ui-theme/client.js', '192.168.1.5'), bundle)
      expect(bundle.status).toBe(200)
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

  it('fails the load when an unwrapped seat sits on a base class rather than the prototype itself', () => {
    // Inspecting own properties only would call this clean: upstream moving a
    // seat down into a shared base is a reshuffle, not a removal, and the seat
    // is every bit as reachable from `ctx.webServer`.
    class Base { registerStream(): void {} }
    class Grown extends Base {
      register(): void {}
      registerUpgrade(): void {}
      registerFallback(): void {}
    }
    expect(() => { assertRegistrarsWrapped(Grown.prototype) })
      .toThrow(/"registerStream".*does not put behind admission/s)
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
