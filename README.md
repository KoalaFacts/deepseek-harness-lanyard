# DeepSeek Harness Lanyard

English | [简体中文](README.zh.md)

Open the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI on your phone.

Run `dsh` on your machine as usual, scan one code with the phone, and the GUI is there — on your own network, over TLS. Nothing else on the network reaches your session or your machine.

That is all this does. It is not a gateway, not a reverse proxy, and not a way to reach your machine from outside your own network.

## Why this needs a plugin

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface runs commands as the `dsh` process. Since 0.1.2, dsh authenticates every browser itself — the `?token=` link on its startup line signs a browser in — but it still will not serve the network: it speaks plain HTTP, and it treats any signed-in browser as the person at the keyboard.

This lifts the refusal and supplies what a network bind still lacks: TLS, dsh's own session check in front of every route a network device can reach, and a configuration plane that stays at the machine. It adds no login of its own. **No harness source changes**; it installs as an ordinary plugin bundle.

## Install

```sh
dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard
```

```sh
dsh --profile web --host 0.0.0.0
```

On startup it prints the pairing link and a QR code of it:

```
lanyard: serving your network over TLS on port 3080 — the LAN address on the dsh web line is not reachable from other devices
lanyard: pair a device by opening https://192.168.1.5:3080/?token=<launch token> once
lanyard: or scan this with the phone
```

### Flags

| Flag | |
|---|---|
| `--host 0.0.0.0` | serve your network over TLS, and print the pairing link |
| `--keep-awake` | hold the machine awake so sleep cannot cut the phone off mid-session |
| `--port`, `--no-open`, `--trusted-host` | as shipped |

Needs dsh 0.1.2 or later, the first with its own browser sign-in. On anything older it fails loudly at startup and refuses every device on the network, rather than serve it without one.

## On the phone

Point the camera at the QR code in the terminal. That is the whole pairing step — the link carries dsh's launch token, 43 random characters nobody should be typing on a phone keyboard. (The link is printed too, if you would rather send it to yourself.)

Opening it signs the phone in: dsh swaps the token for a session cookie and redirects to the plain address, so the token leaves the address bar at once. From then on `https://192.168.1.5:3080` just works, across restarts, until the session expires — 30 days by default. Add it to your home screen if you want it to open like an app.

Three things to expect:

- **Both devices must be on the same network.** The link uses your machine's LAN address; there is no relay and nothing leaves your network.
- **The certificate warning is normal.** It is self-signed, so the phone asks you to trust it the first time. Nothing is sent until you accept — not even the token in the link.
- **A new network means a new link.** The session is bound to the address it was opened on. If the machine's LAN address changes, scan what the startup line prints.

## What a paired phone can reach

Pairing signs in a *device*, not a person at the machine. So the phone gets the session surface — chats, workspaces and their files, background jobs, the terminal, and answering the agent's approvals and questions — while anything that reconfigures the install stays where you are:

- **Refused for everyone but a loopback peer:** settings, credentials, the account, model providers, installing or inspecting plugins, anything that opens something on the machine's own screen, and any Gateway namespace this build has not deliberately classified.
- **dsh's session is checked in front of every route**, not only the ones dsh guards itself, so a route whose owner forgets to check reaches no one on the network.
- **TLS is terminated in-process**, which preserves the real client address. A forwarding proxy in that seat would make every request look local, and lift both the session check and the configuration pin.
- **The GUI's own static files are not behind the session.** Pairing arrives on the same route that serves them, before the phone has a session; they carry no secret, and source maps stay excluded. dsh signs in the page itself, and everything the loaded page does needs the session.

## Limitations

- **Signing one device out signs out all of them.** Every session is signed by one secret — the `client-connection` browser-session record in dsh's credential store — and replacing it is the only revocation there is.
- **A tunnel counts as local.** `adb reverse` or `ssh -R` makes the phone a loopback peer: it still needs dsh's session, but reaches the configuration plane. Treat it as handing over your keyboard.
- **Streams are not classified one by one.** They share one WebSocket, admitted as a whole, so a paired phone could follow a stream in a namespace it is otherwise refused — today, only the read-only account status. Every write goes over HTTP, where each call is classified.
- **Coupled to the carrier it subclasses and the sign-in it relies on.** A future dsh could break it — loudly, by design, never by quietly serving plaintext or letting an unauthenticated device in.

## Configuration

You should never need any. Defaults are safe and deny by default. Two fields are worth knowing about: `pairedNamespaces` decides what a paired phone may reach, and everything unlisted is loopback-only, so it only ever widens deliberately; `fallbackAdmission` decides how the GUI's own static files are served, and defaults to serving them — `gated` would stop new devices from pairing at all. Fields and how to override them: [AGENTS.md](AGENTS.md).

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
