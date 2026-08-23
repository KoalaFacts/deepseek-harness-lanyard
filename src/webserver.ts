/**
 * The gated carrier: a `WebServer` subclass adding pairing-token admission and
 * TLS without any change to the harness.
 *
 * Consumers contribute routes through three seats — `ctx.webServer.register`,
 * `registerUpgrade`, and the single-owner `registerFallback` that answers
 * everything no named route matched. Wrapping all three puts admission in
 * front of every request the composition serves, including `/api`, which
 * `dsh-client-connection` registers verbatim and which therefore needs no
 * modification. {@link assertRegistrarsWrapped} fails the load if a future
 * harness grows a fourth, because an unwrapped seat serves the network with no
 * gate at all and nothing else would notice.
 *
 * TLS is terminated here and the decrypted socket is handed to the inherited
 * HTTP server, which preserves `req.socket.remoteAddress` as the real client
 * address. That is the property admission depends on: a TCP-forwarding proxy
 * would make every request read as a loopback peer and silently disable the
 * token gate entirely.
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
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { admit, assertPairingToken, isLoopbackAddress } from './admission.ts'
import { GENERATE_TOKEN_HINT, resolvePairingToken } from './credentials.ts'

/**
 * Every route path this gate keys on is owned by a *client-side* package —
 * `API_PATH` in `dsh-client-connection`, `EVENTS_ENDPOINT` in
 * `dsh-client-hmr`, the bundle prefix in `dsh-client-modules` — so none of them
 * is this plugin's to hardcode. They are schema defaults a deployment can
 * restate, per the harness rule that anything two deployments may set
 * differently is a configuration field.
 *
 * Two of them fail OPEN when they drift: an `/api` prefix that no longer
 * matches makes every endpoint read as unprivileged, and a reload endpoint that
 * moved is no longer pinned. {@link GatedWebServer} therefore warns about any
 * configured path that no row ever claimed, so a rename surfaces as a
 * diagnostic instead of as a quietly widened surface.
 */

/** Route prefix owning every api request; `dsh-client-connection`'s `API_PATH`. */
export const DEFAULT_API_PATH_PREFIX = '/api'

/** Endpoints pinned to a loopback peer even for an authenticated caller. */
export const DEFAULT_PRIVILEGED_METHODS: readonly string[] = [
  'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
  'host.pickDirectory', 'host.openPath',
  'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
  'credentials.describe', 'credentials.set', 'credentials.unset',
  'llm.discoverModels',
]

/**
 * Typert Gateway namespaces a paired device may reach. The Gateway claims every
 * `namespace/method` a live remote service exposes, so this space grows with the
 * composition; anything unlisted is loopback-only, which keeps a service this
 * build has never seen from becoming LAN-reachable merely by appearing. A
 * deployment adds its own namespace deliberately — the default denies.
 */
export const DEFAULT_PAIRED_NAMESPACES: readonly string[] = ['commands', 'goals', 'messageFeedback']

/**
 * Body of a refusal this gate issued.
 *
 * Deliberately not the bare `forbidden` that `dsh-client-connection`'s own Host
 * fence answers with: an operator reading a 403, and the end-to-end suite
 * deciding whether admission or the Host fence refused, cannot tell two
 * identical bodies apart.
 */
export const REFUSAL_BODY = 'lanyard: forbidden'

/** Routes served without admission: the browser must load the shell before it holds a token. */
export const DEFAULT_PUBLIC_PATHS: readonly string[] = ['/plugins']

/**
 * Suffixes excluded from every public path. `/plugins` must stay anonymous so
 * the shell can boot before a token exists, but the client bundles it serves
 * carry source maps, and handing a LAN peer the full client source for free is
 * not part of "load the shell".
 */
export const DEFAULT_PUBLIC_PATH_EXCLUDED_SUFFIXES: readonly string[] = ['.map']

/**
 * Routes a paired device may not reach at all, whatever it presents.
 *
 * `/plugins/events` is the dev reload channel: it has no admission of its own,
 * its connections are uncapped and live until their client closes, and the
 * rebuild watcher feeding it runs on this machine anyway. On a network bind
 * that combination is a socket sink, and pairing buys a remote device nothing
 * it could use.
 */
export const DEFAULT_LOOPBACK_ONLY_PATHS: readonly string[] = ['/plugins/events']

/**
 * Admission posture for one seat: served to anyone, gated on the pairing token,
 * or pinned to a peer on this machine.
 */
export type Admission = 'public' | 'gated' | 'loopback-only'

/**
 * Posture of the fallback seat, which in the shipped Web composition is
 * `dsh-host-frontend-static` serving the built SPA.
 *
 * Public by default, and deliberately so: the pairing token reaches the browser
 * through the bootstrap injected into the index, and the index's own asset tags
 * are discovered by the preload scanner before that inline script has run. A
 * gated posture therefore refuses the first load of a freshly paired device —
 * intermittently, and only the first time, which is the worst way for this to
 * fail. The exempted surface is the built frontend, which carries no secret;
 * {@link Config.publicPathExcludedSuffixes} still applies, so source maps never
 * ride the exemption. A deployment serving something else from this seat can
 * pin it with {@link Config.fallbackAdmission}.
 */
export const DEFAULT_FALLBACK_ADMISSION: Admission = 'public'

/** How an `/api` endpoint's reachability is decided, as one deployment classified it. */
export interface EndpointAuthority {
  /** Dot-form methods pinned to a loopback peer. */
  privilegedMethods: ReadonlySet<string>
  /** Gateway namespaces a paired device may reach; anything else is pinned. */
  pairedNamespaces: ReadonlySet<string>
}

/** The shipped classification, used when a caller names none. */
export const DEFAULT_ENDPOINT_AUTHORITY: EndpointAuthority = {
  privilegedMethods: new Set(DEFAULT_PRIVILEGED_METHODS),
  pairedNamespaces: new Set(DEFAULT_PAIRED_NAMESPACES),
}

/** Gated carrier config: the upstream listen fields plus this plugin's own. */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Credential reference holding the pairing token — the form a deployment
   * configures, so no config surface ever carries the secret itself.
   */
  pairingTokenEnv?: string
  /**
   * A literal pairing token, for a composition with no credentials seam (tests,
   * embedding hosts). Mutually exclusive with {@link Config.pairingTokenEnv};
   * prefer the reference in anything a person configures.
   */
  pairingToken?: string
  /** PEM certificate path; set with {@link tlsKeyPath} to serve HTTPS. */
  tlsCertPath?: string
  /** PEM private-key path — a path, never inline material, so config surfaces cannot carry the key. */
  tlsKeyPath?: string
  /** Route paths served without admission; defaults to the client-bundle prefix. */
  publicPaths?: string[]
  /** Suffixes a public path does not cover; defaults to source maps. */
  publicPathExcludedSuffixes?: string[]
  /** Route paths no paired device may reach; defaults to the dev reload channel. */
  loopbackOnlyPaths?: string[]
  /**
   * Posture of the fallback seat — the handler answering every request no named
   * route matched. See {@link DEFAULT_FALLBACK_ADMISSION} for why the built
   * frontend is served publicly and when to pin it.
   */
  fallbackAdmission?: Admission
  /** Route prefix owning api requests; defaults to `dsh-client-connection`'s. */
  apiPathPrefix?: string
  /** Dot-form api methods pinned to a loopback peer. */
  privilegedMethods?: string[]
  /** Gateway namespaces a paired device may reach; anything else is pinned. */
  pairedNamespaces?: string[]
}

export const Config: z<Config> = z.object({
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
  port: z.natural().max(65535).required(),
  pairingTokenEnv: z.string(),
  pairingToken: z.string(),
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
})

/**
 * Whether an `/api` endpoint stays pinned to a loopback peer. Dot-form API
 * Proxy methods are named individually; the Gateway's slash form is decided by
 * namespace, so a method added to an unlisted namespace inherits the pin rather
 * than defaulting to reachable.
 * @param endpoint - endpoint identity, either `method` or `namespace/method`.
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
 * reachable without a token.
 *
 * It recognises a seat by its `register` prefix, which is how all three of the
 * current ones are named. That is a naming convention rather than a guarantee,
 * so a differently named seat would still need catching by review — claiming
 * more than this is the same overreach that hid the fallback in the first place.
 * @param prototype - the carrier prototype to inspect; the inherited one by default.
 * @throws when an unrecognised `register*` method exists upstream.
 */
export function assertRegistrarsWrapped(prototype: object = WebServer.prototype): void {
  const unwrapped = Object.getOwnPropertyNames(prototype)
    .filter(name => name.startsWith('register') && !WRAPPED_REGISTRARS.includes(name))
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
  /** Resolved before the socket binds, so no request can arrive while it is still undefined. */
  private token: string | undefined
  private tls: TlsServer | undefined
  private tlsPort: number | undefined

  constructor(ctx: Context, config: Config) {
    assertRegistrarsWrapped()
    // With TLS the inherited server must not own the public port: this class
    // binds it and forwards decrypted sockets, so the parent gets an ephemeral
    // loopback socket whose only role is to route what TLS hands it.
    const servesTls = config.tlsCertPath !== undefined && config.tlsKeyPath !== undefined
    super(ctx, servesTls ? { host: '127.0.0.1', port: 0 } : { host: config.host, port: config.port })
    if (config.pairingToken !== undefined) {
      if (config.pairingTokenEnv !== undefined) {
        throw new Error('lanyard: configure either pairingTokenEnv or pairingToken, not both')
      }
      assertPairingToken(config.pairingToken)
    }
    if ((config.tlsCertPath === undefined) !== (config.tlsKeyPath === undefined)) {
      throw new Error('lanyard: tlsCertPath and tlsKeyPath must be configured together')
    }
    if (config.host === '0.0.0.0' && config.pairingToken === undefined && config.pairingTokenEnv === undefined) {
      throw new Error(
        'lanyard: an all-interfaces bind requires a pairing token, because the /api surface runs commands as this process; '
        + GENERATE_TOKEN_HINT,
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
      // A pin that matches nothing leaves the route merely token-gated.
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

  /** The port clients reach: the TLS listener when serving HTTPS, else the inherited one. */
  override get port(): number {
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

  /** Resolve the pairing token, listen, and add the TLS frontend when material is configured. */
  override async [Service.init](): Promise<void> {
    // Before super(): resolution is async and admission is not, so the token
    // must be in place before the socket that carries requests exists.
    this.token = this.gate.pairingToken ?? await resolvePairingToken(this.ctx, this.gate.pairingTokenEnv)
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
   * Posture configured for one named route path. Anything not named is gated,
   * so a route added upstream is admitted no more freely than `/api` is.
   * @param routePath - the path the owning row registered.
   */
  private posture(routePath: string): Admission {
    if (this.loopbackOnlyPaths.includes(routePath)) return 'loopback-only'
    if (this.publicPaths.includes(routePath)) return 'public'
    return 'gated'
  }

  /**
   * Whether a request may reach the handler occupying one seat.
   * @param req - the inbound request, read for its token and its socket peer.
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
    if (!admit(req, this.token)) return false
    // Both readings are classified: upstream resolves the endpoint from the raw
    // pathname and rejects a `%` outright, but a version that starts decoding
    // would otherwise turn `%2E` into a way to spell a pinned method unpinned.
    const readings = decoded === undefined || decoded === raw ? [raw] : [raw, decoded]
    const named = readings
      .map(reading => endpointOf(reading, this.apiPathPrefix))
      .filter(endpoint => endpoint !== undefined)
    if (named.length === 0) return true
    // Pairing authenticates a device; the configuration plane additionally
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
          socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${String(REFUSAL_BODY.length)}\r\n\r\n${REFUSAL_BODY}`)
          socket.destroy()
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
