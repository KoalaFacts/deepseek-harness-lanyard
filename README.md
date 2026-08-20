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

- **`host.listDirectory` / `host.createDirectory` are unpinned** while `host.pickDirectory` / `host.openPath` are, so a paired device can enumerate the host filesystem and `mkdir`. Pinning them here would break the browse-mode directory picker, which is the surface a remote device is *supposed* to use.
- **`/api/respond` is unpinned**, so a paired device can answer approval prompts.

## Development

```sh
pnpm install
npm run check      # typecheck, test, build (the build gate loads the artifact)
```

The suite runs against published `@deepseek-ai/dsh-*` packages, so no harness checkout is needed. One test connects to the machine's own LAN address to prove TLS preserves the peer address; it is skipped, not silently passed, on a host with no non-loopback IPv4.

## License

MIT
