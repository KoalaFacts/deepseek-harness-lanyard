# DeepSeek Harness Lanyard

English | [简体中文](README.zh.md)

Open the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI on your phone.

Run `dsh` on your machine as usual, scan one code with the phone, and the GUI is there — on your own network, over TLS. Nothing else on the network gets past dsh's sign-in, and the machine's own browser tab keeps the address it always had.

That is all this does. It is not a gateway, not a reverse proxy, and not a way to reach your machine from outside your own network.

## Why this needs a plugin

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface runs commands as the `dsh` process. Since 0.1.2, dsh authenticates every browser itself — the `?token=` link on its startup line signs a browser in — but it still will not serve the network: it speaks plain HTTP, and it treats any signed-in browser as the person at the keyboard.

This lifts the refusal and supplies what a network bind still lacks: TLS, dsh's own session check in front of every route a network device can reach, and a configuration plane that stays at the machine. It adds no login of its own. **No harness source changes**; it installs as an ordinary plugin bundle.

## Install

```sh
dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard
```

Or, where the web sidebar has a **Plugins** page, install it there by the same name; it is listed as *Lanyard — phone access*.

Installing changes nothing on its own: dsh goes on serving this machine only. Serving your network is a choice you make each time you start it:

```sh
dsh --profile web --host 0.0.0.0
```

This machine keeps its usual `http://127.0.0.1:3080`, and devices on the network get TLS on a port of their own, 3443 by default. On startup it prints the pairing link, the certificate's fingerprint, and a QR code of the link:

```
lanyard: serving your network over TLS on port 3443 — do not open the (LAN: …) link on the dsh web line: it is plain http and carries the launch token
lanyard: pair a device by opening https://192.168.1.5:3443/?token=<launch token> once
lanyard: the phone should show certificate SHA-256 7F:52:AF:73:DB:4B:08:A0:9E:56:2D:83:B1:C5:7D:AF:0C:ED:3D:9A:F8:88:B9:B8:8C:27:3A:7A:2A:02:E4:B3 — if it ever shows another, do not continue
lanyard: or scan this with the phone
```

Ignore the `(LAN: …)` link on dsh's own `dsh web:` line: it is plain http and carries the launch token. Nothing answers it, but someone impersonating your machine on the network could.

### Flags

| Flag | |
|---|---|
| `--host 0.0.0.0` | serve your network over TLS, and print the pairing link |
| `--network-port <port>` | the port devices on the network reach; 3443 unless you name one |
| `--keep-awake` | hold the machine awake so sleep cannot cut the phone off mid-session |
| `--port`, `--no-open`, `--trusted-host` | as shipped; `--port` stays this machine's own |

Needs dsh 0.1.5-rc.3 or later, before 0.2. From 0.1.7, dsh checks that window itself and will neither install nor load the bundle outside it, so `--host 0.0.0.0` is refused as usual. An older dsh does not check; one without its own browser sign-in (before 0.1.2) makes this fail loudly at startup and refuse every device on the network, rather than serve it without one.

## On the phone

Point the camera at the QR code in the terminal. That is the whole pairing step — the link carries dsh's launch token, 43 random characters nobody should be typing on a phone keyboard. (The link is printed too, if you would rather send it to yourself.)

The first time, the phone warns that the certificate is not trusted: it is self-signed, made on your machine. Open the certificate's details and compare its SHA-256 fingerprint with the one on the startup line before you accept — all of it, or at least the first and last eight pairs, since a look-alike matching only a few is cheap to make. That comparison is the only check a self-signed certificate has, so make it every time the phone asks — and if the two ever differ, stop. Nothing is sent before you accept, not even the token in the link.

Opening the link signs the phone in: dsh swaps the token for a session cookie and redirects to the plain address, so the token leaves the address bar at once. From then on `https://192.168.1.5:3443` just works, across restarts, until the session expires — 30 days by default. Add it to your home screen if you want it to open like an app.

Three things to expect:

- **Both devices must be on the same network.** The link uses your machine's LAN address; there is no relay and nothing leaves your network. On a machine with more than one network, the code names the likeliest home network, and a link is printed for each other network a phone could be on (container and virtual-machine networks are left out). If those are all it finds, it prints no link and says so.
- **The link is a password until dsh restarts.** Anyone who opens it before then is signed in, so do not paste it into a group chat or leave the code on a shared screen. Restarting dsh retires it; phones already paired stay signed in.
- **A new network means a new link.** The session is bound to the address it was opened on. If the machine's LAN address changes, scan what the startup line prints.

## What a paired phone can reach

**A paired phone has your account on this machine.** What it reaches includes a terminal and an agent that runs commands, both as you, so whatever you could do at the keyboard it can do too — editing dsh's configuration files by hand included. Pair only devices you own, and treat losing one like losing a laptop that is signed in.

What stays at the machine is the GUI's configuration plane, and the network never meets an unguarded route:

- **Refused for everyone but a loopback peer:** settings, credentials, the account, model providers, installing or inspecting plugins, anything that opens something on the machine's own screen, and any Gateway namespace or `/api` route this build has not deliberately classified. That keeps credentials off the phone's screen and a stray tap from reconfiguring the install. It is not a wall against a device you paired — see above.
- **dsh's session is checked in front of every route**, not only the ones dsh guards itself, so a route whose owner forgets to check reaches no one on the network.
- **The session cookie only travels inside TLS.** dsh does not mark it `Secure`; this does, on the network listener, so a phone that later opens a plain `http://` address on this machine does not send it in the clear.
- **TLS is terminated in-process**, which preserves the real client address. A forwarding proxy in that seat would make every request look local, and lift both the session check and the configuration pin.
- **The GUI's own static files are not behind the session.** Pairing arrives on the same route that serves them, before the phone has a session; they carry no secret, and source maps stay excluded. dsh signs in the page itself, and everything the loaded page does needs the session.

## Limitations

- **`--host 0.0.0.0` means every network this machine is on** — Wi-Fi, Ethernet, a VPN. Anything on them can reach the TLS listener, though nothing gets past it without a session. Use it on networks you trust, not café or hotel Wi-Fi.
- **Signing one device out signs out all of them.** Every session is signed by one secret — the `client-connection` browser-session record in dsh's credential store — and replacing it is the only revocation there is.
- **A tunnel counts as local.** `adb reverse` or `ssh -R` makes the phone a loopback peer: it still needs dsh's session, but reaches the configuration plane. Treat it as handing over your keyboard.
- **Streams are admitted as a whole.** They share one WebSocket, which this can admit or refuse but not look inside, so a paired phone could open a stream in a namespace it is otherwise refused — today only read-only account status, and the experimental voice bundle's stream where that is installed. The same socket carries the notifications every browser gets, configuration activity included (that a setting or a credential changed, a plugin install's log), though never the values themselves. The GUI makes every change as an HTTP call, where each one is classified, but nothing in the protocol requires that.
- **Coupled to the carrier it subclasses and the sign-in it relies on.** A future dsh could break it — loudly, by design, never by quietly serving plaintext or letting an unauthenticated device in.

## Configuration

You should never need any. Defaults are safe and deny by default. A few fields are worth knowing about: `pairedNamespaces` and `pairedRoutes` decide what a paired phone may reach, and everything unlisted is loopback-only, so they only ever widen deliberately; `networkPort` is what `--network-port` sets; `fallbackAdmission` decides how the GUI's own static files are served, and defaults to serving them — `gated` would stop new devices from pairing at all. Fields and how to override them: [AGENTS.md](AGENTS.md).

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
