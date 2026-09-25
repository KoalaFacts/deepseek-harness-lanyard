/**
 * The gated carrier: a `WebServer` subclass that terminates TLS and puts
 * upstream's own browser session in front of every request from the network,
 * without any change to the harness.
 *
 * Upstream authenticates: since 0.1.2 `dsh-client-connection` exchanges the
 * launch token `dsh web` prints for a signed, host-bound session cookie, checks
 * it on `/api`, and offers the same check to other route owners as
 * `ctx.connection.requestRejection`. What upstream does not do is serve the
 * network at all — its command-line provider still refuses `--host 0.0.0.0` —
 * and it treats every authenticated browser as the operator at the keyboard.
 * This class supplies the rest of what makes a network bind safe:
 *
 * - **TLS**, so the launch token and the session cookie never cross the
 *   network in plaintext. An all-interfaces bind without TLS material fails the
 *   load.
 * - **The session check at every seat.** Consumers contribute routes through
 *   three seats — `register`, `registerUpgrade`, and the single-owner
 *   `registerFallback` that answers everything no named route matched.
 *   Wrapping all three puts the check in front of every request the
 *   composition serves to a network peer, including routes whose owners
 *   authenticate nothing themselves. {@link assertRegistrarsWrapped} fails the
 *   load if a future harness grows a fourth.
 * - **The configuration plane stays at the machine.** A session proves a
 *   device was paired, not that someone is at the keyboard, so settings,
 *   credentials, plugin installation and anything acting on the host's desktop
 *   stay pinned to a loopback peer.
 *
 * TLS is terminated here and the decrypted socket is handed to the inherited
 * HTTP server, which preserves `req.socket.remoteAddress` as the real client
 * address. That is the property the loopback exemption depends on: a
 * TCP-forwarding proxy would make every request read as a loopback peer and
 * silently lift both the session requirement and the configuration pin.
 * @module
 */

import { createServer as createTlsServer } from 'node:tls'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server as TlsServer } from 'node:tls'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { Config as WebServerConfig, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { admit, isLoopbackAddress } from './admission.ts'

/**
 * Every route path this gate keys on is owned by a *client-side* package —
 * `API_PATH` in `dsh-client-connection`, `EVENTS_ENDPOINT` in
 * `dsh-client-hmr`, the open route in `dsh-host-open-in-app` — so none of them
 * is this plugin's to hardcode. They are schema defaults a deployment can
 * restate, per the harness rule that anything two deployments may set
 * differently is a configuration field.
 *
 * All of them fail OPEN when they drift: an `/api` prefix that no longer
 * matches makes every endpoint read as unprivileged, and a pinned route that
 * moved is merely session-gated. {@link GatedWebServer} therefore warns about
 * any configured path that no row ever claimed, so a rename surfaces as a
 * diagnostic instead of as a quietly widened surface.
 */

/** Route prefix owning every api request; `dsh-client-connection`'s `API_PATH`. */
export const DEFAULT_API_PATH_PREFIX = '/api'

/**
 * Endpoints pinned to a loopback peer even inside a namespace a paired device
 * may otherwise reach. Each acts on this machine's desktop or reads a
 * configuration document:
 *
 * - `session/openWorkspacePath` opens or reveals a path with the host's own
 *   applications, and `directoryPicker/pick` opens the host's native chooser —
 *   both on a screen the device holding the session cannot see. The in-app
 *   browser (`directoryPicker/list`) stays reachable.
 * - `agentPresets/read`, `/copy` and `/deletePreset` read and edit preset
 *   documents, which configure the agent; listing and selecting one does not.
 *
 * The list covers both of upstream's release channels, so a method only one of
 * them exposes is listed anyway.
 */
export const DEFAULT_PRIVILEGED_METHODS: readonly string[] = [
  'session/openWorkspacePath',
  'directoryPicker/pick',
  'agentPresets/read', 'agentPresets/copy', 'agentPresets/deletePreset',
]

/**
 * Typert Gateway namespaces a paired device may reach — everything the shipped
 * GUI needs to hold a session from a phone. The Gateway claims every
 * `namespace/method` a live remote service exposes, so this space grows with
 * the composition; anything unlisted is loopback-only, which keeps a service
 * this build has never seen from becoming LAN-reachable merely by appearing. A
 * deployment adds its own namespace deliberately — the default denies.
 *
 * Deliberately absent, so pinned: `settings`, `credentials`, `account`, `llm`
 * (the configuration plane); `pluginManager`, `pluginRegistryProbe`,
 * `pluginInventory` (installing code, and the inventory that echoes the
 * composed configuration); `dynamicCordisRunner` (runs plugin code from the
 * panel); and `speech`, which only an experimental bundle mounts.
 */
export const DEFAULT_PAIRED_NAMESPACES: readonly string[] = [
  // Sessions and the conversation in them.
  'session', 'subagents', 'skills', 'commands', 'goals', 'fileReferences', 'fileUploads',
  'sessionReferenceResolver', 'messageFeedback', 'sessionFeedback', 'agentPresets', 'permissionPresets',
  // Host-forwarded requests the device answers — tool approvals and the
  // agent's questions arrive as `$events` and are answered at `$events/result`,
  // so pinning it leaves the agent waiting on a prompt the phone can see.
  '$events',
  // Workspaces and the files in them.
  'workspace', 'workspaceFiles', 'directoryPicker', 'officeToPdf',
  // Work running on this machine on the session's behalf. A terminal adds no
  // capability a paired device lacks: it already drives an agent that runs
  // commands, and it answers that agent's approvals itself.
  'job', 'terminal', 'schedule',
]

/**
 * Body of a refusal this gate issued.
 *
 * Deliberately not the bare `forbidden` / `unauthorized` that
 * `dsh-client-connection` answers with itself: an operator reading a refusal,
 * and the end-to-end suite deciding which layer refused, cannot tell two
 * identical bodies apart.
 */
export const REFUSAL_BODY = 'lanyard: forbidden'

/**
 * Named routes served to a network peer without a session.
 *
 * None by default. A route used to be exempted when the browser had to load it
 * before it could hold a credential; upstream's exchange sets the session
 * cookie on the redirect that precedes the first page load, so every request
 * the loaded page makes already carries it.
 */
export const DEFAULT_PUBLIC_PATHS: readonly string[] = []

/**
 * Suffixes excluded from every public seat. The built frontend on the fallback
 * seat carries source maps, and handing an anonymous peer the full client
 * source is not part of loading the pairing page.
 */
export const DEFAULT_PUBLIC_PATH_EXCLUDED_SUFFIXES: readonly string[] = ['.map']

/**
 * Routes a paired device may not reach at all, whatever it presents.
 *
 * - `/plugins/events` is the dev reload channel: it has no admission of its
 *   own, its connections are uncapped and live until their client closes, and
 *   the rebuild watcher feeding it runs on this machine anyway. On a network
 *   bind that combination is a socket sink, and pairing buys a remote device
 *   nothing it could use.
 * - `/open-in-app/open` launches a desktop application on this machine, the
 *   route-level twin of the pinned `session/openWorkspacePath`.
 */
export const DEFAULT_LOOPBACK_ONLY_PATHS: readonly string[] = ['/plugins/events', '/open-in-app/open']

/**
 * Admission posture for one seat: served to anyone, requiring upstream's
 * session, or pinned to a peer on this machine.
 */
export type Admission = 'public' | 'gated' | 'loopback-only'

/**
 * Posture of the fallback seat, which in the shipped Web composition is
 * `dsh-host-frontend-static` serving the built SPA.
 *
 * Public by default, because pairing itself arrives here: a device holding no
 * session yet opens `/?token=…`, and upstream's own `authorizeIndex` on this
 * seat exchanges the token for the session cookie. Upstream also authenticates
 * the index there without help, answering 401 to a peer with no session, so
 * what the exemption actually leaves anonymous is the built frontend's static
 * files, which carry no secret; {@link Config.publicPathExcludedSuffixes} still
 * applies, so source maps never ride it. `gated` closes pairing to new devices
 * while ones already holding a session keep working.
 */
export const DEFAULT_FALLBACK_ADMISSION: Admission = 'public'

/** How an `/api` endpoint's reachability is decided, as one deployment classified it. */
export interface EndpointAuthority {
  /** Endpoints pinned to a loopback peer even inside a paired namespace. */
  privilegedMethods: ReadonlySet<string>
  /** Gateway namespaces a paired device may reach; anything else is pinned. */
  pairedNamespaces: ReadonlySet<string>
}

/** The shipped classification, used when a caller names none. */
export const DEFAULT_ENDPOINT_AUTHORITY: EndpointAuthority = {
  privilegedMethods: new Set(DEFAULT_PRIVILEGED_METHODS),
  pairedNamespaces: new Set(DEFAULT_PAIRED_NAMESPACES),
}

/**
 * Gated carrier config: every field of the inherited carrier's, plus this
 * plugin's own. The constructor hands `super` the whole object, so a field
 * upstream adds — `compression` was one — reaches the inherited carrier
 * without this plugin naming it; and the schema composes upstream's own, so
 * that field is validated and defaulted exactly as the stock row would.
 */
export interface Config extends WebServerConfig {
  /** PEM certificate path; set with {@link tlsKeyPath} to serve HTTPS. */
  tlsCertPath?: string
  /** PEM private-key path — a path, never inline material, so config surfaces cannot carry the key. */
  tlsKeyPath?: string
  /** Named route paths served to a network peer without a session; none by default. */
  publicPaths?: string[]
  /** Suffixes a public seat does not cover; defaults to source maps. */
  publicPathExcludedSuffixes?: string[]
  /** Route paths no paired device may reach; defaults to the dev reload channel and the desktop opener. */
  loopbackOnlyPaths?: string[]
  /**
   * Posture of the fallback seat — the handler answering every request no named
   * route matched. See {@link DEFAULT_FALLBACK_ADMISSION} for why it is public
   * and what `gated` costs.
   */
  fallbackAdmission?: Admission
  /** Route prefix owning api requests; defaults to `dsh-client-connection`'s. */
  apiPathPrefix?: string
  /** Endpoints pinned to a loopback peer even inside a paired namespace. */
  privilegedMethods?: string[]
  /** Gateway namespaces a paired device may reach; anything else is pinned. */
  pairedNamespaces?: string[]
}

export const Config: z<Config> = z.intersect([
  WebServer.Config,
  z.object({
    tlsCertPath: z.string(),
    tlsKeyPath: z.string(),
    publicPaths: z.array(String).default([...DEFAULT_PUBLIC_PATHS]),
    publicPathExcludedSuffixes: z.array(String).default([...DEFAULT_PUBLIC_PATH_EXCLUDED_SUFFIXES]),
    loopbackOnlyPaths: z.array(String).default([...DEFAULT_LOOPBACK_ONLY_PATHS]),
    fallbackAdmission: z.union([z.const('public'), z.const('gated'), z.const('loopback-only')])
      .default(DEFAULT_FALLBACK_ADMISSION),
    apiPathPrefix: z.string().default(DEFAULT_API_PATH_PREFIX),
    privilegedMethods: z.array(String).default([...DEFAULT_PRIVILEGED_METHODS]),
    pairedNamespaces: z.array(String).default([...DEFAULT_PAIRED_NAMESPACES]),
  }),
])

/**
 * Whether an `/api` endpoint stays pinned to a loopback peer. An endpoint named
 * in the privileged set is pinned outright; otherwise the Gateway's
 * `namespace/method` form is decided by namespace, so a method added to an
 * unlisted namespace inherits the pin rather than defaulting to reachable. An
 * endpoint with no namespace is not a Gateway method — upstream's
 * `/api/remote.mux` WebSocket is one — and is reachable unless named.
 * @param endpoint - endpoint identity, either `name` or `namespace/method`.
 * @param authority - this deployment's classification; defaults to the shipped one.
 * @returns true when only a loopback peer may reach it.
 */
export function isPrivilegedEndpoint(
  endpoint: string, authority: EndpointAuthority = DEFAULT_ENDPOINT_AUTHORITY,
): boolean {
  if (authority.privilegedMethods.has(endpoint)) return true
  const separator = endpoint.indexOf('/')
  return separator !== -1 && !authority.pairedNamespaces.has(endpoint.slice(0, separator))
}

/**
 * The endpoint an api request addresses, or undefined when its path carries none.
 * @param pathname - the request pathname.
 * @param prefix - the configured api route prefix.
 */
function endpointOf(pathname: string, prefix: string): string | undefined {
  const base = `${prefix}/`
  if (!pathname.startsWith(base)) return undefined
  const rest = pathname.slice(base.length)
  return rest.length > 0 ? rest : undefined
}

/**
 * The inherited HTTP server. `WebServer` declares this field `private`, which
 * TypeScript erases at runtime, so a subclass can still reach it — but a rename
 * upstream would otherwise surface as a silent loss of TLS. {@link assertServer}
 * turns that into a loud load failure instead.
 */
function assertServer(candidate: unknown): Server {
  const server = candidate as Server | undefined
  if (server === undefined || typeof server.emit !== 'function') {
    throw new Error(
      'lanyard: the inherited WebServer no longer exposes its node:http server, so TLS cannot be terminated '
      + 'in front of it; this plugin needs updating for this @deepseek-ai/dsh-host-webserver version',
    )
  }
  return server
}

/**
 * The registration seats this gate wraps. Every one of them can put a handler
 * on the network, so admission has to cover all of them.
 */
const WRAPPED_REGISTRARS: readonly string[] = ['register', 'registerUpgrade', 'registerFallback']

/**
 * Fail the load if the inherited `WebServer` exposes a registration seat this
 * class does not wrap.
 *
 * This is the guard whose absence let `registerFallback` serve the built
 * frontend to the network ungated for a whole release: overriding some of the
 * seats looks identical, from inside, to overriding all of them. A seat added
 * upstream must therefore break the load rather than quietly widen what is
 * reachable without a session.
 *
 * The search covers the whole prototype chain, because a seat moved down into a
 * shared base class is still a seat; inspecting one level would have called
 * that upstream reshuffle clean.
 *
 * It recognises a seat by its `register` prefix, which is how all three of the
 * current ones are named. That is a naming convention rather than a guarantee,
 * so a differently named seat would still need catching by review — claiming
 * more than this is the same overreach that hid the fallback in the first place.
 * @param prototype - the carrier prototype to inspect; the inherited one by default.
 * @throws when an unrecognised `register*` method exists upstream.
 */
export function assertRegistrarsWrapped(prototype: object = WebServer.prototype): void {
  // The whole chain, not just own properties: a seat moved to a base class is
  // still a seat, and inspecting one level would have called that upstream
  // reshuffle clean. `Object.prototype` is where the search stops, since
  // nothing there registers routes.
  const names = new Set<string>()
  for (let level: object | null = prototype; level !== null && level !== Object.prototype; level = Object.getPrototypeOf(level) as object | null) {
    for (const name of Object.getOwnPropertyNames(level)) names.add(name)
  }
  const unwrapped = [...names]
    .filter(name => name.startsWith('register') && !WRAPPED_REGISTRARS.includes(name))
    .sort()
  if (unwrapped.length > 0) {
    throw new Error(
      `lanyard: this @deepseek-ai/dsh-host-webserver version exposes ${unwrapped.map(name => JSON.stringify(name)).join(', ')}, `
      + 'which this plugin does not put behind admission; it needs updating before it can gate this harness version',
    )
  }
}

/**
 * The request pathname as the handlers behind the gate read it.
 *
 * `dsh-client-modules` and `dsh-host-frontend-static` both decode before
 * resolving a file, so matching the raw form here would let `%2E` spell a
 * suffix past {@link Config.publicPathExcludedSuffixes}.
 * @param pathname - the raw pathname.
 * @returns the decoded pathname, or undefined when its escapes are malformed.
 */
function decodedPathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

export class GatedWebServer extends WebServer {
  static override Config: z<Config> = Config

  private readonly gate: Config
  private readonly publicPaths: string[]
  private readonly publicPathExcludedSuffixes: string[]
  private readonly loopbackOnlyPaths: string[]
  private readonly fallbackAdmission: Admission
  private readonly apiPathPrefix: string
  private readonly authority: EndpointAuthority
  /** Route paths some row actually claimed, for the drift warning below. */
  private readonly claimedPaths = new Set<string>()
  private tls: TlsServer | undefined
  private tlsPort: number | undefined

  constructor(ctx: Context, config: Config) {
    assertRegistrarsWrapped()
    // With TLS the inherited server must not own the public port: this class
    // binds it and forwards decrypted sockets, so the parent gets an ephemeral
    // loopback socket whose only role is to route what TLS hands it. Every
    // other inherited field — compression among them — passes through.
    const servesTls = config.tlsCertPath !== undefined && config.tlsKeyPath !== undefined
    super(ctx, servesTls ? { ...config, host: '127.0.0.1', port: 0 } : config)
    if ((config.tlsCertPath === undefined) !== (config.tlsKeyPath === undefined)) {
      throw new Error('lanyard: tlsCertPath and tlsKeyPath must be configured together')
    }
    if (config.host === '0.0.0.0' && !servesTls) {
      throw new Error(
        'lanyard: an all-interfaces bind requires TLS material (tlsCertPath and tlsKeyPath), because the launch token '
        + 'and the session cookie that authenticate a device would otherwise cross the network in plaintext',
      )
    }
    this.gate = config
    this.publicPaths = config.publicPaths ?? [...DEFAULT_PUBLIC_PATHS]
    this.publicPathExcludedSuffixes = config.publicPathExcludedSuffixes ?? [...DEFAULT_PUBLIC_PATH_EXCLUDED_SUFFIXES]
    this.loopbackOnlyPaths = config.loopbackOnlyPaths ?? [...DEFAULT_LOOPBACK_ONLY_PATHS]
    this.fallbackAdmission = config.fallbackAdmission ?? DEFAULT_FALLBACK_ADMISSION
    this.apiPathPrefix = config.apiPathPrefix ?? DEFAULT_API_PATH_PREFIX
    this.authority = {
      privilegedMethods: new Set(config.privilegedMethods ?? DEFAULT_PRIVILEGED_METHODS),
      pairedNamespaces: new Set(config.pairedNamespaces ?? DEFAULT_PAIRED_NAMESPACES),
    }
  }

  /**
   * Configured route paths, and whether each one is load-bearing for admission.
   * Every entry is owned by a client-side package, so a rename upstream leaves
   * this deployment's configuration pointing at nothing.
   */
  private configuredPaths(): { path: string; failsOpen: boolean }[] {
    return [
      // A prefix that matches nothing makes every endpoint read as
      // unprivileged, so the configuration plane stops being pinned.
      { path: this.apiPathPrefix, failsOpen: true },
      // A pin that matches nothing leaves the route merely session-gated.
      ...this.loopbackOnlyPaths.map(path => ({ path, failsOpen: true })),
      // A public path that matches nothing only refuses more than intended.
      ...this.publicPaths.map(path => ({ path, failsOpen: false })),
    ]
  }

  /**
   * Warn about configured paths no row claimed. Called once the tree has
   * settled, because consumers register during their own activation.
   */
  private reportUnclaimedPaths(): void {
    for (const { path, failsOpen } of this.configuredPaths()) {
      if (this.claimedPaths.has(path)) continue
      this.ctx.logger.warn(
        `lanyard: no route claimed ${JSON.stringify(path)}; it is owned by a client-side package and may have been `
        + `renamed in this harness version${failsOpen ? ' — until this configuration is corrected that surface is less guarded than intended' : ''}`,
      )
    }
  }

  /**
   * The port a local http client reaches, which is what every consumer of this
   * member in the shipped composition builds a URL from: `dsh-web-app` hardcodes
   * `http://127.0.0.1:${port}` for the browser handoff, the `DSH_WEB_URL` shell
   * variable, and the URL it tells the model it is serving.
   *
   * Under TLS that is the inherited server, which binds an ephemeral loopback
   * port in plaintext while this class terminates TLS in front of it. Reporting
   * the TLS port here instead pointed all three at an https listener over http,
   * so the handoff opened a browser on a connection error. Nothing is newly
   * reachable: the inherited listener is loopback-only.
   */
  override get port(): number {
    return super.port
  }

  /**
   * The port a device elsewhere on the network connects to — the TLS listener
   * when serving HTTPS, else the same loopback listener as {@link port}. This is
   * what a pairing link must name; {@link port} would send the phone to a port
   * bound only to the machine's own loopback interface.
   */
  get networkPort(): number {
    return this.tlsPort ?? super.port
  }

  /** The configured bind host, which TLS mode does not delegate to the inherited server. */
  override get host(): Config['host'] {
    return this.gate.host
  }

  /**
   * URL scheme this carrier answers. Not an `override`: the shipped `WebServer`
   * has no such member, so a future version that grows one turns this into a
   * `noImplicitOverride` compile error rather than a silent shadow.
   */
  get scheme(): 'http' | 'https' {
    return this.tls === undefined ? 'http' : 'https'
  }

  /** Listen, and add the TLS frontend when material is configured. */
  override async [Service.init](): Promise<void> {
    await super[Service.init]()
    // Consumers register during their own activation, so the claim set is only
    // complete once the tree has settled. A hand-built context has no Loader
    // and therefore no settle point — reporting there would warn about paths
    // whose rows simply have not mounted yet.
    const settled = this.ctx.get('loader')?.await() as Promise<unknown> | undefined
    // A failed boot reports itself; this row stays quiet.
    void settled?.then(() => { this.reportUnclaimedPaths() }, () => {})
    const { tlsCertPath, tlsKeyPath } = this.gate
    if (tlsCertPath === undefined || tlsKeyPath === undefined) return
    const routed = assertServer((this as unknown as { server: unknown }).server)
    const [cert, key] = await Promise.all([readFile(tlsCertPath), readFile(tlsKeyPath)])
    const tls = createTlsServer({ cert, key })
    // The decrypted TLSSocket keeps the underlying connection's remoteAddress,
    // so admission still reads the real peer rather than this process.
    tls.on('secureConnection', socket => { routed.emit('connection', socket) })
    tls.on('error', error => { this.ctx.logger.warn(error) })
    await new Promise<void>((resolve, reject) => {
      tls.once('error', reject)
      tls.listen(this.gate.port, this.gate.host, () => {
        tls.off('error', reject)
        this.tlsPort = (tls.address() as AddressInfo).port
        this.tls = tls
        resolve()
      })
    })
    this.ctx.effect(() => async () => {
      await new Promise<void>((resolve) => { tls.close(() => { resolve() }) })
      this.tls = undefined
      this.tlsPort = undefined
    }, 'lanyard: TLS listener')
  }

  /**
   * Posture configured for one named route path. Anything not named requires a
   * session, so a route added upstream is admitted no more freely than `/api` is.
   * @param routePath - the path the owning row registered.
   */
  private posture(routePath: string): Admission {
    if (this.loopbackOnlyPaths.includes(routePath)) return 'loopback-only'
    if (this.publicPaths.includes(routePath)) return 'public'
    return 'gated'
  }

  /**
   * Whether a request may reach the handler occupying one seat.
   * @param req - the inbound request, read for its session and its socket peer.
   * @param admission - the seat's configured posture.
   */
  private permits(req: IncomingMessage, admission: Admission): boolean {
    /* v8 ignore next -- node always sets url on server requests */
    const raw = new URL(req.url ?? '/', 'http://x').pathname
    if (admission === 'loopback-only') return isLoopbackAddress(req.socket.remoteAddress)
    const decoded = decodedPathname(raw)
    // A pathname whose escapes do not decode cannot be checked against the
    // exclusions, so it never rides the public exemption.
    const excluded = decoded === undefined
      || this.publicPathExcludedSuffixes.some(suffix => decoded.endsWith(suffix))
    if (admission === 'public' && !excluded) return true
    // Looked up per request: Connection mounts after this carrier, since it
    // registers its own routes here, and may be replaced while the carrier
    // lives. Whatever the lookup finds, a network peer it cannot vouch for is
    // refused.
    if (!admit(req, this.ctx.get('connection'))) return false
    // Both readings are classified: upstream resolves the endpoint from the raw
    // pathname and rejects a `%` outright, but a version that starts decoding
    // would otherwise turn `%2F` into a way to spell a pinned method unpinned.
    const readings = decoded === undefined || decoded === raw ? [raw] : [raw, decoded]
    const named = readings
      .map(reading => endpointOf(reading, this.apiPathPrefix))
      .filter(endpoint => endpoint !== undefined)
    if (named.length === 0) return true
    // A session authenticates a device; the configuration plane additionally
    // requires being at the machine, so it never travels to a paired device.
    if (!named.some(endpoint => isPrivilegedEndpoint(endpoint, this.authority))) return true
    return isLoopbackAddress(req.socket.remoteAddress)
  }

  /**
   * Register a named route behind admission.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  override register(route: WebRoute): () => void {
    const inner = route.handler
    this.claimedPaths.add(route.path)
    return super.register({
      ...route,
      handler: async (req, res) => {
        if (!this.permits(req, this.posture(route.path))) {
          res.writeHead(403)
          res.end(REFUSAL_BODY)
          return
        }
        await inner(req, res)
      },
    })
  }

  /**
   * Register an upgrade route behind the same admission; a refused handshake is
   * rejected before protocol negotiation, so no event stream ever starts.
   * @param route - pathname and handler owning negotiation plus socket use.
   * @returns the disposer removing the route.
   */
  override registerUpgrade(route: WebUpgradeRoute): () => void {
    const inner = route.handler
    this.claimedPaths.add(route.path)
    return super.registerUpgrade({
      ...route,
      handler: (req, socket, head) => {
        if (!this.permits(req, this.posture(route.path))) {
          // `end` rather than `write` + `destroy`: writes are queued, and
          // destroying discards whatever has not reached the kernel, so a
          // refused handshake could arrive as a bare connection reset. The
          // marker distinguishing this gate from upstream's own refusal is
          // exactly what went missing.
          socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${String(REFUSAL_BODY.length)}\r\n\r\n${REFUSAL_BODY}`)
          return
        }
        return inner(req, socket, head)
      },
    })
  }

  /**
   * Claim the fallback seat behind admission. The seat answers every request no
   * named route matched, so it is the widest surface this carrier serves and
   * the one where an absent gate is least visible — nothing registers a path,
   * so no drift warning covers it either.
   * @param handler - owns the full response lifecycle of unmatched requests.
   * @returns the disposer releasing the seat.
   */
  override registerFallback(handler: WebRoute['handler']): () => void {
    return super.registerFallback(async (req, res) => {
      if (!this.permits(req, this.fallbackAdmission)) {
        res.writeHead(403)
        res.end(REFUSAL_BODY)
        return
      }
      await handler(req, res)
    })
  }
}

export default GatedWebServer
