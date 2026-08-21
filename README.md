# lanyard

Secure LAN access for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI: a pairing token and self-signed TLS, shipped as an out-of-tree `dsh` plugin.

**No harness source changes.** `lanyard` installs into a profile as an ordinary bundle. It replaces two rows — the command-line provider and the HTTP carrier — and every other plugin, `dsh-client-connection` included, runs unmodified.

## Why this exists

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface executes commands as the `dsh` process, so an unauthenticated LAN bind hands remote code execution to the network. That refusal also blocks the legitimate case it protects — using the GUI from your phone on your own network.

`lanyard` supplies the missing authentication layer so the bind becomes safe.

## Install

```sh
dsh plugin --profile web add @koalafacts/lanyard
```

Then run with a token and an all-interfaces bind:

```sh
export DSH_PAIRING_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
dsh --profile web --host 0.0.0.0 --pairing-token-env DSH_PAIRING_TOKEN
```

`lanyard` prints the pairing link on the readiness line:

```
dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)
lanyard: serving TLS — the local URL is https://127.0.0.1:3080
lanyard: pair a device by opening https://192.168.1.5:3080/#auth=<token> once
```

Open that link once on the other device. The page stores the token, strips it from the address bar, and republishes it as a cookie on every boot; afterwards the bare `https://192.168.1.5:3080` reconnects. The certificate is self-signed, so each device accepts it once.

### Flags

| Flag | Meaning |
|---|---|
| `--host <host>` | bind host; `0.0.0.0` serves the LAN and requires a pairing token |
| `--port <port>` | listen port; `0` lets the OS pick |
| `--no-open` | do not open the Web UI in the default browser (shipped flag, preserved) |
| `--pairing-token-env <name>` | credential holding the pairing token (at least 16 characters of `A-Za-z0-9_-`) |
| `--trusted-host <authority...>` | extra authority the `/api` Host fence accepts; requires a pairing token |
| `--keep-awake` | hold the platform sleep inhibitor while `dsh` serves |

The token is named by **reference**, never by value: `--pairing-token-env DSH_PAIRING_TOKEN` resolves through `ctx.credentials`, so the secret may live in the environment, the managed credential store, or a `.env` layer, and no configuration surface (`dsh --dump-config`, the plugin-inventory RPC, a crash dump) ever carries it.

## How it works

Five rows, two of which take seats the shipped composition already had.

| Row | Replaces | Does |
|---|---|---|
| `lanyard-startup` | `web-startup` | parses the flag family and provides `webStartup`; lifts the `--host 0.0.0.0` refusal and replaces it with "an all-interfaces bind requires a pairing token" |
| `lanyard-tls` | — | generates a persistent self-signed certificate on the first network-serving boot |
| `lanyard-webserver` | `webserver` | `GatedWebServer`: admission in front of every route, TLS in front of the server |
| `lanyard-keep-awake` | — | holds the platform sleep inhibitor under `--keep-awake` |
| `lanyard-pairing` | — | injects the browser half into `index.html` and prints the pairing link |

### Configuring the gate

Every route path the gate keys on is owned by a **client-side** package, not by this plugin: `API_PATH` in `dsh-client-connection`, `EVENTS_ENDPOINT` in `dsh-client-hmr`, the bundle prefix in `dsh-client-modules`. Any of them can be renamed by a harness upgrade or replaced by a deployment that mounts a different plugin, so all of them are configuration fields with schema defaults rather than constants.

| Field | Default | Effect if stale |
|---|---|---|
| `apiPathPrefix` | `/api` | **fails open** — every endpoint reads as unprivileged, so the configuration plane stops being pinned |
| `loopbackOnlyPaths` | `['/plugins/events']` | **fails open** — the reload channel is only token-gated, not pinned |
| `publicPaths` | `['/plugins']` | fails closed — the shell cannot load |
| `publicPathExcludedSuffixes` | `['.map']` | fails closed — maps served like bundles |
| `privilegedMethods` | the pinned dot-form methods | **fails open** — an unpinned method reaches a paired device |
| `pairedNamespaces` | `commands`, `goals`, `messageFeedback` | fails closed — an unlisted namespace is loopback-only |

Because two of these fail open, `GatedWebServer` warns once the tree settles about any configured path **no row ever claimed**, naming which ones leave a surface less guarded than intended. A rename upstream surfaces as a diagnostic instead of as a quietly widened LAN surface.

To change one, restate the whole row in your profile's `cordis.patch.yml` — a patch replaces a row's entire `config`:

```yaml
- id: lanyard-webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    pairingTokenEnv: !!js ctx.webStartup.pairingTokenEnv
    tlsCertPath: !!js ctx.lanyardTls.paths?.certPath
    tlsKeyPath: !!js ctx.lanyardTls.paths?.keyPath
    # Reach a namespace your own plugin exposes. Anything unlisted stays
    # loopback-only, so this list only ever widens deliberately.
    pairedNamespaces: [commands, goals, messageFeedback, myPlugin]
```

### The gate

Every consumer registers its routes through `ctx.webServer.register` and `registerUpgrade`. `GatedWebServer` overrides both, so admission runs in front of every route the composition serves without any consumer knowing:

- **Admission** — a request from a non-loopback socket peer must present the token as the `dsh_auth` cookie or `Authorization: Bearer`, compared constant-time over sha256 digests.
- **Loopback is the socket peer, never the `Host` header.** On an all-interfaces bind any client reaching the socket can claim `Host: localhost`, so a header-derived exemption would be a complete bypass.
- **TLS is terminated here** and the decrypted socket is handed to the inherited HTTP server. That preserves `req.socket.remoteAddress` as the real client address — a TCP-forwarding proxy would make every request read as loopback and silently disable the gate. `tests/gated-webserver.spec.ts` connects from a real LAN address to hold this property down.
- **The configuration plane stays pinned to a loopback peer** even for an authenticated caller: pairing authenticates a device, while settings, credentials, native dialogs, and the self-modification runtime additionally require being at the machine.
- **Unknown Gateway namespaces fail closed.** The Typert Gateway claims every `namespace/method` a live remote service exposes, so a per-method allowlist would default each new endpoint to reachable. Namespaces are classified whole, and anything unlisted is loopback-only.
- **Client bundles are anonymous; their source maps are not.** `/plugins` must serve before a token exists, or the shell cannot boot — but `sourcemap: true` puts the full client source beside every bundle, so `.map` requests are gated like everything else.
- **The dev reload channel never leaves the machine.** `/plugins/events` is an uncapped, connection-per-client SSE stream with no admission of its own, fed by a watcher that runs locally; it is pinned to a loopback peer rather than merely token-gated.

### The browser half

The pairing link carries `#auth=<token>` in the URL **fragment**, which no browser puts on the wire — so the token reaches neither the server nor its logs. An inline script in `<head>` moves it into `localStorage`, strips it from the address bar, and republishes it as a `SameSite=Strict` cookie on every boot. The browser then attaches that cookie to `/api` fetches and WebSocket upgrades alike, so neither carrier needs token plumbing.

It is an index tap rather than a `dsh.client` roster entry for one reason: the cookie must exist before the shell issues its first `/api` request, and the roster gives no ordering guarantee against `dsh-client-connection`. A classic inline script in `<head>` runs before every deferred module, so the ordering is structural instead of negotiated.

The consequence is that `bootstrapAuthToken` is serialized into the page through `Function.prototype.toString` and must stay entirely self-contained. `npm run build` verifies the built artifact still produces a working script, and fails the build if it does not.

## Known limitations

- **One shared secret, no revocation.** Rotating the token means changing the credential and restarting; there is no way to un-pair a single device.
- **The token is readable by page scripts.** It lives in `localStorage` and a non-`HttpOnly` cookie, necessarily, since the browser half sets it.
- **A forwarding tunnel counts as local.** `adb reverse` or `ssh -R` makes the device a loopback peer, which skips the token *and* reaches the configuration plane. Treat a tunnel as handing over the same authority you have at the keyboard.
- **The SPA shell itself is anonymous.** `dsh-host-frontend-static` claims the webserver's *fallback* seat, which is not a route registration, so the built frontend is served without admission. That is deliberate — the shell has to load before it can hold a token — but it means the dist is readable by any LAN peer.
- **Self-signed certificate.** Each device accepts it once. The SAN carries the LAN addresses sampled at generation, so a network change re-prompts the warning; serving still works, because admission never depends on the certificate.
- **Two readiness lines.** `@deepseek-ai/dsh-web-app` prints its own `dsh web:` line with a hardcoded `http://`; this plugin leaves that row unmodified and prints the corrected scheme and the pairing link beside it.
- **Replacing a row means owning its whole contract.** `lanyard-startup` must publish every `webStartup` field the shipped rows read, and the patch must disable ids that still exist upstream — a missing field falls back to a schema default and a renamed id is skipped with a warning, so both fail quietly. `tests/webstartup-contract.spec.ts` checks both against the installed `@deepseek-ai/dsh-web-app`, not a copy of it.
- **Version-coupled to the carrier.** `GatedWebServer` subclasses `@deepseek-ai/dsh-host-webserver`. TLS additionally needs the inherited `node:http` server; if a future version stops exposing it, the plugin fails its load loudly rather than quietly serving plaintext. Re-run the suite on every harness upgrade.

## Upstream issues this plugin does not fix

Found while building this, verified, and deliberately left alone — each is a harness-side decision, not a plugin one:

- **`host.listDirectory` / `host.createDirectory` are unpinned** while `host.pickDirectory` / `host.openPath` are, so a paired device can enumerate the host filesystem and `mkdir`. Pinning them by default would break the browse-mode directory picker, which is the surface a remote device is *supposed* to use — so the choice is yours: add them to `privilegedMethods` if your deployment does not need remote directory browsing.
- **`/api/respond` is unpinned**, so a paired device can answer approval prompts. Add it to `privilegedMethods` to keep approvals at the machine.

## Verifying it

```sh
pnpm install
npm run check      # typecheck, unit suite, build (the build gate loads the artifact)
npm run test:e2e   # boot a real dsh with this plugin and drive the gate
npm run test:e2e:browser   # do the pairing flow in a real browser
```

`npm run check` runs against published `@deepseek-ai/dsh-*` packages, so no harness checkout is needed. One test connects to the machine's own LAN address to prove TLS preserves the peer address; it is skipped, not silently passed, on a host with no non-loopback IPv4.

`npm run test:e2e` is the one that answers "does this actually work". It packs the plugin as a publishable tarball, installs the **published** `@deepseek-ai/dsh` CLI into a throwaway `DSH_HOME`, runs `dsh plugin add`, boots `dsh --profile web --host 0.0.0.0`, and then drives the running server from the machine's own LAN address over real TLS:

```
  ok   the bundle joined the profile layer stack
  ok   the replacement provider owns the command line
  ok   and still offers the shipped flags it replaced
  ok   the pairing link names the LAN address, the TLS scheme, and the token
  ok   an anonymous LAN peer is refused
  ok   a LAN peer with the wrong token is refused
  ok   a paired LAN peer reaches the api
  ok   a Bearer token is accepted too
  ok   the configuration plane stays at the machine, even for a paired device
  ok   an unclassified Gateway namespace is refused for a paired device
  ok   the uncapped dev reload channel is refused for a paired device
  ok   a source map is refused anonymously
  ok   the loopback peer reaches the configuration plane
  ok   the shell loads for an anonymous LAN peer
  ok   and carries the pairing bootstrap, so the link can adopt the token
```

`npm run test:e2e:browser` covers the half no amount of source-level testing can. Everything else proves the bootstrap as *source* — unit tests evaluate the emitted string against fake globals, the build gate evaluates the built artifact, the HTTP suite finds it in the served index. Only a browser proves that `document.cookie` accepts the attribute string, that the fragment is really stripped, that the cookie is attached to a same-origin `/api` fetch over a self-signed origin, and that it survives a reload at the bare address. Chromium is driven through exactly what a person does:

```
  ok   an unpaired browser is refused by the gate
  ok   and stored nothing to present later
  ok   the browser adopted the token from the fragment
  ok   and republished it as the pairing cookie
  ok   the fragment was stripped from the address bar
  ok   leaving the bare authority
  ok   the paired page reaches the api, cookie attached by the browser alone
  ok   a later visit to the bare address needs no link
  ok   and still reaches the api
  ok   while the configuration plane stays refused, even paired
  ok   a malformed fragment token is not stored
  ok   and never reaches the cookie it could have extended
```

Set `LANYARD_CHROMIUM=/path/to/chrome` when the machine already provides a Chromium whose build does not match this Playwright version, so the suite runs without downloading a second browser.

### Nightly

Push CI runs the e2e against a pinned `dsh` release. `.github/workflows/nightly.yml` covers the other failure mode: this plugin composes against **published** `@deepseek-ai/dsh` packages that move on their own schedule, and it replaces two shipped rows — so an upstream release can break it while nothing in this repo changes. That is not hypothetical; it is how the shipped `--no-open` flag went missing once.

The nightly tracks the newest published release and runs the pinned one beside it, so a failure is interpretable:

| Result | Meaning |
|---|---|
| newest fails, pinned passes | upstream drift — this plugin needs updating |
| both fail | a regression here, or infrastructure |

It also re-runs the row-contract test against the newest published `@deepseek-ai/dsh-web-app`, not the lockfile pin — the pin is reproducible, but it is not what a user installs. A scheduled failure opens (or comments on) a single tracking issue.

`DSH_E2E_VERSION=newest` works locally too, and takes the most recently published version rather than the `latest` dist-tag, which these packages leave pointing at an old build.

Both suites are TypeScript run directly by Node, which strips the types itself — no build step, no runner dependency, and `npm run typecheck` covers them alongside `src/` and `tests/`. That needs Node ≥ 22.18, which the package already requires.

Two deliberate choices in the HTTP script. It tests against the **published** CLI rather than a harness checkout, because a source checkout composes something no user runs — and testing against published packages is what caught a shipped flag going missing. And it distinguishes a refusal by *this gate* from one by `dsh-client-connection`'s own Host fence, which answers 403 as well; without that distinction several checks passed for the wrong reason.

## License

MIT
