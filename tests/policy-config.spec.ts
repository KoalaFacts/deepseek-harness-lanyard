/**
 * The gate's policy as configuration.
 *
 * Every route path this plugin keys on belongs to a client-side package —
 * `API_PATH` (`dsh-client-connection`), `EVENTS_ENDPOINT` (`dsh-client-hmr`),
 * the bundle prefix (`dsh-client-modules`). A deployment must be able to
 * restate them, and a stale value must be visible rather than silently
 * widening what the LAN can reach.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  GatedWebServer, isPrivilegedEndpoint,
  DEFAULT_ENDPOINT_AUTHORITY, DEFAULT_LOOPBACK_ONLY_PATHS, DEFAULT_PAIRED_NAMESPACES,
  type Config as GateConfig,
} from '../src/webserver.ts'

const TOKEN = 'pairing-token_0123456789-ab'
const LAN = '192.168.1.5'
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.restoreAllMocks() })

/** The response facts a wrapped handler wrote. */
function response(): ServerResponse & { status: number } {
  let status = 0
  return {
    writeHead(code: number) { status = code; return this },
    end() {},
    get status() { return status },
  } as unknown as ServerResponse & { status: number }
}

/** A request whose socket peer the kernel would have filled in. */
function req(url: string, remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

/** Mount a gate with one policy and capture the handler it wrapped around one route. */
async function gatedHandler(config: Partial<GateConfig>, route: { path: string; kind?: WebRoute['kind'] }):
Promise<WebRoute['handler']> {
  const captured: WebRoute[] = []
  const spy = vi.spyOn(WebServer.prototype, 'register').mockImplementation((entry: WebRoute) => {
    captured.push(entry)
    return () => {}
  })
  ctx = new Context()
  await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN, ...config } as GateConfig).await()
  const server = ctx.get('webServer') as GatedWebServer
  server.register({ kind: route.kind ?? 'prefix', path: route.path, handler: (_q, res) => { res.writeHead(200); res.end() } })
  spy.mockRestore()
  const entry = captured.at(-1)
  if (entry === undefined) throw new Error('the gate never reached WebServer.register')
  return entry.handler
}

/** Status a paired (token-presenting) LAN device gets for one request. */
async function pairedStatus(handler: WebRoute['handler'], url: string): Promise<number> {
  const res = response()
  await handler(req(url, LAN, { cookie: `dsh_auth=${TOKEN}` }), res)
  return res.status
}

describe('the api prefix is configuration, not a constant', () => {
  it('keeps the configuration plane pinned when a deployment moves the prefix', async () => {
    // Hardcoding '/api' would make every endpoint under a moved prefix read as
    // unprivileged — the pin would fail open, silently.
    const handler = await gatedHandler({ apiPathPrefix: '/rpc' }, { path: '/rpc' })
    expect(await pairedStatus(handler, '/rpc/settings.update')).toBe(403)
    expect(await pairedStatus(handler, '/rpc/session.list')).toBe(200)
  })

  it('defaults to the prefix dsh-client-connection registers', async () => {
    const handler = await gatedHandler({}, { path: '/api' })
    expect(await pairedStatus(handler, '/api/settings.update')).toBe(403)
  })
})

describe('endpoint authority is per deployment, and denies by default', () => {
  it('reaches a namespace this deployment classified as pairable', () => {
    const authority = {
      privilegedMethods: DEFAULT_ENDPOINT_AUTHORITY.privilegedMethods,
      pairedNamespaces: new Set([...DEFAULT_PAIRED_NAMESPACES, 'myPlugin']),
    }
    expect(isPrivilegedEndpoint('myPlugin/read', authority)).toBe(false)
    // Everything it did not classify still fails closed.
    expect(isPrivilegedEndpoint('otherPlugin/read', authority)).toBe(true)
  })

  it('pins a method this deployment added to the privileged set', async () => {
    const handler = await gatedHandler(
      { privilegedMethods: ['session.create'] }, { path: '/api' },
    )
    expect(await pairedStatus(handler, '/api/session.create')).toBe(403)
  })

  it('still denies an unclassified namespace when a deployment names its own list', async () => {
    const handler = await gatedHandler({ pairedNamespaces: ['commands'] }, { path: '/api' })
    expect(await pairedStatus(handler, '/api/commands/execute')).toBe(200)
    expect(await pairedStatus(handler, '/api/goals/create')).toBe(403)
  })
})

describe('pinned and public paths are configuration', () => {
  it('pins whatever reload endpoint this harness version uses', async () => {
    const handler = await gatedHandler({ loopbackOnlyPaths: ['/plugins/hmr'] }, { path: '/plugins/hmr', kind: 'exact' })
    expect(await pairedStatus(handler, '/plugins/hmr')).toBe(403)
    const local = response()
    await handler(req('/plugins/hmr', '127.0.0.1'), local)
    expect(local.status).toBe(200)
  })

  it('defaults to the endpoint dsh-client-hmr registers', () => {
    expect(DEFAULT_LOOPBACK_ONLY_PATHS).toEqual(['/plugins/events'])
  })

  it('excludes the suffixes this deployment names from its public paths', async () => {
    const handler = await gatedHandler(
      { publicPaths: ['/bundles'], publicPathExcludedSuffixes: ['.map', '.ts'] }, { path: '/bundles' },
    )
    const anonymous = async (url: string): Promise<number> => {
      const res = response()
      await handler(req(url, LAN), res)
      return res.status
    }
    expect(await anonymous('/bundles/x/client.js')).toBe(200)
    expect(await anonymous('/bundles/x/client.js.map')).toBe(403)
    expect(await anonymous('/bundles/x/client.ts')).toBe(403)
  })
})

describe('a configured path nothing claimed', () => {
  /** Mount a gate under a Loader whose settle this test controls. */
  async function mountWithLoader(config: Partial<GateConfig>): Promise<{
    server: GatedWebServer
    settle: () => Promise<void>
    warnings: string[]
  }> {
    ctx = new Context()
    let release = (): void => {}
    const settled = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settled })
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN, ...config } as GateConfig).await()
    const server = ctx.get('webServer') as GatedWebServer
    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => {
      warnings.push(String(message))
    }) as never)
    return { server, warnings, settle: async () => { release(); await settled; await Promise.resolve() } }
  }

  it('is reported once the tree settles, naming the ones that fail open', async () => {
    const { settle, warnings } = await mountWithLoader({})
    await settle()
    // Nothing registered at all, so every configured path is unclaimed.
    expect(warnings.some(line => line.includes('"/api"') && line.includes('less guarded than intended'))).toBe(true)
    expect(warnings.some(line => line.includes('"/plugins/events"') && line.includes('less guarded than intended'))).toBe(true)
    // A public path that matches nothing only refuses more than intended.
    expect(warnings.some(line => line.includes('"/plugins"') && !line.includes('less guarded'))).toBe(true)
  })

  it('stays quiet when every configured path was claimed', async () => {
    const { server, settle, warnings } = await mountWithLoader({})
    for (const path of ['/api', '/plugins']) {
      server.register({ kind: 'prefix', path, handler: (_q, res) => { res.writeHead(200); res.end() } })
    }
    server.register({ kind: 'exact', path: '/plugins/events', handler: (_q, res) => { res.writeHead(200); res.end() } })
    await settle()
    expect(warnings).toEqual([])
  })

  it('says nothing in a hand-built context, which has no settle point', async () => {
    ctx = new Context()
    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warnings.push(String(message)) }) as never)
    await ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: TOKEN }).await()
    await Promise.resolve()
    expect(warnings).toEqual([])
  })
})
