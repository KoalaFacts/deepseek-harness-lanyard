# AGENTS.md

Guidance for coding agents (including Claude Code) working in this repository. `CLAUDE.md` is a symlink to this file, following the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) convention — edit this one.

## What this is

`@koalafacts/deepseek-harness-lanyard` is an **out-of-tree `dsh` plugin bundle** with exactly one purpose: letting its author use the `dsh` web GUI from a phone, on a home network. It publishes to npm and installs with `dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard`, or by name from the Web sidebar's Plugins page where a dsh has one.

**Installing it changes nothing a person can see.** Serving the network stays an explicit `--host 0.0.0.0` on each invocation; without it the gated carrier binds `127.0.0.1` on the stock port, exactly as the row it replaces would. (A live install from the Plugins page on 0.1.7-rc.2 kept the open tab working; that depends on the old carrier releasing the port before the new one binds, and no suite covers it.) Making the network the default is a product decision for the owner, not a simplification to reach for.

Everything in it — the self-signed TLS, the gate that holds every network request to upstream's own browser session, the loopback pins — exists to make that one thing safe enough to leave running. **It is not a general-purpose gateway, reverse proxy, or auth layer, and should not grow into one.** A change that does not serve someone opening the GUI on their phone is out of scope, however reasonable it sounds; the security surface here is small because the use case is small, and that is the whole design.

**Authentication is upstream's, and this plugin issues no credential of its own.** Since 0.1.2, `dsh` signs browsers in itself: a per-process launch token, printed on its `dsh web:` line, is exchanged for a signed, host-bound session cookie. Before that this plugin carried its own pairing token and browser bootstrap; once upstream authenticated, the two conflicted — a phone holding lanyard's cookie met upstream's 401 — and the nightly e2e sat red for three weeks. Upstream still refuses `--host 0.0.0.0`, serves plain HTTP, and treats any signed-in browser as the operator at the keyboard, so what remains here is exactly that gap: the bind, TLS, the session check at every seat, and the configuration pins.

**It changes no harness source, and must not start.** It composes over the shipped tree through `cordis.patch.yml`, which is the documented extension mechanism ([bundle authoring](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)). Everything here is judged by that constraint.

## Commands

```sh
pnpm install               # prepare runs tsc, so lib/ exists after install
npm run check              # typecheck + unit suite + build gate — the default gate
npm run typecheck
npm run test               # vitest
npm run build              # tsc to lib/ + lib/types, then scripts/verify-build.ts
npm run test:e2e           # boot a real dsh and drive the gate over TLS
npm run test:e2e:browser   # drive the pairing flow in Chromium
```

One test file or one case:

```sh
npx vitest run tests/gated-webserver.spec.ts
npx vitest run -t 'refuses an anonymous LAN peer'
```

Useful environment variables:

- `DSH_E2E_VERSION` — a dist-tag or exact version. Defaults to `latest`; empty is treated as unset.
- `DSH_E2E_KEEP=1` — keep the throwaway workspace for inspection.
- `LANYARD_CHROMIUM` — a Chromium binary, when the machine's build does not match this Playwright version.

Scripts are TypeScript run directly by Node (type stripping, ≥22.18). No build step, no runner dependency; `npm run typecheck` covers `scripts/` too.

## How the composition works

`cordis.patch.yml` disables two shipped rows and inserts five. Patches apply in bundle order — `dsh-base`, then `dsh-web-app`, then this — and a later layer can target a row an earlier one inserted.

| Row | Replaces | Provides |
|---|---|---|
| `lanyard-startup` | `web-startup` | `webStartup`; lifts the `--host 0.0.0.0` refusal, adds `--network-port` and `--keep-awake` |
| `lanyard-tls` | — | `lanyardTls` (PEM paths only, never key material) |
| `lanyard-webserver` | `webserver` | `webServer` — a `WebServer` subclass; plaintext on loopback at `port`, TLS for the network at `networkPort`, and no all-interfaces bind without TLS |
| `lanyard-keep-awake` | — | platform sleep inhibitor |
| `lanyard-pairing` | — | the pairing line: upstream's launch-token link at the address and port a device reaches, links for the machine's other networks, the certificate fingerprint, and a QR code |

The gate works because **every consumer contributes through one of `WebServer`'s three registration seats** — `register`, `registerUpgrade`, and the single-owner `registerFallback` that answers whatever no named route matched. Overriding all three puts admission in front of every request the composition serves, so `dsh-client-connection` — which owns `/api` — runs completely unmodified. `assertRegistrarsWrapped()` fails the load if a future harness grows a fourth.

Admission itself is upstream's decision: a network peer passes a seat only if `ctx.connection.requestRejection(req)` admits it — the check `dsh-client-connection` publishes for route owners to apply to their own routes. A loopback peer is exempt from this gate, not from upstream, which still authenticates every route it owns.

## Load-bearing invariants

Break any of these and the plugin fails **open** — serving the LAN with no gate — while tests may still look green. Each has a test that fails when mutated; keep it that way.

- **TLS is terminated in-process and the decrypted socket handed to the inherited `node:http` server.** A TCP-forwarding proxy would make every request read as a loopback peer and silently lift both the session requirement and the configuration pin. Do not "simplify" this into a proxy. Held down by the real-LAN-peer test in `tests/gated-webserver.spec.ts`.
- **Loopback means the socket peer, never the `Host` header.** On an all-interfaces bind any client can claim `Host: localhost`.
- **A network peer is admitted only on upstream's say-so, and no connection means no admission.** `admit()` reads `ctx.connection` per request, because Connection mounts after the carrier it registers on; before it mounts, after it is disposed, and on a connection that predates browser authentication, every network peer is refused. Treating "nothing to ask" as "nothing to check" would serve the LAN with no gate at all.
- **An all-interfaces bind requires TLS material.** The launch token rides the pairing link's query; over plaintext it is readable by anyone on the network. The carrier throws rather than bind.
- **Every cookie set through the TLS front is marked `Secure`, and none set through the loopback listener is.** Upstream's session cookie is `HttpOnly; SameSite=Strict` only, and a browser scopes cookies by host rather than scheme or port, so unmarked it rides any later `http://` request a paired phone makes to the machine's address. `secureCookiesOf()` wraps the three setters every header a route handler sets passes through — `setHeader` (which `setHeaders` and a first `appendHeader` call; a test that only ever appended once therefore guarded nothing), `appendHeader` onto an existing header, and `writeHead` in its object, flat-list and `[name, value]`-pair forms (which implicit headers call) — and the mark is idempotent, because `writeHead`'s merge path calls `setHeader` again, and it recognises only the attribute: `Path=/secure` is not `Secure`. An upgrade handler's raw socket writes and `writeEarlyHints` go unseen; upstream sets its one cookie through `writeHead` on the fallback seat and none on an upgrade. Marking the loopback listener's cookies would make the browser drop them and sign the local tab out.
- **Unknown Gateway namespaces deny.** The Typert Gateway claims every `namespace/method` a live service exposes, so a per-method allowlist would default each new endpoint to reachable.
- **Unknown exact `/api` routes deny too.** Upstream registers routes beside the Gateway with `connection.fetch.register`, with no namespace — `present.open` and `changes.open` among them, which open a file with the host's applications. An endpoint without a `/` is decided by `pairedRoutes`, so a route added upstream is pinned until someone classifies it.
- **Stream methods are admitted by the socket, not the method.** Every stream-mode Remote method rides one WebSocket, `/api/remote.mux`, and this gate admits or refuses that socket as a whole — it does not parse frames, and should not grow to. So a *stream* method in a pinned namespace is reachable by a paired device; today that is `account/watch` and `account/watchExpiry`, read-only, and `speech/follow` where the experimental voice bundle is mounted. The same socket carries `$events`, the notifications every browser receives, configuration activity included: `settings/document-updated`, `credentials/*-updated` (keys and references, never values) and, on `next`, the plugin manager's install log. Today every write the shipped GUI makes is a unary call over HTTP, classified one by one, but nothing in the protocol requires that; a new stream method in a pinned namespace needs a person to decide whether it is acceptable.
- **The gate's refusal body is its own marker**, not the bare `forbidden` / `unauthorized` that `dsh-client-connection` answers with itself — otherwise nothing can tell this gate from upstream behind it.
- **Every registration seat is wrapped, and a new one fails the load.** Wrapping `register` and `registerUpgrade` but not `registerFallback` shipped the built frontend to the LAN ungated for a release, and looked identical from inside this class — no path is registered for that seat, so even the unclaimed-path warning was blind to it. `assertRegistrarsWrapped()` turns an upstream `register*` addition into a loud load failure instead of a silent widening.
- **Route matching decodes the pathname; endpoint classification reads both forms.** `dsh-client-modules` and `dsh-host-frontend-static` both `decodeURIComponent` before resolving a file, so a raw-form suffix match let `%70` spell `.map` past the exclusion. A pathname whose escapes do not decode is refused rather than admitted.
- **The suffix exclusion tests the name the file owner opens, not the path it was asked for.** `dsh-host-frontend-static` resolves `join(distRoot, decoded)`, and `path.resolve` drops a trailing separator, so `index.js.map/` served the map to an anonymous peer past a suffix test that read the raw path — and filesystems alias further: case, and on Windows trailing dots and spaces, backslashes, and NTFS streams. `openedName()` normalizes all of those and refuses a colon outright, since no static asset has one; whatever it cannot pin down loses the public exemption rather than keeping it.
- **`port` is the loopback listener; `networkPort` is the one a device reaches.** Every consumer of `port` in the shipped composition builds `http://127.0.0.1:${port}` from it — the browser handoff, the `DSH_WEB_URL` shell variable, and the URL the model is told it is serving. So the inherited plaintext server always binds `127.0.0.1` on the configured port, exactly as the stock carrier would, and the TLS front binds the configured host on a port of its own (3443 by default). Enabling the plugin therefore never moves the desktop tab. Upstream's `dsh web:` line still prints a `(LAN: …)` link — the machine's IP, the plaintext port, and the launch token — and nothing answers it, so a phone that opens it gets a refused connection and a passive listener sees nothing. It is not safe to open, though: whoever impersonated this machine on the network would receive the token, which works until dsh restarts. The pairing line says so; this plugin cannot suppress upstream's line without losing its local URL. A pairing link needs `networkPort` and says so explicitly.
- **The pairing line never prints a link a plaintext carrier would answer.** A LAN address on an `http` carrier means lanyard's is not the one serving — a renamed upstream row, say, left the stock one mounted. The row logs an error instead, since the link would carry the launch token across the network in the clear.
- **A reused certificate must still name the addresses the pairing link advertises.** The subject alternative names are a snapshot of the interfaces present when it was generated, and the certificate outlives them; reuse is what keeps a paired device's accept-once exception valid, but a certificate that no longer covers the current LAN address gives the phone a name mismatch rather than the untrusted-issuer prompt the README promises. `certificateCovers()` decides, matching whole rendered entries — a substring test lets `10.0.0.71` answer for `10.0.0.7`.
- **`assertServer()` guards the inherited private `server` field.** TypeScript `private` is erased at runtime, so the subclass can reach it; an upstream rename must fail the load loudly rather than quietly serve plaintext.
- **The inherited carrier's config reaches `super` whole.** The constructor rebuilds the object it hands the parent, which is exactly where upstream's `compression` was once dropped; it spreads the whole config and overrides only `host`. The schema composes `WebServer.Config`, so those fields are also validated and defaulted exactly as the stock row would.
- **Every field of this plugin's own is in its schema.** Schemastery passes a key its schema does not name straight through, neither checked nor defaulted — a string where a list belongs becomes a `Set` of its characters. `OWN_FIELDS` in `tests/gated-webserver.spec.ts` is held to the `Config` interface by the compiler, and every field on it must refuse a malformed value at load.

## Replacing a shipped row means owning its whole contract

`lanyard-startup` sits in the seat `web-startup` held, so every row that reads `ctx.webStartup` must still find what it reads. Both failure modes are **silent**:

- a field this provider forgets falls back to the consuming row's schema default (this is how the shipped `--no-open` flag once went missing);
- an id the patch disables that no longer exists upstream is skipped with only a warning, leaving the stock ungated carrier mounted beside this one.

`lanyard-webserver` owns the same kind of contract for the `webserver` row: a config key the shipped row sets and the replacement does not falls back to the carrier's schema default, which is how the Web profile's gzip went missing.

`tests/webstartup-contract.spec.ts` checks all of it against the **installed** `@deepseek-ai/dsh-web-app` — every patch file its manifest declares, not only the first — never a vendored copy. When upstream moves, that test is the first thing to read.

## Deferring authentication to upstream

Two members of `ctx.connection` are the whole contract, both read structurally so this plugin imports nothing from `@deepseek-ai/dsh-client-connection`:

| Member | Used by | If it is missing |
|---|---|---|
| `requestRejection(req)` | the gate, per request | every network peer is refused |
| `authenticatedUrl(base)` | the pairing line | the pairing row fails the load, naming the version it needs |

What that buys, and what it does not, as of 0.1.5 and 0.1.7: the launch token is per process, so a pairing link dies with the process that printed it — and until then it is reusable, so anyone who opens it pairs, which is why the README calls it a password. The cookie is HMAC-signed with a secret kept in the credential store, bound to the authority it was issued for, `HttpOnly` and `SameSite=Strict`, and lives `cookieMaxAgeDays` (30 by default) across restarts. Upstream does not mark it `Secure`; the carrier does, on the TLS front. Revocation is rotating that one secret, which signs every device out at once.

The certificate is self-signed, so a phone's first warning is trust-on-first-use. The pairing line prints its SHA-256 fingerprint — `certificateFingerprint`, read from the certificate the TLS front actually loaded — which turns accepting that warning from a formality into a check a person can make.

`tests/upstream-session.spec.ts` drives this contract against the **installed** package, from the LAN address over real TLS: the exchange, the host binding, a forged signature, and the configuration pin behind a valid session. The nightly contract job reruns it against upstream's `next`. When upstream's sign-in changes shape, that is the test that says so.

## Client-owned paths are configuration

Every route path the gate keys on belongs to a *client* package — `API_PATH` (`dsh-client-connection`), `EVENTS_ENDPOINT` (`dsh-client-hmr`), the open route (`dsh-host-open-in-app`). None is this plugin's to hardcode, and `apiPathPrefix` and `loopbackOnlyPaths` fail **open** on drift. They are schema-defaulted `Config` fields, and `GatedWebServer` warns once the tree settles about any configured path no row claimed.

No named route is public by default. `/plugins` used to be, because the browser had to load client bundles before it held a credential; upstream's exchange sets the session cookie on the redirect that precedes the first page load, so that reason is gone. The fallback seat stays public because the exchange itself arrives there, and upstream authenticates the index on that seat by itself.

## Classifying the Remote surface

A session proves a device was paired, not that someone is at the keyboard. The paired surface is everything the shipped GUI needs to hold a session from a phone; the rest is the configuration plane, or acts on this machine's own screen. The classification below was taken from the installed packages of **both** upstream channels, reading each Remote service's `super(ctx, key[, { namespace }])` and its `Remote(...)` methods, plus what the GUI actually calls on load — never from memory.

| Namespace | Paired device | Why |
|---|---|---|
| `session`, `subagents`, `skills`, `commands`, `goals`, `fileReferences`, `fileUploads`, `sessionReferenceResolver`, `messageFeedback`, `sessionFeedback`, `permissionPresets` | reachable | the conversation itself |
| `agentPresets` | reachable, except `read`, `copy`, `deletePreset` | listing and selecting a preset is using it; its documents configure the agent |
| `$events` | reachable | tool approvals and the agent's questions are answered at `$events/result`; pinned, the agent waits on a prompt the phone can see |
| `workspace`, `workspaceFiles`, `officeToPdf` | reachable | workspaces and reading their files |
| `directoryPicker` | reachable, except `pick` | `list` is the in-app browser; `pick` opens the host's native chooser |
| `job`, `terminal`, `schedule` | reachable | work on the session's behalf; a paired device already drives an agent that runs commands and answers its approvals |
| `settings`, `credentials`, `account`, `llm` | loopback only | the configuration plane |
| `pluginManager`, `pluginRegistryProbe`, `pluginInventory` | loopback only | installing code, and an inventory that echoes the composed configuration |
| `dynamicCordisRunner` | loopback only | runs plugin code from the panel |
| `speech`, anything else | loopback only | unclassified; only an experimental bundle mounts `speech` |

`session/openWorkspacePath` and the `/open-in-app/open` route are pinned too: both launch applications on this machine's desktop. The dot-form API proxy the earlier defaults classified (`settings.update` and kin) no longer exists upstream.

Beside the Gateway, upstream registers exact `/api/<name>` routes — the stream WebSocket with `registerUpgrade`, the rest with `connection.fetch.register`. One with a namespace, `session/uploadFileBinary`, is decided by its namespace like any Gateway method; the rest have none, and `pairedRoutes` decides them by name:

| Route | Paired device | Why |
|---|---|---|
| `remote.mux` | reachable | the WebSocket every stream rides |
| `file` | reachable | chat images and document previews; it reads whatever this user can, as a paired device already can through the agent or the terminal |
| `session.export`, `present.host`, `changes.summary`, `changes.diff` | reachable | reads the session views make |
| `present.open`, `changes.open` | loopback only | open a file with this machine's own applications, like `session/openWorkspacePath` |
| anything else | loopback only | unclassified |

**None of this pinning is a boundary against a paired device.** A paired device holds the user's account — a terminal, and an agent that runs commands — so it can reach what the pins protect by other means, editing the settings file included. The pins keep the configuration plane out of the phone's interface and away from a stray tap, and keep the desktop's screen the desktop's. Claiming more than that, in code comments or the README, is the overreach this file exists to prevent.

A namespace the GUI calls on load that this table misses fails `npm run test:e2e:browser`, which asserts that every refusal the shell meets is a deliberate pin. A namespace it calls later does not — so when upstream grows one, classify it here before it ships, rather than waiting for a phone to find it.

## What the Plugins page reads

dsh reads the manifest before it runs any of this package, and on a dsh with the Plugins page (0.1.7 and later) that is what a person sees before installing:

- `dsh.manifestVersion: 1`, beside `dsh.bundle.patch`.
- `icon` — `./icon.svg`, manifest-relative, an SVG, PNG, JPEG or WebP of at most 256 KiB that stays inside the package once links resolve.
- `description` — the raw one-liner `listBundles` carries beside the localized `meta`; where a locale file gives a description, that is what the page shows.
- A localized `meta` title and description for the bundle and for every row it inserts, in `locale/<lang>.json` and `locale/<row>/<lang>.json`. dsh resolves them through the exports map as `<specifier>/locale/<lang>.json` — the package name for the bundle, the row's module name (`@koalafacts/deepseek-harness-lanyard/pairing`) for a row — and wants every language beside the English file.

Failures here are quiet in one direction and loud in the other. An `en.json` the exports map does not expose is simply not found, and the page falls back to technical names. Any other `.json` beside it — another language the exports map misses, or a file whose name is not a language id — turns the entry into a metadata error in place of its titles, so locale directories hold language files and nothing else. `tests/plugin-metadata.spec.ts` resolves every one the way dsh does, for the rows the patch actually inserts, in `en` and `zh` like the README pair, and checks that `npm pack` ships them. A one-click install from the page needs the package on the registry, so none of this is visible before the first publish.

## Conventions

Inherited from the harness; follow them so this reads like the code it composes with.

- **Config is an exported interface plus a same-named Schemastery schema**, defaults on the schema fields. No hardcoded tunables: anything two deployments may set differently is a config field. Protocol constants and security invariants stay fixed.
- **Registrations are effects** — every contribution goes through `ctx.effect()`, and a registry's `register()` returns the disposer.
- **Misconfiguration fails loud at load.** Never silently skip a missing referent, and never fall back to a weaker security posture.
- **Secrets travel as credential references, never values.** Config surfaces are echoed by `dsh --dump-config`, the plugin-inventory RPC, and crash dumps.
- **`README.md` and `README.zh.md` are a pair.** A user-visible change updates both, following the harness's bilingual docs convention.
- ESM, `strict: true`, `.ts` extensions on local relative imports. Every module and export carries concise JSDoc for its non-obvious contract; do not restate the code.
- **Dependency weight is part of the choice.** This runs inside someone's `dsh` install, so a runtime dependency's own tree matters: the terminal QR uses `qrcode-terminal` (zero dependencies) rather than `qrcode`, which pulls `yargs` and `pngjs`.
- **Peer dependencies are declared `optional`** because the *installation* provides them, not the profile. From 0.1.7, dsh enforces every DSH peer's range itself, at install and at startup, as `semver.satisfies(runtime, range, { includePrerelease: true })` — so the window is one real range, shared by every DSH peer and by the declarative `engines.dsh`: `>=0.1.5-rc.3 <0.2.0-0`. The `-0` is load-bearing: with prereleases taking part, `<0.2.0` would admit `0.2.0-rc.1`, a line nothing here has run against. Earlier releases check nothing, and a person can grant an exemption for exact versions, so the load-time guards remain what catches structural drift. `tests/plugin-metadata.spec.ts` checks the window by dsh's own rule.

## Verification

Four layers, each covering what the one below cannot:

| | |
|---|---|
| `npm run test` | unit behavior against published `@deepseek-ai/dsh-*`, no harness checkout |
| `npm run build` | every subpath the shipped `lib/` exports loads |
| `npm run test:e2e` | a real `dsh` boot, gate driven from the machine's LAN address over TLS |
| `npm run test:e2e:browser` | the pairing flow in Chromium — the only thing that proves the session rides the shell's own fetches and WebSocket, and that nothing the shell calls on load is refused by accident |

**Mutation-test any guard you add or change**: break what it guards and confirm the test fails. This repo has repeatedly found tests that passed against the mutation and guarded nothing. A green suite is not evidence until it can go red.

**Re-run the old mutations when a neighbouring rule changes, not only the new ones.** When exact routes began denying by default, the test pinning `session%2FopenWorkspacePath` kept passing and stopped guarding anything: an escaped separator now reads as one unlisted name, pinned without the decoded reading it existed to test. Nothing in that change touched the test; only re-running its mutation showed it had lost its teeth.

**Assert that something worked, not that this gate stayed out of the way.** `admitted()` means only "not refused by lanyard". Once upstream began refusing on its own, the e2e check "a paired LAN peer reaches the api" stayed green while every paired device got upstream's 401, because a 401 is not this gate's refusal. A claim that a device *can* do something is checked as success — a 200 carrying `ok: true`, a 101 — and `admitted()` is kept for the narrow claim it actually makes.

Both e2e suites exit **2 with a loud SKIPPED message** where they cannot run (no LAN interface, no Playwright) rather than passing vacuously.

**Nothing pins `dsh`.** A plugin that only works against one frozen release is not working, and pinning the CLI would not pin anything anyway — `dsh` floats its own dependencies through `^` ranges. The suites install a dist-tag: `latest` by default, which is what a person installing today gets, and the nightly adds `next`, upstream's prerelease line, so a breaking change surfaces before it reaches users.

An install that cannot resolve is not a test result. `dsh` publishes as a wave of packages that depend on each other by range, so between the first and last publish its own graph is briefly unresolvable; the suites recognise that and exit 2 SKIPPED rather than reporting a failure nobody can act on. A missing version of the package actually requested stays a real error — see `tests/install-classification.spec.ts`.

CI runs all four on pull requests, and the nightly re-runs the e2e on both channels.

## Reviewing your own work

The verification layers above catch code that does not do what it says. These catch the other thing — work that is correct everywhere the author looked. Each rule is here because it was broken here first, and each failure was invisible from inside the change that caused it.

**Review every pull request before opening it, the ones that only touch CI included.** The plugin source got both `/code-review` and `/security-review`; the release workflow got neither, on the reasoning that it was plumbing rather than product. It was the plumbing holding a credential that can publish this package under its own name, and the first review ever pointed at it found the job running `dsh@latest` — deliberately unpinned — beside `id-token: write`. "It is only config" is exactly wrong where the config holds credentials.

**A self-review checks the implementation against the author's threat model and cannot check the model.** `release.yml` was written believing trusted publishing means there is no secret to leak, and re-reading it confirmed the implementation matched that belief. What re-reading could not surface is that an OIDC credential is not stored but *is* mintable by anything sharing the job — the first question asked by a reader who does not already hold the belief. Where a change rests on a security argument, have the argument read by something that did not write it.

**Apply a rule by enumerating instances, never from memory.** Three times here a rule landed everywhere but one place, and every instance that *was* written looked correct on its own, so nothing inside the change reported that it had stopped early: `register` and `registerUpgrade` wrapped but not `registerFallback`, which served the built frontend to the LAN ungated for a release; `permissions:` on two workflows of three; the safe `env:` form on one workflow step of five. The one time it went right — the action SHA pins — is the one time the list came from `grep` rather than recall.

**A comment stating a policy is a claim the code has to honour.** `dependabot.yml` described `@deepseek-ai/*` as deliberately out of scope and then configured nothing of the kind, leaving the updater aimed at exactly the pins the paragraph above it explained must not move. Prose and code contradicting each other in the same file is not a subtle defect; it survives because the author re-reads the sentence they meant rather than the one they wrote.

## Releasing

Two workflows, run in order from the Actions tab. Both are deliberate: pushing a tag starts nothing, and neither runs on its own.

1. **Bump the version** on `main` (`npm version patch --no-git-tag-version`, or edit `package.json`) and merge it.
2. **release** — *Run workflow*, on `main`, type the version, untick **dry_run**. Gates the tree, then creates the tag `v<version>` and the GitHub Release.
3. **publish-npm** — *Run workflow*, on `main`, type the same version, untick **dry_run**. Checks out that tag, gates it again, and publishes to npm.

The version is typed rather than inferred, and checked against `package.json` both times. It is a confirmation, not a source: npm publishes what `package.json` says, so the check is there to catch the release started without bumping the version first.

**Why two workflows rather than one.** npm allows a package exactly one trusted publisher configuration, so exactly one file here can hold the OIDC credential. Keeping it in the one that does nothing else is what stops the gate's deliberately-unpinned dependencies from running beside a credential that can publish under this name. Each workflow is also split into `verify` and `publish`/`tag` jobs for the same reason, one level down.

**publish-npm publishes the tag, never a branch.** Naming a version and getting whatever `main` holds is how a release comes to differ from what was reviewed. Both workflows additionally refuse a real run from anywhere but `main`, because `workflow_dispatch` offers every branch and the workflow *file* comes from whichever ref is selected.

Guards, all of which run before the slow legs and all of which fail closed — a network error or a 5xx is never read as "clear to proceed":

| Refused | Because |
|---|---|
| a version already on the registry | npm versions are immutable; publish a new one |
| a tag that already exists | an earlier release got part-way, which needs a person |
| a **GitHub Release** that already exists | releases are immutable once published where that is enabled, so it cannot be replaced |
| a version disagreeing with `package.json` | npm would publish something other than what was asked for |

A version containing a hyphen publishes to `next`, everything else to `latest`, mirroring upstream's own channels.

Leaving `dry_run` ticked (the default) runs the entire gate and stops short: no tag, no Release, `npm publish --dry-run`. That is the rehearsal.

The two gates are deliberately asymmetric. **release** runs `check` only: what it produces ships nothing on its own, and publish-npm re-gates the same tree before anything reaches the registry, so running the e2e legs in both would be forty-five minutes proving the same thing twice in the documented flow. It is not skipped entirely because the Release it creates is effectively immutable, and announcing a version built from a tree that does not typecheck is not a thing to undo.

**publish-npm** runs all four layers, because it is the one that ships. A tag is an intent to release, not evidence the tree still works, and since nothing pins `dsh`, a tag cut last week can fail against today's upstream — the failure only time can introduce, and the reason this gate is not the redundant one. A SKIPPED e2e blocks the publish rather than passing.

### One-time setup, which the workflows cannot do for themselves

OIDC cannot perform a package's **first** publish: npm requires the package to exist before a trusted publisher can be attached to it, and unlike PyPI it has no way to reserve a name in advance. (Confirmed against npm's docs on 2026-08-24 — `npm trust` says the same: "The package you're configuring must already exist on the npm registry.") So the first version is published by hand, once:

1. Own the `@koalafacts` scope on npm — as an org or a user scope. Publishing into a scope you do not own fails with a 404 that reads like the package is missing.
2. `npm login`, then `npm publish --access public` from a clean checkout. (A `0.0.0` placeholder works just as well if you would rather not spend the real version on it.)
3. Attach the trusted publisher, naming **`publish-npm.yml`** — the workflow that actually publishes, not `release.yml`:

   ```sh
   npm trust github @koalafacts/deepseek-harness-lanyard \
     --repo KoalaFacts/deepseek-harness-lanyard \
     --file publish-npm.yml \
     --env production \
     --allow-publish
   ```

   `--allow-publish` is not optional: a configuration must now grant at least one action explicitly (the other is `--allow-stage-publish`), and one granting nothing publishes nothing. `--env production` is not optional either — the publishing job declares that environment, and npm matches on it, so a configuration without it fails at authentication with an error naming nothing useful. In the website UI the same settings live under **Packages → the package → Settings → Trusted publishing**, which is where they moved from the old `/access` tab.

   npm does not validate any of this when it is saved. A wrong repository, filename or environment is accepted quietly and only surfaces as a failure at the next publish.

   **A package may have only one configuration at a time.** Creating a second errors rather than adding; `npm trust list` shows the current one and `npm trust revoke --id <id>` removes it. That is why the credential lives in exactly one workflow.

4. Create the **`production`** environment (Settings → Environments) and give it a **deployment branch rule** limiting it to `main`. Add required reviewers if you want a second pair of eyes on every publish; the branch rule is the part that matters here.

   This is the only mechanism that actually binds which ref may reach the credential. Both workflows also check `github.ref` themselves, but that guard sits in the file the ref supplies — a branch carrying an edited copy of the workflow simply deletes it. An environment is enforced by GitHub, outside the file.

   **Referencing an environment that does not exist creates it, silently, with no protection rules.** So a `production` that nobody configured looks exactly like a `production` that is doing its job, in the Actions UI and in this file alike. Check it has the branch rule.

After that every release goes through the Actions tab. Two version floors are load-bearing and easy to misread if they drift: trusted publishing needs npm **≥ 11.5.1** and Node **≥ 22.14**. The npm bundled with Node 22 is older than that, so `publish-npm` upgrades npm before publishing; without it the publish fails on authentication with an error that never mentions the version.
