# DeepSeek Harness Lanyard

English | [简体中文](README.zh.md)

Use the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI from your phone, over your own network, behind a pairing token.

Pair a device once by opening a link. After that the plain address works, and nothing else on the network can reach it.

## Why

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface runs commands as the `dsh` process, so an unauthenticated LAN bind hands remote code execution to anyone on the network. That refusal also blocks the case it protects — picking up a session from the sofa.

`lanyard` supplies the missing authentication, so the bind becomes safe.

**No harness source changes.** It installs as an ordinary plugin bundle.

## Install

```sh
dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard
```

```sh
export DSH_PAIRING_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
dsh --profile web --host 0.0.0.0 --pairing-token-env DSH_PAIRING_TOKEN
```

The pairing link is printed on startup:

```
lanyard: pair a device by opening https://192.168.1.5:3080/#auth=<token> once
```

Open it once on the phone and accept the self-signed certificate. The page stores the token, strips it from the address bar, and presents it on every later visit — so `https://192.168.1.5:3080` just works from then on.

### Flags

| Flag | |
|---|---|
| `--host 0.0.0.0` | serve the LAN; requires a pairing token |
| `--pairing-token-env <name>` | credential holding the token (16+ chars of `A-Za-z0-9_-`) |
| `--keep-awake` | hold the machine awake so sleep cannot cut off the phone |
| `--port`, `--no-open`, `--trusted-host` | as shipped |

The token is named by **reference**, never by value, so no configuration surface (`dsh --dump-config`, crash dumps) can leak it. It resolves from the environment, the credential store, or a `.env` layer.

## What a paired phone can do

Pairing authenticates a *device*, not a person at the machine. So a paired phone gets the session surface — chat, commands, goals — while anything that reconfigures the install stays where you are:

- **Refused for everyone but a loopback peer:** settings, credentials, agent presets, native dialogs, model discovery, and any Gateway namespace this build has not deliberately classified.
- **The fragment is never sent.** `#auth=…` lives only in the URL fragment, which no browser puts on the wire, so the token reaches neither the server logs nor any proxy.
- **TLS is terminated in-process**, which preserves the real client address. A forwarding proxy in that seat would make every request look local and disable the gate entirely.

## Limitations

- **One shared secret, no revocation.** Rotating means changing the credential and restarting; a single device cannot be un-paired.
- **A tunnel counts as local.** `adb reverse` or `ssh -R` makes the device a loopback peer, skipping the token *and* reaching the configuration plane. Treat it as handing over your keyboard.
- **The token is readable by page scripts** — necessarily, since the browser half stores it.
- **Self-signed certificate**, accepted once per device. A network change re-prompts; serving still works, because admission never depends on the certificate.
- **Coupled to the carrier it subclasses.** A future `@deepseek-ai/dsh-host-webserver` could break it — loudly, by design, never by quietly serving plaintext.

## Configuration

Defaults are safe and deny by default; override in your profile's `cordis.patch.yml`, restating the whole `lanyard-webserver` row.

| Field | Default |
|---|---|
| `pairedNamespaces` | `commands`, `goals`, `messageFeedback` — anything else is loopback-only |
| `privilegedMethods` | the pinned configuration plane |
| `apiPathPrefix`, `publicPaths`, `loopbackOnlyPaths`, `publicPathExcludedSuffixes` | the paths the shipped client packages use |

Those paths belong to client packages, not to this plugin, so they are configuration rather than constants. If one ever stops matching, the carrier warns at startup and names it.

## Development

```sh
pnpm install
npm run check              # typecheck, unit suite, build gate
npm run test:e2e           # boot a real dsh and drive the gate over TLS
npm run test:e2e:browser   # the pairing flow in a real browser
```

Architecture and the invariants that must not break: [AGENTS.md](AGENTS.md).

## License

MIT
