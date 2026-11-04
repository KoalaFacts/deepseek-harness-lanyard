/** The gated carrier over a real listener: admission, the privileged pin, and TLS. */
import { connect as tlsConnect } from 'node:tls'
import { connect as tcpConnect, createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type Config as WebServerConfig, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { generate } from 'selfsigned'
import { assertRegistrarsWrapped, GatedWebServer, REFUSAL_BODY } from '../src/webserver.ts'
import type { Config } from '../src/webserver.ts'
import { lanIpv4Addresses } from '../src/tls.ts'
import { freePort, networkBindHost } from '../scripts/dsh-harness.ts'

const SESSION = 'dsh-auth-test=v1.valid'
const LAN = lanIpv4Addresses()[0]

/**
 * Every field this plugin adds to the carrier's config. The compiler holds it
 * to the interface — a field added there without a line here fails typecheck —
 * so the schema is checked against the interface, not against itself.
 */
const OWN_FIELDS = {
  networkPort: true, tlsCertPath: true, tlsKeyPath: true, publicPaths: true, publicPathExcludedSuffixes: true,
  loopbackOnlyPaths: true, fallbackAdmission: true, apiPathPrefix: true, privilegedMethods: true,
  pairedNamespaces: true, pairedRoutes: true, tls: true,
} satisfies Record<Exclude<keyof Config, keyof WebServerConfig> | 'tls', true>
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
async function certificateFiles(): Promise<{ certPath: string; keyPath: string; ca: string }> {
  const pems = await generate([{ name: 'commonName', value: 'dsh' }], {
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

/** One plain-HTTP GET; rejects when nothing answers at that address. */
function plainGet(host: string, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const rq = httpRequest({ host, port, path, method: 'GET' }, (res) => {
      res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0) })
    })
    rq.on('error', reject); rq.end()
  })
}

/** Two distinct ports free right now. */
async function twoFreePorts(): Promise<[number, number]> {
  const first = await freePort()
  let second = await freePort()
  while (second === first) second = await freePort()
  return [first, second]
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
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0 }).await()
    const server = ctx.get('webServer') as GatedWebServer
    // Exactly what dsh-client-connection does, unmodified.
    server.register({ kind: 'prefix', path: '/api', handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })

    expect(server.scheme).toBe('https')
    // A loopback peer is exempt, so this leg only shows the listener is real
    // and routes reach their handlers; the network legs below carry the gate.
    expect((await get('127.0.0.1', server.networkPort, '/api/session/list', {}, ca)).status).toBe(200)
  })


  it('sends Fetch resource headers before the first slow body chunk over TLS', async () => {
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, networkPort: 0, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer

    let releaseChunk: () => void = () => {}
    const maySendChunk = new Promise<void>(resolve => { releaseChunk = resolve })
    server.register({
      kind: 'exact', path: '/slow-resource',
      resource: async () => new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await maySendChunk
          controller.enqueue(new TextEncoder().encode('streamed'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/plain' } }),
    })

    let notifyHeaders: () => void = () => {}
    const headersSeen = new Promise<void>(resolve => { notifyHeaders = resolve })
    let responseStatus: number | undefined
    const completed = new Promise<string>((resolve, reject) => {
      const client = httpsRequest({
        host: '127.0.0.1', port: server.networkPort, path: '/slow-resource', ca,
      }, (response) => {
        responseStatus = response.statusCode
        notifyHeaders()
        const chunks: Buffer[] = []
        response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
        response.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
        response.on('error', reject)
      })
      client.on('error', reject)
      client.end()
    })

    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      // A blocked body cannot be used to flush headers. This fails on the
      // prior adapter (writeHead without flushHeaders), even though a normal
      // static asset whose first chunk is ready immediately still passes.
      const arrived = await Promise.race([
        headersSeen.then(() => true),
        new Promise<boolean>(resolve => { deadline = setTimeout(() => { resolve(false) }, 1_500) }),
      ])
      expect(arrived).toBe(true)
      expect(responseStatus).toBe(200)
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      releaseChunk()
    }
    expect(await completed).toBe('streamed')
  })

  it.each(['lookup', 'await'] as const)(
    'keeps TLS listening when optional Loader %s throws before readiness',
    async (failurePoint) => {
      const { certPath, keyPath, ca } = await certificateFiles()
      ctx = withSession()
      const originalGet = ctx.get.bind(ctx)
      const secret = 'synthetic Loader diagnostic secret'
      const warnings: string[] = []
      vi.spyOn(ctx.logger, 'warn').mockImplementation(((value: unknown) => {
        warnings.push(String(value))
      }) as never)
      const lookup = vi.spyOn(ctx, 'get').mockImplementation(((key: string) => {
        if (key === 'loader') {
          if (failurePoint === 'lookup') throw new Error(secret)
          return { await: () => { throw new Error(secret) } }
        }
        return originalGet(key as never)
      }) as typeof ctx.get)
      try {
        await ctx.plugin(GatedWebServer, {
          host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0,
        }).await()
        const server = originalGet('webServer') as GatedWebServer
        server.register({
          kind: 'exact', path: '/readiness-check',
          handler: (_req, res) => { res.writeHead(200); res.end('ready') },
        })
        expect(server.scheme).toBe('https')
        expect((await get('127.0.0.1', server.networkPort, '/readiness-check', {}, ca)).status).toBe(200)
      } finally {
        lookup.mockRestore()
      }
      expect(warnings).toContain('lanyard: could not check DSH Loader readiness; unclaimed-route diagnostics unavailable for this startup')
      expect(warnings.join(' ')).not.toContain(secret)
    },
  )

  it('does not wait for a paired TLS socket or an incomplete handshake on shutdown', async () => {
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    const paired = tlsConnect({ host: '127.0.0.1', port: server.networkPort, ca })
    paired.on('error', () => {}) // Disposal intentionally disconnects active peers.
    let negotiating: ReturnType<typeof tcpConnect> | undefined
    let disposing: Promise<void> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        paired.once('secureConnect', resolve); paired.once('error', reject)
      })
      // A TCP client that sends no ClientHello tests the pre-handshake seat.
      negotiating = tcpConnect(server.networkPort, '127.0.0.1')
      negotiating.on('error', () => {})
      await new Promise<void>((resolve, reject) => {
        negotiating!.once('connect', resolve); negotiating!.once('error', reject)
      })
      disposing = ctx.fiber.dispose()
      const finished = await Promise.race([
        disposing.then(() => true),
        new Promise<boolean>(resolve => { deadline = setTimeout(() => { resolve(false) }, 1_500) }),
      ])
      expect(finished).toBe(true)
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      paired.destroy()
      negotiating?.destroy()
      await (disposing ?? ctx.fiber.dispose())
      ctx = undefined
    }
  })

  it('refuses a network bind that has no TLS material', async () => {
    // The launch token and the session cookie are what authenticate a device;
    // over plaintext, anyone on the network could read either.
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: networkBindHost('192.168.1.20'), port: 0 })
    await expect(fiber.await()).rejects.toThrow(/network bind requires TLS material/)
  })

  it('refuses an empty TLS bind host instead of selecting a wildcard listener', () => {
    ctx = new Context()
    // A direct caller can bypass CLI validation; even with valid TLS paths an
    // empty string must be rejected before node:net treats it as 0.0.0.0 / ::.
    expect(() => new GatedWebServer(ctx!, {
      host: '', port: 0, networkPort: 0,
      tlsCertPath: 'unused-cert.pem', tlsKeyPath: 'unused-key.pem',
    })).toThrow(/bind host must be a concrete IPv4 literal/)
  })

  it.each(['localhost', 'not-a-bind-address'])('refuses non-IP host %s even with TLS configured', (host) => {
    ctx = new Context()
    expect(() => new GatedWebServer(ctx!, {
      host, port: 0, networkPort: 0,
      tlsCertPath: 'unused-cert.pem', tlsKeyPath: 'unused-key.pem',
    })).toThrow(/bind host must be a concrete IPv4 literal/)
  })

  it('defaults an omitted direct TLS bind host to loopback, not wildcard', () => {
    ctx = new Context()
    const server = new GatedWebServer(ctx, {
      port: 0, networkPort: 0,
      tlsCertPath: 'unused-cert.pem', tlsKeyPath: 'unused-key.pem',
    } as Config)
    expect(server.host).toBe('127.0.0.1')
  })

  it('refuses a bind host it cannot serve, rather than quietly serving loopback under that name', async () => {
    // Neither carrier accepts an arbitrary hostname in place of its bind literal.
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: 'not-a-bind-address', port: 0 } as never)
    await expect(fiber.await()).rejects.toThrow(/host/)
  })

  it('refuses a network port that is this machine\'s port too', async () => {
    // Loopback on a port and every interface on the same one collide on Linux,
    // and one port cannot be both plaintext and TLS.
    const { certPath, keyPath } = await certificateFiles()
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 4080, networkPort: 4080, tlsCertPath: certPath, tlsKeyPath: keyPath,
    })
    await expect(fiber.await()).rejects.toThrow(/port and networkPort are both 4080/)
  })

  it('names the way out when the network port is already taken', async () => {
    const { certPath, keyPath } = await certificateFiles()
    const squatter = createTcpServer()
    await new Promise<void>((resolve) => { squatter.listen(0, '0.0.0.0', resolve) })
    const taken = (squatter.address() as AddressInfo).port
    try {
      ctx = withSession()
      const fiber = ctx.plugin(GatedWebServer, {
        host: '127.0.0.1', port: 0, networkPort: taken, tlsCertPath: certPath, tlsKeyPath: keyPath,
      })
      await expect(fiber.await()).rejects.toThrow(new RegExp(`port ${String(taken)} is already in use.*--network-port.*--host 127\\.0\\.0\\.1`, 's'))
    } finally {
      squatter.close()
    }
  })

  it('explains a stale or mistyped LAN IPv4 instead of silently serving another interface', async () => {
    // TEST-NET-1 is not a local interface on the CI hosts. A real bind must
    // fail with EADDRNOTAVAIL and name the operator's recovery action.
    const { certPath, keyPath } = await certificateFiles()
    ctx = withSession()
    const host = '192.0.2.254'
    const fiber = ctx.plugin(GatedWebServer, {
      host: networkBindHost(host), port: 0, networkPort: 0, tlsCertPath: certPath, tlsKeyPath: keyPath,
    })
    await expect(fiber.await()).rejects.toThrow(/192\.0\.2\.254.*not assigned.*--host.*local-only use/s)
  })

  it('refuses nonregular explicit TLS PEM paths without waiting for a FIFO writer', async () => {
    const { certPath, keyPath } = await certificateFiles()
    const nonregularDir = mkdtempSync(join(tmpdir(), 'lanyard-explicit-tls-'))
    const specialPaths = [nonregularDir]
    try {
      // Linux's node:fs/promises.readFile() blocks on this FIFO without a
      // writer; the production descriptor check must reject it first.
      if (process.platform === 'linux') {
        const pipe = join(nonregularDir, 'waiting.pipe')
        execFileSync('mkfifo', [pipe])
        specialPaths.push(pipe)
      }
      for (const special of specialPaths) {
        for (const kind of ['certificate', 'private key'] as const) {
          ctx = withSession()
          const fiber = ctx.plugin(GatedWebServer, {
            host: '127.0.0.1', port: 0, networkPort: 0,
            tlsCertPath: kind === 'certificate' ? special : certPath,
            tlsKeyPath: kind === 'private key' ? special : keyPath,
          })
          await expect(fiber.await()).rejects.toThrow(
            new RegExp(`TLS ${kind} must resolve to a regular file`),
          )
          await ctx.fiber.dispose(); ctx = undefined
        }
      }
    } finally {
      rmSync(nonregularDir, { recursive: true, force: true })
    }
  })

  it('refuses oversized operator-provided TLS PEMs without reading past 1 MiB', async () => {
    const { certPath, keyPath, ca } = await certificateFiles()
    const oversized = join(dirname(certPath), 'oversized.pem')
    for (const kind of ['certificate', 'private key'] as const) {
      // A valid PEM prefix plus surplus whitespace is closer to an accidental
      // oversize chain than random garbage; neither role may read it unbounded.
      const original = kind === 'certificate' ? ca : readFileSync(keyPath, 'utf8')
      writeFileSync(oversized, `${original}\n${' '.repeat(1024 * 1024)}`)
      ctx = withSession()
      const fiber = ctx.plugin(GatedWebServer, {
        host: '127.0.0.1', port: 0, networkPort: 0,
        tlsCertPath: kind === 'certificate' ? oversized : certPath,
        tlsKeyPath: kind === 'private key' ? oversized : keyPath,
      })
      // A mutant allowing the oversized but valid PEM prefix can start the Cordis
      // service. Its object has reflective getters that throw if Vitest formats
      // it as a fulfilled promise; normalize success to a harmless scalar so
      // this test fails on the missing size rejection, not in the reporter.
      await expect(fiber.await().then(() => 'started')).rejects.toThrow(
        new RegExp(`TLS ${kind} exceeds the 1 MiB PEM size limit`),
      )
      await ctx.fiber.dispose()
      ctx = undefined
    }
  })

  it.skipIf(process.platform === 'win32')('accepts an explicit TLS PEM symlink whose target is a regular file', async () => {
    const { certPath, keyPath } = await certificateFiles()
    const linked = join(dirname(certPath), 'current-cert.pem')
    symlinkSync(certPath, linked)
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, networkPort: 0,
      tlsCertPath: linked, tlsKeyPath: keyPath,
    }).await()
    expect((ctx.get('webServer') as GatedWebServer).scheme).toBe('https')
  })

  it('refuses TLS material configured by halves', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: '/tmp/cert.pem' })
    await expect(fiber.await()).rejects.toThrow(/must be configured together/)
  })

  it('passes the inherited carrier\'s own fields through, compression included', async () => {
    // The TLS branch rebuilds the config it hands `super`, which is exactly
    // where a field upstream added — gzip for the Web profile — got dropped.
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0, compression: 'gzip',
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

  it('validates every field of its own at load, so a malformed value never reaches the gate', async () => {
    // Schemastery passes a key its schema does not name straight through, so a
    // field missing from the schema is neither defaulted nor checked: a string
    // where a list belongs would become a Set of its characters.
    for (const field of Object.keys(OWN_FIELDS)) {
      ctx = new Context()
      const fiber = ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, [field]: { malformed: true } } as never)
      await expect(fiber.await()).rejects.toThrow(new RegExp(`\\$\\.${field}(?:\\.| expected)`))
      await ctx.fiber.dispose(); ctx = undefined
    }
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

  it('returns the gate refusal if upstream session verification throws', async () => {
    const broken = new Context()
    broken.provide('connection', {
      requestRejection: () => { throw new Error('synthetic credential-bearing upstream failure') },
    })
    const handler = await gatedHandler('/api', 'prefix', broken)
    const denied = response()
    // Without the guard this handler rejects rather than sending the normal
    // fixed refusal, potentially disrupting the long-running HTTP listener.
    await expect(Promise.resolve(handler(req('/api/session/list', '192.168.1.5', { cookie: SESSION }), denied)))
      .resolves.toBeUndefined()
    expect([denied.status, denied.body]).toEqual([403, REFUSAL_BODY])
  })

  it('refuses a LAN peer when the connection service lookup itself throws', async () => {
    const handler = await gatedHandler('/api')
    // Cordis mixes ctx.get into Context through the reflection service;
    // Context.prototype itself has no "get" member to spy on.
    const reflect = (ctx as Context).reflect
    const originalGet = reflect.get
    const lookup = vi.spyOn(reflect, 'get').mockImplementation((function (this: typeof reflect, ...args: unknown[]) {
      if (args[0] === 'connection') throw new Error('synthetic connection lookup secret')
      return Reflect.apply(originalGet, this, args)
    }) as typeof originalGet)
    try {
      const denied = response()
      await expect(Promise.resolve(handler(req('/api/session/list', '192.168.1.5', { cookie: SESSION }), denied)))
        .resolves.toBeUndefined()
      expect([denied.status, denied.body]).toEqual([403, REFUSAL_BODY])
      // This is only the additional LAN gate; localhost retains its old
      // behavior, even if the upstream connection service is temporarily down.
      const local = response()
      await expect(Promise.resolve(handler(req('/api/session/list', '127.0.0.1'), local)))
        .resolves.toBeUndefined()
      expect([local.status, local.body]).toEqual([200, 'REACHED'])
    } finally {
      lookup.mockRestore()
    }
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

  it('pins a method however it is spelled', async () => {
    // Upstream rejects a `%` in an endpoint today; one that starts decoding
    // would read the escapes, so both readings are classified. An escaped
    // separator reads as one unlisted name and is pinned either way; an escape
    // inside a method of a paired namespace is what only the decoded reading
    // catches — raw, `openWorkspace%50ath` is no method the pin names.
    const handler = await gatedHandler('/api')
    for (const endpoint of ['session%2FopenWorkspacePath', 'session/openWorkspace%50ath', 'directoryPicker/pic%6B']) {
      const paired = response()
      await handler(req(`/api/${endpoint}`, '192.168.1.5', { cookie: SESSION }), paired)
      expect([endpoint, paired.status, paired.body]).toEqual([endpoint, 403, REFUSAL_BODY])
    }
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
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: networkBindHost(LAN ?? '192.168.1.20'), port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0 }).await()
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


  it('admits upstream Fetch resources only after the socket gate, preserving cookie security', async () => {
    const lan = LAN as string
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: networkBindHost(lan), port: 0, networkPort: 0, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    // dsh 0.2.2+ registers both browser assets and its SPA fallback as
    // { resource }, not as the earlier (req, res) handler. The old wrapper
    // called the object as a function and answered HTTP 400 on pairing.
    server.register({
      kind: 'prefix', path: '/plugins',
      resource: async () => new Response('js bundle', { status: 200 }),
    })
    server.registerFallback({
      resource: async request => {
        if (new URL(request.url).searchParams.has('token')) {
          return new Response(null, {
            status: 303, headers: { location: './', 'set-cookie': `${SESSION}; HttpOnly; SameSite=Strict` },
          })
        }
        return new Response('<html><script></script></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      },
    })
    const request = (path: string, cookie?: string): Promise<{ status: number; cookies: string[]; location: string | undefined }> =>
      new Promise((resolve, reject) => {
        const client = httpsRequest({
          host: lan, port: server.networkPort, path, method: 'GET', ca,
          headers: cookie === undefined ? {} : { cookie },
        }, res => {
          res.resume()
          res.on('end', () => resolve({
            status: res.statusCode ?? 0, cookies: res.headers['set-cookie'] ?? [],
            location: res.headers.location,
          }))
        })
        client.on('error', reject)
        client.end()
      })
    expect((await request('/plugins/client.js')).status).toBe(403)
    expect((await request('/plugins/client.js', SESSION)).status).toBe(200)
    expect((await request('/assets/index.js.map')).status).toBe(403)
    const exchange = await request('/?token=launch-token')
    expect([exchange.status, exchange.location]).toEqual([303, './'])
    expect(exchange.cookies).toHaveLength(1)
    expect(exchange.cookies[0]).toMatch(/; Secure$/)
    expect((await request('/')).status).toBe(200) // Public fallback; index owner decides auth.
    expect((await plainGet('127.0.0.1', server.port, '/?token=launch-token'))).toBe(303)

    // Newer carriers can also read a resource in-process after admitting its
    // Peer. Socket fallback adaptation must not silently turn that into 404.
    const read = Reflect.get(server, 'readResource') as
      | ((request: Request, peer: unknown) => Promise<Response>) | undefined
    if (read !== undefined) {
      const inProcess = await Reflect.apply(read, server, [new Request('http://x/plugins/client.js'), {}]) as Response
      expect([inProcess.status, await inProcess.text()]).toEqual([200, 'js bundle'])
    }
  })

  it('keeps this machine on the port the stock carrier would bind, and gives the network its own', async () => {
    // Switching the plugin on must not move a desktop tab: the plaintext
    // listener stays on the configured port, bound to loopback, and devices
    // reach TLS on a port of their own.
    const lan = LAN as string
    const { certPath, keyPath, ca } = await certificateFiles()
    const [local, network] = await twoFreePorts()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, {
      host: networkBindHost(LAN ?? '192.168.1.20'), port: local, networkPort: network, tlsCertPath: certPath, tlsKeyPath: keyPath,
    }).await()
    const server = ctx.get('webServer') as GatedWebServer
    server.register({ kind: 'prefix', path: '/api', handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })
    expect([server.port, server.networkPort]).toEqual([local, network])
    expect(await plainGet('127.0.0.1', local, '/api/session/list')).toBe(200)
    expect((await get(lan, network, '/api/session/list', { cookie: SESSION }, ca)).status).toBe(200)
    // The dsh web line's `(LAN: …)` link names lan:<port> and carries the
    // launch token over plain http. Nothing may answer there, so a phone that
    // opens it sends nothing a passive listener could read.
    await expect(plainGet(lan, local, '/')).rejects.toThrow(/ECONNREFUSED/)
  })

  it('reports a loopback port that answers plain http, and a network port that answers TLS', async () => {
    const { certPath, keyPath } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: networkBindHost(LAN ?? '192.168.1.20'), port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0 }).await()
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
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: networkBindHost(LAN ?? '192.168.1.20'), port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0 }).await()
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

// Upstream's session cookie is not `Secure`, and a browser scopes cookies by
// host, not scheme or port, so without the mark it would ride any later
// http:// request a paired phone made to this machine's address.
describe('cookies set through the TLS front', () => {
  /** Every way node lets a handler set a cookie, keyed by the path that uses it. */
  const SETTERS: Record<string, (res: ServerResponse) => void> = {
    '/set-header': (res) => { res.setHeader('Set-Cookie', 'a=1; HttpOnly'); res.writeHead(200) },
    '/set-header-list': (res) => { res.setHeader('set-cookie', ['a=1', 'b=2; secure']); res.writeHead(200) },
    // Appending to a header that already exists: node hands a first append to
    // setHeader, but pushes onto an existing one directly.
    '/append-header': (res) => { res.setHeader('Set-Cookie', 'a=1'); res.appendHeader('set-cookie', 'b=2'); res.writeHead(200) },
    // Upstream's exchange: the object form, on a 303.
    '/write-head': (res) => { res.writeHead(303, { location: './', 'set-cookie': 'a=1; HttpOnly; SameSite=Strict' }) },
    '/write-head-message': (res) => { res.writeHead(200, 'OK', { 'Set-Cookie': ['a=1'] }) },
    // Node's flat raw form: name, value, name, value.
    '/write-head-raw': (res) => { res.writeHead(200, ['Content-Type', 'text/plain', 'Set-Cookie', 'a=1']) },
    // And its list of [name, value] pairs, which node accepts as well.
    '/write-head-pairs': (res) => { res.writeHead(200, [['Content-Type', 'text/plain'], ['Set-Cookie', 'a=1']]) },
    // Only the attribute counts as already Secure — not a name or a path
    // that happens to contain the word.
    '/look-alike': (res) => { res.setHeader('Set-Cookie', ['secure=1', 'a=1; Path=/secure', 'b=2; Securely=1']); res.writeHead(200) },
    // Headers set before writeHead send node down its merging path, which
    // calls setHeader itself — the mark must not land twice.
    '/write-head-merged': (res) => { res.setHeader('x-early', '1'); res.writeHead(200, { 'set-cookie': 'a=1' }) },
  }

  /** What each path answers with, marked Secure, except what already was. */
  const MARKED: Record<string, string[]> = {
    '/set-header': ['a=1; HttpOnly; Secure'],
    '/set-header-list': ['a=1; Secure', 'b=2; secure'],
    '/append-header': ['a=1; Secure', 'b=2; Secure'],
    '/write-head': ['a=1; HttpOnly; SameSite=Strict; Secure'],
    '/write-head-message': ['a=1; Secure'],
    '/write-head-raw': ['a=1; Secure'],
    '/write-head-pairs': ['a=1; Secure'],
    '/look-alike': ['secure=1; Secure', 'a=1; Path=/secure; Secure', 'b=2; Securely=1; Secure'],
    '/write-head-merged': ['a=1; Secure'],
  }

  /** Every Set-Cookie line one GET received. */
  function cookiesFrom(url: string, ca?: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const request = url.startsWith('https:') ? httpsRequest : httpRequest
      const rq = request(url, { method: 'GET', ...ca !== undefined && { ca } }, (res) => {
        res.resume(); res.on('end', () => { resolve(res.headers['set-cookie'] ?? []) })
      })
      rq.on('error', reject); rq.end()
    })
  }

  /** A TLS carrier with every setter on a named route and one on the fallback seat. */
  async function cookieCarrier(): Promise<{ server: GatedWebServer; ca: string }> {
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0 }).await()
    const server = ctx.get('webServer') as GatedWebServer
    for (const [path, setter] of Object.entries(SETTERS)) {
      server.register({ kind: 'exact', path, handler: (_q, res) => { setter(res); res.end() } })
    }
    // Where the exchange actually happens: dsh-host-frontend-static's seat.
    server.registerFallback((_q, res) => { SETTERS['/write-head']?.(res); res.end() })
    return { server, ca }
  }

  it('marks every cookie Secure, however the handler set it, on every seat', async () => {
    const { server, ca } = await cookieCarrier()
    for (const [path, expected] of Object.entries(MARKED)) {
      expect([path, await cookiesFrom(`https://127.0.0.1:${String(server.networkPort)}${path}`, ca)]).toEqual([path, expected])
    }
    expect(await cookiesFrom(`https://127.0.0.1:${String(server.networkPort)}/?token=launch-token`, ca))
      .toEqual(MARKED['/write-head'])
  })

  it('leaves this machine\'s plaintext listener alone, where a browser would drop a Secure cookie', async () => {
    const { server } = await cookieCarrier()
    expect(await cookiesFrom(`http://127.0.0.1:${String(server.port)}/write-head`)).toEqual(['a=1; HttpOnly; SameSite=Strict'])
    expect(await cookiesFrom(`http://127.0.0.1:${String(server.port)}/?token=launch-token`)).toEqual(['a=1; HttpOnly; SameSite=Strict'])
  })
})

describe('the certificate fingerprint', () => {
  it('is the one a device is shown for the certificate the TLS front presents', async () => {
    const { certPath, keyPath, ca } = await certificateFiles()
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath, networkPort: 0 }).await()
    const server = ctx.get('webServer') as GatedWebServer
    const presented = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: '127.0.0.1', port: server.networkPort, ca }, () => {
        const { fingerprint256 } = socket.getPeerCertificate()
        socket.destroy()
        resolve(fingerprint256)
      })
      socket.on('error', reject)
    })
    expect(server.certificateFingerprint).toBe(presented)
    expect(presented).toBe(new X509Certificate(ca).fingerprint256)
    // Gone with the listener, like the scheme and the network port.
    await ctx.fiber.dispose(); ctx = undefined
    expect([server.scheme, server.certificateFingerprint]).toEqual(['http', undefined])
  })

  it('is absent while no TLS front listens', async () => {
    ctx = withSession()
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0 }).await()
    expect((ctx.get('webServer') as GatedWebServer).certificateFingerprint).toBeUndefined()
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

  it('refuses malformed absolute request targets without throwing from the fallback seat', async () => {
    const handler = await gatedFallback()
    // node:http accepts these targets before the WHATWG URL parser rejects
    // them. Public pairing/static assets must not exempt malformed requests.
    for (const target of ['http://[', 'http://%', '//[::broken']) {
      for (const peer of ['192.168.1.5', '127.0.0.1']) {
        const refused = response()
        await expect(Promise.resolve(handler(req(target, peer, { cookie: SESSION }), refused)))
          .resolves.toBeUndefined()
        expect([target, peer, refused.status, refused.body])
          .toEqual([target, peer, 403, REFUSAL_BODY])
      }
    }
    const valid = response()
    await handler(req('/?token=launch-token', '192.168.1.5'), valid)
    expect([valid.status, valid.body]).toEqual([200, 'DIST'])
  })

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
    // The literal, then the escapes dsh-host-frontend-static decodes back to
    // it, then the aliases its path.resolve and the filesystem open as the same
    // file: a trailing separator or `.`, case, and on Windows trailing dots and
    // spaces, a backslash, and an NTFS stream.
    for (const path of [
      '/assets/index.js.map', '/assets/index.js.ma%70', '/assets/index.js%2Emap',
      '/assets/index.js.map/', '/assets/index.js.map%2F', '/assets/index.js.map/.', '/assets/index.js.map//',
      '/assets/index.js.MAP', '/assets/index.js.Ma%50',
      '/assets/index.js.map.', '/assets/index.js.map%20', '/assets/index.js.map%5C', '/assets/index.js.map::$DATA',
    ]) {
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
    for (const path of [
      '/bundles/ui-theme/client.js.map', '/bundles/ui-theme/client.js.ma%70', '/bundles/ui-theme/client.js.map/',
      '/bundles/ui-theme/client.js.MAP', '/bundles/ui-theme/client.js.map.',
    ]) {
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

