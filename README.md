# DeepSeek Harness Lanyard

English | [简体中文](README.zh.md)

Open the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI on your phone.

Run `dsh` on your machine as usual, open one link on the phone, and the GUI is there — on your own network, behind a pairing token. Nothing else on the network can reach it.

That is all this does. It is not a gateway, not a reverse proxy, and not a way to reach your machine from outside your own network.

## Why this needs a plugin

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface runs commands as the `dsh` process, so an unauthenticated LAN bind hands remote code execution to anyone on the network. That refusal also blocks the case it protects — picking up a session from the sofa.

This supplies the missing authentication, so the bind becomes safe. **No harness source changes**; it installs as an ordinary plugin bundle.

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

### Flags

| Flag | |
|---|---|
| `--host 0.0.0.0` | serve the LAN; requires a pairing token |
| `--pairing-token-env <name>` | credential holding the token (16+ chars of `A-Za-z0-9_-`) |
| `--keep-awake` | hold the machine awake so sleep cannot cut the phone off mid-session |
| `--port`, `--no-open`, `--trusted-host` | as shipped |

The token is named by **reference**, never by value, so no configuration surface (`dsh --dump-config`, crash dumps) can leak it. It resolves from the environment, the credential store, or a `.env` layer.

## On the phone

Open the printed link once. The page stores the token, strips it from the address bar, and presents it on every later visit — so plain `https://192.168.1.5:3080` works from then on. Add it to your home screen if you want it to open like an app.

Three things to expect:

- **Both devices must be on the same network.** The link uses your machine's LAN address; there is no relay and nothing leaves your network.
- **The certificate warning is normal.** It is self-signed, so the phone asks you to trust it the first time. The token is what protects the connection, not the certificate.
- **A new network means a new link.** If the machine's LAN address changes, re-open whatever the startup line prints.

## What a paired phone can reach

Pairing authenticates a *device*, not a person at the machine. So the phone gets the session surface — chat, commands, goals — while anything that reconfigures the install stays where you are:

- **Refused for everyone but a loopback peer:** settings, credentials, agent presets, native dialogs, model discovery, and any Gateway namespace this build has not deliberately classified.
- **The token never goes on the wire.** `#auth=…` lives only in the URL fragment, which no browser sends, so it reaches neither the server logs nor any proxy.
- **TLS is terminated in-process**, which preserves the real client address. A forwarding proxy in that seat would make every request look local and disable the gate entirely.

## Limitations

- **One shared secret, no revocation.** Rotating means changing the credential and restarting; a single device cannot be un-paired.
- **A tunnel counts as local.** `adb reverse` or `ssh -R` makes the phone a loopback peer, skipping the token *and* reaching the configuration plane. Treat it as handing over your keyboard.
- **The token is readable by page scripts** — necessarily, since the browser half stores it.
- **Coupled to the carrier it subclasses.** A future `@deepseek-ai/dsh-host-webserver` could break it — loudly, by design, never by quietly serving plaintext.

## Configuration

You should never need any. Defaults are safe and deny by default. The one field worth knowing about is `pairedNamespaces`, which decides what a paired phone may reach; everything unlisted is loopback-only, so it only ever widens deliberately. Fields and how to override them: [AGENTS.md](AGENTS.md).

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
