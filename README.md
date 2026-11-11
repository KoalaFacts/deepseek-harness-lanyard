# DeepSeek Harness Lanyard

English | [简体中文](README.zh.md)

Open the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI on your phone.

Run `dsh` on your machine, explicitly enable your trusted-LAN address, and **verify the phone's HTTPS certificate before scanning the pairing QR code**. Then the GUI is there — on your own network, over TLS. Nothing else on the network gets past dsh's sign-in, and the machine's own browser tab keeps the address it always had.

That is all this does. It is not a gateway, not a reverse proxy, and not a way to reach your machine from outside your own network.

## Why this needs a plugin

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface runs commands as the `dsh` process. Since 0.1.2, dsh authenticates every browser itself — the `?token=` link on its startup line signs a browser in — but it still will not serve the network: it speaks plain HTTP, and it treats any signed-in browser as the person at the keyboard.

This lifts the refusal and supplies what a network bind still lacks: TLS, dsh's own session check in front of every route a network device can reach, and a configuration plane that stays at the machine. It adds no login of its own. **No harness source changes**; it installs as an ordinary plugin bundle.

An explicitly configured named public path (such as client bundles) permits anonymous `GET`/`HEAD` only. Writes through that path still require dsh's own signed-in browser session, so a new upstream handler cannot accidentally become an anonymous `POST` endpoint. **The configured API prefix always requires an upstream session and preserves loopback-only method pins**, even if listed in `publicPaths` or delivered by the public fallback after an upstream routing change. No named path is public by default. If a deployment accidentally changes the configured API prefix while DSH still registers `/api`, Lanyard also retains the known `/api` session and loopback pins. The known loopback-only paths (`/open-in-app/open` and `/plugins/events`) also stay local-only if upstream route changes send those exact requests to the public fallback; neither an anonymous nor a paired phone can use them. These pins do **not** automatically identify new or renamed desktop routes. The known API safeguard does **not** identify arbitrary newly renamed upstream APIs; investigate any `no route claimed` warning before LAN use.

Upstream DSH prereleases may register the GUI and browser bundles as Fetch resources rather than Node HTTP handlers. The same LAN TLS, cookie and admission restrictions apply to both forms; a green check against an older pinned DSH does not prove a newer prerelease is compatible. For a streamed Fetch resource, Lanyard also sends HTTP response headers before the first body chunk arrives; a slow stream must not leave the phone waiting just to learn its response status. Network and in-process HEAD resource reads also finish without waiting for an unused response body to cancel. Both signal the resource producer to stop after the bodyless response, even if cancellation stalls; the in-process adapter leaves the caller's original Request signal untouched and preserves its explicit referrer and referrer policy. When a Fetch resource rejects before it can produce a response, upstream still handles the HTTP error, while Lanyard aborts the forwarded request so the failed resource does not leave its producer running.

## Install

**First check what npm actually publishes:**

```sh
npm view @koalafacts/deepseek-harness-lanyard version
```

The `0.0.0` npm package is only a placeholder, **not a working plugin**; a newer version in this source repository does not mean it has been published. **Do not install the placeholder by package name.** Use the local tarball instructions below while the registry still reports `0.0.0`. Only after npm reports a real working release, install by package name:

```sh
dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard
```

### Install a local tarball while npm only has the placeholder

If `npm view @koalafacts/deepseek-harness-lanyard version` still says `0.0.0`, install a **locally packed copy of this source** instead of that non-working registry placeholder. Run these commands on the **computer running dsh**, not the phone. You need an already installed `dsh` CLI and pnpm 10. **The current published DSH `0.2.2-rc.1` (`latest`/`next`) requires Node.js 24.9.0 or newer.** Lanyard's broader `engines.node` range still permits Node 22.19+ with older DSH hosts that support it; it does not override the current host CLI's Node requirement.

```sh
git clone https://github.com/KoalaFacts/deepseek-harness-lanyard.git
cd deepseek-harness-lanyard
pnpm install --frozen-lockfile
npm run check
pnpm pack --pack-destination .
dsh plugin --profile web add "$PWD/koalafacts-deepseek-harness-lanyard-0.2.0.tgz"
```

The tarball filename above corresponds to this checkout's current `package.json` version (`0.2.0`); if that version changes, use the `.tgz` filename printed by `pnpm pack`. Keep `git rev-parse HEAD` with your test results so the installed source is identifiable.

On **Windows PowerShell**, run the same clone, frozen install, check and `pnpm pack` steps above, but replace only the final `dsh plugin ... add` line with this command sequence. It reads the actual package version rather than guessing a filename or accidentally selecting an older tarball:

```powershell
$version = (Get-Content -LiteralPath .\package.json -Raw | ConvertFrom-Json).version
$tarball = Join-Path (Get-Location) "koalafacts-deepseek-harness-lanyard-$version.tgz"
if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) {
  throw "Missing local tarball: $tarball. Run pnpm pack first."
}
dsh plugin --profile web add $tarball
```

This is a local tarball install on the DSH computer, not an npm registry release or a change to LAN binding.

This **does not publish anything to npm** or open the LAN automatically. The existing real-DSH e2e installs this same kind of local tarball into a clean profile; that is not a substitute for an official npm release or a physical phone test. Once installed, start dsh with an explicit trusted-LAN address as described below, and follow the TLS certificate/fingerprint pairing instructions.

### Download an unpublished CI install candidate

If you cannot build the source locally, open a **successful `main` run** of the [CI workflow](https://github.com/KoalaFacts/deepseek-harness-lanyard/actions/workflows/ci.yml). Confirm **node24-startup, check, e2e, browser, windows-keep-awake and candidate-consumer** all passed, then download the **`unpublished-lanyard-<full commit SHA>`** artifact under *Artifacts*. Extract its ZIP on the computer running dsh; it contains the installable `.tgz`, `SHA256SUMS`, and `SOURCE_SHA`. Verify that `SOURCE_SHA` matches the successful run's full commit SHA and optionally check the tarball for download damage using `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`). From that directory, install with `dsh plugin --profile web add "/absolute/path/to/the-downloaded.tgz"` (replace the placeholder with the real extracted path).

The documented install candidate appears **only after all five prerequisite CI jobs and the separate clean DSH consumer check have passed**. An internal one-day preflight archive may appear before that, but it is not the verified install candidate. Final artifacts exist **only for main pushes**, expire after seven days, and are **not an npm release, a signed provenance statement, or proof of a physical phone test**. A checksum packaged in the same ZIP detects accidental changes but does not independently authenticate its origin; confirm the workflow and commit on GitHub. Installing still leaves networking off until you explicitly start dsh with `--host <your assigned LAN IPv4>`.

Only after npm publishes a working Lanyard release (not the `0.0.0` placeholder) can you install it by package name from the web sidebar's **Plugins** page, where it is listed as *Lanyard — phone access*. Until then, use the local tarball or a verified `main` CI candidate above; do **not** install the placeholder through the Plugins page.

Installing changes nothing on its own: dsh goes on serving this machine only. Serving your network is a choice you make each time you start it:

```sh
dsh --profile web --host 192.168.1.5
```

If startup says the chosen IPv4 address is **not assigned to this computer**, check its current Wi-Fi or Ethernet IPv4 (for example, after reconnecting or a DHCP address change) and retry `--host` with that address. Lanyard does not silently bind a different network interface.

The listener accepts only dotted-quad IPv4 bind literals. An empty `--host`, a DNS name such as `localhost`, or another non-IP value is rejected rather than silently becoming a wildcard listener; an omitted host defaults to `127.0.0.1`, including in direct carrier compositions that supply TLS files. The legacy `0.0.0.0` option remains an **explicit**, TLS-protected all-interface bind only where the installed dsh carrier permits it.

Replace `192.168.1.5` with an IPv4 address actually assigned to this computer (usually its Wi-Fi or Ethernet address); do not copy that example address unchanged. The dsh 0.2.1 prerelease carrier rejects wildcard `0.0.0.0`. On the older 0.2.0 line, `dsh --profile web --host 0.0.0.0` is also supported but listens on every network interface. Lanyard preserves each carrier's restriction; the concrete bind exposes only the selected interface. IPv6 binds are not yet supported. No flag still means loopback only. With a concrete IPv4 bind, the generated TLS certificate names that one address, so unrelated VPN or container adapter changes will not force a new phone certificate on restart. A different bound LAN address still requires a new certificate and fingerprint check; legacy wildcard binds continue to cover all interfaces. When only the LAN address changes, renewal retains the existing matching private key, so an interrupted certificate write leaves the old certificate/key pair intact; the new certificate still has a different fingerprint. If replacing the certificate fails after writing its temporary file, Lanyard removes that attempt's temporary file so a retry in the same process is possible; an already-existing temporary file is left untouched and still blocks renewal. If storage runs out during the initial PEM write, Lanyard also removes its own partially written temporary key; it never deletes a pre-existing temporary file. On a first-ever certificate issue, if writing the certificate fails, Lanyard also removes only its own newly generated private key (provided no certificate appeared and the key was not changed), allowing a clean retry after the write problem is fixed; if cleanup itself fails, the incomplete-pair guard still refuses startup.

Lanyard coordinates its own certificate writers with exclusive sibling lock directories (`cert.pem.lanyard-lock` and `key.pem.lanyard-lock`). A concurrent startup reports that TLS material is busy; retry after the active writer finishes. A crash or failed lock cleanup can leave a lock behind: Lanyard will not remove or take it over automatically. Confirm that no Lanyard writer is active before an operator removes an abandoned lock. This coordination does not protect against other programs replacing files without taking these locks. Even reusing an existing pair now requires write access to its parent directories to acquire these locks. Direct API callers must use consistent final filenames; directory aliases are canonicalized, but Windows trailing-dot/space filename aliases are not supported.

`--tls-cert <file> --tls-key <file>` supplies an existing PEM pair for the TLS front instead of generating one; both are required. Each path must resolve to an ordinary file; a certificate-manager symlink to a regular PEM file is fine, but a directory, device or named pipe is refused before reading (a pipe could otherwise hang startup). These operator-managed files are not renewed or overwritten by Lanyard. The local listener stays plain HTTP. On dsh releases supporting it, `--public-url <url>` changes the advertised root, but grants no Host trust; use `--trusted-host` separately when needed. The value may include a supported Web UI path prefix such as `/ui/` (upstream compatibility tests require this), including non-ASCII text such as `/café/` and ordinary URL path punctuation such as quotes, braces and carets (`^`). Node 22 and Node 24 differ in whether raw carets are percent-encoded by the URL parser; both representations are supported without allowing path rewrites. Existing percent-encoded paths are also preserved. Raw Unicode whitespace (including non-breaking spaces), soft hyphen (U+00AD), zero-width space (U+200B), word joiner (U+2060) and bidirectional formatting controls (U+061C, U+200E/U+200F, U+202A–U+202E and U+2066–U+2069) are refused so an advertised URL cannot be invisibly changed or visually reordered. Ordinary Unicode paths, including Arabic text and emoji joiners, remain valid. It must not use a dot-segment (including percent-encoded dot segments) or backslash path that URL parsing silently rewrites; invalid values fail before startup. It does not change lanyard's direct TLS pairing address. Each operator-provided certificate or private-key PEM is limited to 1 MiB; a mistakenly selected huge or dynamic file fails startup instead of being read without a memory bound.

When composing the carrier directly, `tls: null` means no explicit PEM pair, just like an omitted `tls`. A network bind still requires generated or explicit TLS material.

This machine keeps its usual `http://127.0.0.1:3080`, and devices on the network get TLS on a port of their own, 3443 by default. On startup it prints the certificate's fingerprint **before** any token-bearing pairing link, then a QR code. Compare that fingerprint with the phone's certificate warning before accepting it. When startup readiness is delayed, Lanyard also re-reads the current listener and LAN address snapshot so the phone does not get an outdated IP in its pairing link. The address, TLS port and certificate fingerprint are taken from one listener snapshot so a concurrent service replacement cannot mix two servers into one pairing URL. A concrete IPv4 bind does not depend on the older `webRuntime` service, so a missing or failing legacy service cannot prevent its pairing link. If DSH replaces its browser-authentication service before startup settles, Lanyard uses the currently active launch-token issuer instead of printing an obsolete link; if no issuer remains, it prints no pairing link or QR and asks you to restart DSH. If the TLS service becomes unreadable during delayed readiness or an immediate announcement in a hand-built context with no Loader, pairing reports the same fixed, nonsecret recovery message rather than leaking an upstream exception; if reading DSH's Loader or beginning the readiness wait throws, startup fails with a fixed, nonsecret error and prints no token-bearing link. Fix the upstream startup failure and restart DSH:

```
lanyard: serving your network over TLS on port 3443 — do not open the (LAN: …) link on the dsh web line: it is plain http and carries the launch token
lanyard: the phone should show certificate SHA-256 7F:52:AF:73:DB:4B:08:A0:9E:56:2D:83:B1:C5:7D:AF:0C:ED:3D:9A:F8:88:B9:B8:8C:27:3A:7A:2A:02:E4:B3 — if it ever shows another, do not continue
lanyard: FIRST visit https://192.168.1.5:3443/ on the phone without a token and verify the FULL SHA-256 fingerprint above; for another network, check that link's token-free HTTPS root first. If verification or trust is unavailable, do NOT scan or open a pairing link
lanyard: pair a device by opening https://192.168.1.5:3443/?token=<launch token> once
lanyard: or scan this with the phone
```

Ignore the `(LAN: …)` link on dsh's own `dsh web:` line: it is plain http and carries the launch token. Nothing answers it, but someone impersonating your machine on the network could. This warning applies to concrete `--host <LAN IPv4>` binds as well as older wildcard binds: open only Lanyard's verified HTTPS pairing link.

### Flags

| Flag | |
|---|---|
| `--host <LAN IPv4>` | serve the selected trusted LAN interface over TLS, and print the pairing link |
| `--network-port <port>` | the port devices on the network reach; 3443 unless you name one |
| `--keep-awake` | hold the machine awake so sleep cannot cut the phone off mid-session |
| `--port`, `--no-open`, `--trusted-host` | as shipped; `--port` stays this machine's own |

Both port flags accept only integers from 0 to 65535. Out-of-range values now fail immediately with the offending flag named, rather than reaching a listener with an unusable port. Zero asks the OS to assign a free port; the chosen network port is shown in the pairing announcement.

On macOS, `--keep-awake` uses `caffeinate -i -w` to release its idle-sleep hold when dsh ends, even after an unclean kill. On Linux, `systemd-inhibit` now runs GNU `tail --pid` watching dsh, releasing the lock shortly after dsh exits without cleanup (GNU `tail` is required; if it is absent, `--keep-awake` fails at startup with an explicit missing-helper error). On Windows, the PowerShell inhibitor passes the sleep flags as an explicit UInt32 (avoiding Windows PowerShell 5.1's signed-hex conversion), captures the dsh process, treats helper initialization/runtime errors as fatal (rather than continuing to a false success marker), checks that Windows returned a non-null, non-zero sleep assertion result, and then waits for that process to exit. A rejected assertion terminates the helper instead of silently waiting with no protection; startup waits for an explicit success marker after the Win32 assertion (up to 30 seconds, allowing for cold PowerShell compilation), refusing to serve with a requested hold if PowerShell never confirms it; an unexpected later exit is still warned about. If startup confirmation fails, Lanyard attempts to terminate the unconfirmed helper and checks its exit for up to seven seconds even if the termination signal fails; if cleanup cannot be confirmed, it warns about a possible orphan inhibitor. On normal teardown, a failed termination signal does not prevent the bounded exit check; if that check also fails, Lanyard warns instead of rejecting its own cleanup (the upstream subprocess layer has separate shutdown rules). This is intended to release the hold after a forced kill; Windows host verification is still pending. Only absolute directories in `PATH` are eligible for the checked inhibitor executable (and Linux `tail`); relative entries (including `.`) are ignored so a working-directory shim cannot be selected. The selected executable is launched by its absolute path without a second `PATH` search. If none is eligible, `--keep-awake` refuses startup. On Windows only the native `powershell.exe` is eligible: a `.cmd`/`.bat` shim cannot be launched by DSH's shell-free subprocess and is not treated as a working inhibitor. This does not prevent deliberate sleep or guarantee a closed laptop will keep serving.

Needs dsh 0.1.5-rc.3 or later, and is tested against dsh's newest release. From 0.1.7, dsh checks that minimum itself and will neither install nor load the bundle below it, so `--host 0.0.0.0` is refused as usual. An older dsh does not check; one without its own browser sign-in (before 0.1.2) makes this fail loudly at startup and refuse every device on the network, rather than serve it without one.

## On the phone

Point the camera at the QR code in the terminal **after checking the HTTPS certificate**. That starts the sign-in step — the link carries dsh's launch token, 43 random characters nobody should be typing on a phone keyboard. **The printed link and QR code are bearer secrets:** scan the terminal directly; do not send the link to yourself by email or messaging, or upload a QR screenshot to cloud notes. If scanning is unavailable, transfer the printed link only through a private channel you control and trust not to retain or disclose it.

Lanyard prints a pairing link or QR code only when its TLS listener supplies both a complete SHA-256 certificate fingerprint and an explicit, valid LAN TLS port (`networkPort`). It also checks that upstream's token-bearing URL stays at that exact HTTPS listener's root and contains one nonempty `token` query parameter, without a fragment or other parameters. A missing fingerprint/port, an unexpected URL scheme, host, port or route, or an upstream issuer that throws while generating a link logs a fixed, nonsecret error and prints **no** pairing link or QR code (including alternative interface links); do not construct one manually. If this occurs after updating dsh, check plugin compatibility instead of copying a token-bearing upstream error. If the initial upstream connection lookup throws, or if even reading its `authenticatedUrl` property throws, startup refuses pairing with the same fixed missing-authentication error instead of propagating a potentially token-bearing diagnostic.

If QR rendering fails **after** a verified HTTPS link and certificate fingerprint have been printed, the link remains usable: Lanyard reports a fixed, nonsecret QR error. Open the printed HTTPS link instead and verify the certificate fingerprint. This is different from invalid TLS or issuer data, when no pairing link is printed.

Before opening the QR code or token-bearing pairing link, first open the **bare** `https://<this-computer's-LAN-IPv4>:3443/` address on the phone (use the actual announced HTTPS port). An unpaired browser may receive HTTP 401; that is expected. This separates the certificate check from the credential-bearing sign-in. For the self-signed certificate, compare its **entire SHA-256 fingerprint** in the phone's certificate details against the fingerprint printed by Lanyard; a matching IP address, a few matching fingerprint bytes or a generic browser warning is not verification. If the phone browser cannot display a reliable fingerprint or will not safely accept that certificate, **do not bypass the warning or open the token-bearing URL**.

For a mobile browser that cannot establish trust in the generated self-signed certificate, use a server certificate issued by a **CA you control and have independently verified**, with this computer's LAN IPv4 in the certificate's IP subjectAltName, via `--tls-cert` and `--tls-key`. Install **only the CA's public certificate** on your own phone using its supported certificate settings, and verify the certificate/CA before granting trust. On iOS/iPadOS, manually installed root CAs are not automatically trusted for SSL/TLS: enable them under **Settings → General → About → Certificate Trust Settings**, as documented by [Apple](https://support.apple.com/en-au/102390). Trusting a root CA grants it authority beyond this one site; use a dedicated CA on devices you manage, never install an unverified profile, and **never send a TLS or CA private key to the phone**. If the bound IP or certificate identity changes, verify trust again. The hosted Chromium checks are not evidence that Safari or Android Chrome completed these steps.

Opening the link signs the phone in: dsh swaps the token for a session cookie and redirects to the plain address, so the token leaves the address bar at once. From then on `https://192.168.1.5:3443` just works, across restarts, until the session expires — 30 days by default. Add it to your home screen if you want it to open like an app.

If saved TLS material is incomplete (only one of `cert.pem` or `key.pem` remains), unreadable, or mismatched, startup stops and leaves existing files unchanged — even after the LAN address changes. Restore a complete matching certificate/key pair before restarting; Lanyard will not silently discard a phone's existing TLS identity. A dangling `cert.pem` or `key.pem` symlink also counts as saved material: even if its target is missing, Lanyard will not silently replace the link. Repair it or restore a matching identity before restarting. Even a working symlink is refused for managed material: an automatic certificate renewal would otherwise replace the link itself and silently disconnect it from its original target. Restore a known matching certificate/key pair as regular files under the owner-only managed directory before retrying. Directories and named pipes are also refused before reading saved managed material; reading a pipe without a writer could otherwise hang dsh startup. Each saved **managed** certificate and private key is also limited to 1 MiB of actual file reads, including on reuse: even a valid PEM padded to a huge size is refused without overwriting the identity. Restore the original matching, normal-sized pair before retrying. The startup error names the **1 MiB PEM size limit** explicitly so it is not mistaken for a certificate/private-key mismatch. Explicit PEM paths supplied with `--tls-cert`/`--tls-key` remain outside managed-certificate renewal and ownership checks. The TLS front separately requires their resolved targets to be regular files before reading; symlinks to regular PEM files remain supported. An expired or not-yet-valid certificate with a readable matching key is renewed before the TLS listener starts. Renewal changes its SHA-256 fingerprint, so verify the new fingerprint on the phone before accepting its certificate warning. If publishing that renewed certificate fails after the replacement key is written, Lanyard tries to restore the previous matching key so you can retry safely. It will refuse to overwrite unexpected changes and instruct you to recover a matching backup if rollback fails. This does not cover sudden process or power loss between the two file replacements.

On Linux/macOS, the **managed** TLS directory and saved `key.pem` must be owner-only, including when restoring a backup. A pre-existing group/world-accessible directory or key prevents startup; Lanyard leaves permissions unchanged rather than altering a directory you might share. After confirming ownership, use `chmod 700 <material-directory>` and `chmod 600 <material-directory>/key.pem`, then restart. This check covers managed material on POSIX, not Windows ACLs or PEM files you supply yourself with `--tls-cert`/`--tls-key`; secure those yourself.

Three things to expect:

- **Both devices must be on the same network.** The link uses your machine's LAN address; there is no relay and nothing leaves your network. On a machine with more than one network, the code names the likeliest home network, and a link is printed for each other network a phone could be on (container and virtual-machine networks are left out, including macOS virtual bridges numbered 100 and above; physical `bridge0` remains eligible). If those are all it finds, it prints no link and says so. If a virtual bridge and a physical adapter report the **same IPv4 address**, Lanyard conservatively excludes that ambiguous address from phone pairing, regardless of adapter enumeration order; use a different, unambiguous LAN address instead. When multiple interfaces list the **same usable IPv4**, it appears only once among the pairing links rather than generating repeated alternatives.
- **The link is a password until dsh restarts.** Anyone who opens it before then is signed in, so do not paste it into a group chat or leave the code on a shared screen. Restarting dsh retires it; phones already paired stay signed in.
- **A new network means a new link.** The session is bound to the address it was opened on. If the machine's LAN address changes, scan what the startup line prints.

## What a paired phone can reach

**A paired phone has your account on this machine.** What it reaches includes a terminal and an agent that runs commands, both as you, so whatever you could do at the keyboard it can do too — editing dsh's configuration files by hand included. Pair only devices you own, and treat losing one like losing a laptop that is signed in.

The **Schedule** view is also operator-level, not read-only. On DSH 0.2.2, creating or editing a task can schedule prompts or delete tasks; **Run now** triggers delivery immediately, and **Clear ended** permanently removes all ended tasks and their delivery history. These operations require a signed-in paired device behind Lanyard's TLS/session gate. Treat the phone like a signed-in desktop, not a read-only dashboard.

What stays at the machine is the GUI's configuration plane, and the network never meets an unguarded route:

- **Refused for everyone but a loopback peer:** settings, credentials, the account, model providers, installing or inspecting plugins, anything that opens something on the machine's own screen, and any Gateway namespace or `/api` route this build has not deliberately classified. That keeps credentials off the phone's screen and a stray tap from reconfiguring the install. It is not a wall against a device you paired — see above.
- **Malformed HTTP request targets fail closed.** Node's HTTP listener can accept invalid absolute URLs. With DSH 0.2.2-rc.1, the upstream carrier rejects them with HTTP 400 before selecting a Lanyard route. If an unparsable target directly reaches a named or fallback handler, Lanyard instead returns its fixed 403 without throwing or granting the public pairing/static-file exemption. The focused handler regression does not assert a fixed 403 from the complete HTTP listener.
- **dsh's session is checked in front of every route**, not only the ones dsh guards itself, so a route whose owner forgets to check reaches no one on the network. If upstream's session checker, its property accessor, or the Cordis connection service lookup unexpectedly throws, the network request receives the same fixed refusal instead of a handler error or a secret-bearing diagnostic. The extra gate still exempts local loopback requests; none of these failures count as a successful network sign-in.
- **The session cookie only travels inside TLS.** dsh does not mark it `Secure`; this does, on the network listener, so a phone that later opens a plain `http://` address on this machine does not send it in the clear.
- **TLS is terminated in-process**, which preserves the real client address. A forwarding proxy in that seat would make every request look local, and lift both the session check and the configuration pin.
- **The GUI's own static files can be read without a session.** Anonymous `GET` and `HEAD` on the fallback seat allow pairing and static assets; other HTTP methods still require dsh's session, even on that seat. The files carry no secret, and source maps stay excluded. dsh signs in the page itself, and everything the loaded page does needs the session.

## Limitations

- **Stopping or restarting dsh disconnects live phones.** Lanyard closes active TLS sockets and incomplete handshakes during shutdown; an open phone WebSocket cannot indefinitely delay the host stopping. Reconnect after dsh starts again. This is separate from `--keep-awake`, which prevents idle sleep while dsh runs.
- **`--host 0.0.0.0` means every network this machine is on** — Wi-Fi, Ethernet, a VPN. Anything on them can reach the TLS listener, though nothing gets past it without a session. Use it on networks you trust, not café or hotel Wi-Fi.
- **Signing one device out signs out all of them.** Every session is signed by one secret — the `client-connection` browser-session record in dsh's credential store — and replacing it is the only revocation there is.
- **A tunnel counts as local.** `adb reverse` or `ssh -R` makes the phone a loopback peer: it still needs dsh's session, but reaches the configuration plane. Treat it as handing over your keyboard.
- **Streams are admitted as a whole.** They share one WebSocket, which this can admit or refuse but not look inside, so a paired phone could open a stream in a namespace it is otherwise refused — today only read-only account status, and the experimental voice bundle's stream where that is installed. The same socket carries the notifications every browser gets, configuration activity included (that a setting or a credential changed, a plugin install's log), though never the values themselves. The GUI makes every change as an HTTP call, where each one is classified, but nothing in the protocol requires that.
- **Coupled to the carrier it subclasses and the sign-in it relies on.** A future dsh could break it — loudly, by design, never by quietly serving plaintext or letting an unauthenticated device in.

- **A `no route claimed` warning when DSH finishes loading** means a configured route or API prefix has no live owner. Registrations disposed during boot no longer hide that warning. Check upstream compatibility before relying on LAN access; this diagnostic does not itself close the listener.
- **A warning that DSH Loader readiness could not be checked** means the optional route-claim drift diagnostic was unavailable during service replacement. The TLS listener, session checks and route pins still operate; restart dsh and verify compatibility before relying on a newly upgraded harness version. Upstream exception text is deliberately not logged.

## Real-phone acceptance checklist (not covered by CI)

Run this **on an actual iPhone/Safari and Android/Chrome separately** before describing Lanyard as phone-verified. Use your own trusted Wi-Fi and a disposable DSH workspace; configure the model on the **computer** first. Record the phone OS/browser, DSH version, Lanyard commit, result and any error for **each** case (pass / fail / not run). Keep screenshots and logs free of pairing tokens, QR codes, session cookies, credentials and private task content.

1. **TLS and pairing:** Start with `dsh --profile web --host <this computer's LAN IPv4>` (optionally `--keep-awake`). On the phone, visit the printed **token-free** HTTPS root and independently verify the **entire** certificate SHA-256 fingerprint before opening the token-bearing URL or scanning its QR. If browser trust cannot be established, **stop** and follow the CA certificate instructions above; do not bypass verification. Confirm the signed-in GUI opens and the token disappears from the browser address bar.
2. **Actual work:** Open the mobile sidebar, create/select a disposable workspace and send a harmless task. Verify that an actual result appears. In a configuration that **really produces** a tool approval or user question, answer it on the phone and verify that execution proceeds; otherwise record **approval not exercised**, not pass. Do not use a destructive command to manufacture an approval.
3. **Background and interrupted Wi-Fi:** With an **unsent** draft in the editor, lock the phone for at least two minutes and return: the draft should still be present. Then run a safe task, switch away and back, and check the ongoing/result view without duplicate submission. Turn off cellular data, interrupt Wi-Fi for at least 20 seconds, restore the **same** trusted Wi-Fi, and check that the browser reconnects without needing the old bearer link. Record any reload, lost draft, duplicated task, or manual re-pair.
4. **Host restart and sleep:** Restart `dsh` without replacing its credential store or changing its LAN address/certificate; reopen the saved token-free HTTPS origin and verify the existing session and task history recover. A changed host address requires a fresh pairing link. Separately test **physical** screen locking and idle-sleep behaviour on the computer with/without `--keep-awake`, where supported; a successful Chromium simulation is **not** a physical sleep result.
5. **Isolation:** In a fresh private browsing session **without** the pairing token, verify that protected API/task operations do not succeed; static assets or the sign-in page may still load. On the paired phone, verify that configuration/plugin/credential actions are not offered or are refused, while the computer's loopback UI continues working.

**Acceptance:** Report an overall **real-device pass** only when both device/browser combinations pass the applicable work, recovery, and isolation cases. Record unsupported or untested conditions explicitly; a green CI run, a browser fixture, or a TLS-exception test is not a substitute.

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

