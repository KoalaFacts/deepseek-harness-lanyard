# AGENTS.md

Guidance for coding agents (including Claude Code) working in this repository. `CLAUDE.md` is a symlink to this file, following the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) convention — edit this one.

## What this is

`@koalafacts/deepseek-harness-lanyard` is an **out-of-tree `dsh` plugin bundle** with exactly one purpose: letting its author use the `dsh` web GUI from a phone, on a home network. It publishes to npm and installs with `dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard`.

Everything in it — the pairing token, the self-signed TLS, the loopback pins — exists to make that one thing safe enough to leave running. **It is not a general-purpose gateway, reverse proxy, or auth layer, and should not grow into one.** A change that does not serve someone opening the GUI on their phone is out of scope, however reasonable it sounds; the security surface here is small because the use case is small, and that is the whole design.

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
| `lanyard-startup` | `web-startup` | `webStartup`; lifts the `--host 0.0.0.0` refusal, requires a pairing token instead |
| `lanyard-tls` | — | `lanyardTls` (PEM paths only, never key material) |
| `lanyard-webserver` | `webserver` | `webServer` — a `WebServer` subclass |
| `lanyard-keep-awake` | — | platform sleep inhibitor |
| `lanyard-pairing` | — | index tap for the browser half, plus the pairing line |

The gate works because **every consumer contributes through one of `WebServer`'s three registration seats** — `register`, `registerUpgrade`, and the single-owner `registerFallback` that answers whatever no named route matched. Overriding all three puts admission in front of every request the composition serves, so `dsh-client-connection` — which owns `/api` — runs completely unmodified. `assertRegistrarsWrapped()` fails the load if a future harness grows a fourth.

## Load-bearing invariants

Break any of these and the plugin fails **open** — serving the LAN with no gate — while tests may still look green. Each has a test that fails when mutated; keep it that way.

- **TLS is terminated in-process and the decrypted socket handed to the inherited `node:http` server.** A TCP-forwarding proxy would make every request read as a loopback peer and silently disable the token gate entirely. Do not "simplify" this into a proxy. Held down by the real-LAN-peer test in `tests/gated-webserver.spec.ts`.
- **Loopback means the socket peer, never the `Host` header.** On an all-interfaces bind any client can claim `Host: localhost`.
- **Unknown Gateway namespaces deny.** The Typert Gateway claims every `namespace/method` a live service exposes, so a per-method allowlist would default each new endpoint to reachable.
- **`bootstrapAuthToken` must stay entirely self-contained.** It reaches the browser through `Function.prototype.toString`, so a reference to module scope would serialize to an identifier that does not exist in the page. `npm run build` evaluates the built artifact and fails if it stops working.
- **The gate's refusal body is its own marker**, not the bare `forbidden` that `dsh-client-connection`'s Host fence also answers with — otherwise nothing can tell admission from the fence behind it.
- **Every registration seat is wrapped, and a new one fails the load.** Wrapping `register` and `registerUpgrade` but not `registerFallback` shipped the built frontend to the LAN ungated for a release, and looked identical from inside this class — no path is registered for that seat, so even the unclaimed-path warning was blind to it. `assertRegistrarsWrapped()` turns an upstream `register*` addition into a loud load failure instead of a silent widening.
- **Route matching decodes the pathname; endpoint classification reads both forms.** `dsh-client-modules` and `dsh-host-frontend-static` both `decodeURIComponent` before resolving a file, so a raw-form suffix match let `%70` spell `.map` past the exclusion. A pathname whose escapes do not decode is refused rather than admitted.
- **`port` is the loopback listener; `networkPort` is the one a device reaches.** Every consumer of `port` in the shipped composition builds `http://127.0.0.1:${port}` from it — the browser handoff, the `DSH_WEB_URL` shell variable, and the URL the model is told it is serving. Under TLS that has to be the inherited plaintext server, not the TLS front, or all three name an https listener over http. A pairing link needs the opposite and says so explicitly.
- **A reused certificate must still name the addresses the pairing link advertises.** The subject alternative names are a snapshot of the interfaces present when it was generated, and the certificate outlives them; reuse is what keeps a paired device's accept-once exception valid, but a certificate that no longer covers the current LAN address gives the phone a name mismatch rather than the untrusted-issuer prompt the README promises. `certificateCovers()` decides, matching whole rendered entries — a substring test lets `10.0.0.71` answer for `10.0.0.7`.
- **`assertServer()` guards the inherited private `server` field.** TypeScript `private` is erased at runtime, so the subclass can reach it; an upstream rename must fail the load loudly rather than quietly serve plaintext.

## Replacing a shipped row means owning its whole contract

`lanyard-startup` sits in the seat `web-startup` held, so every row that reads `ctx.webStartup` must still find what it reads. Both failure modes are **silent**:

- a field this provider forgets falls back to the consuming row's schema default (this is how the shipped `--no-open` flag once went missing);
- an id the patch disables that no longer exists upstream is skipped with only a warning, leaving the stock ungated carrier mounted beside this one.

`tests/webstartup-contract.spec.ts` checks both against the **installed** `@deepseek-ai/dsh-web-app`, never a vendored copy. When upstream moves, that test is the first thing to read.

## Client-owned paths are configuration

Every route path the gate keys on belongs to a *client* package — `API_PATH` (`dsh-client-connection`), `EVENTS_ENDPOINT` (`dsh-client-hmr`), the bundle prefix (`dsh-client-modules`). None is this plugin's to hardcode, and `apiPathPrefix` and `loopbackOnlyPaths` fail **open** on drift. They are schema-defaulted `Config` fields, and `GatedWebServer` warns once the tree settles about any configured path no row claimed.

## Conventions

Inherited from the harness; follow them so this reads like the code it composes with.

- **Config is an exported interface plus a same-named Schemastery schema**, defaults on the schema fields. No hardcoded tunables: anything two deployments may set differently is a config field. Protocol constants and security invariants stay fixed.
- **Registrations are effects** — every contribution goes through `ctx.effect()`, and a registry's `register()` returns the disposer.
- **Misconfiguration fails loud at load.** Never silently skip a missing referent, and never fall back to a weaker security posture.
- **Secrets travel as credential references, never values.** Config surfaces are echoed by `dsh --dump-config`, the plugin-inventory RPC, and crash dumps.
- **`README.md` and `README.zh.md` are a pair.** A user-visible change updates both, following the harness's bilingual docs convention.
- ESM, `strict: true`, `.ts` extensions on local relative imports. Every module and export carries concise JSDoc for its non-obvious contract; do not restate the code.
- **Dependency weight is part of the choice.** This runs inside someone's `dsh` install, so a runtime dependency's own tree matters: the terminal QR uses `qrcode-terminal` (zero dependencies) rather than `qrcode`, which pulls `yargs` and `pngjs`.
- **Peer dependencies are declared `optional`** because the *installation* provides them, not the profile. No version range can express the supported window while upstream ships prereleases — npm semver admits a prerelease only when a comparator shares its exact `major.minor.patch`. Compatibility is enforced at load and in CI, not by the range.

## Verification

Four layers, each covering what the one below cannot:

| | |
|---|---|
| `npm run test` | unit behavior against published `@deepseek-ai/dsh-*`, no harness checkout |
| `npm run build` | the shipped `lib/` loads and the serialized bootstrap still runs |
| `npm run test:e2e` | a real `dsh` boot, gate driven from the machine's LAN address over TLS |
| `npm run test:e2e:browser` | the pairing flow in Chromium — the only thing that proves the cookie rides a real fetch |

**Mutation-test any guard you add or change**: break what it guards and confirm the test fails. This repo has twice found tests that passed against the mutation and guarded nothing. A green suite is not evidence until it can go red.

Both e2e suites exit **2 with a loud SKIPPED message** where they cannot run (no LAN interface, no Playwright) rather than passing vacuously.

**Nothing pins `dsh`.** A plugin that only works against one frozen release is not working, and pinning the CLI would not pin anything anyway — `dsh` floats its own dependencies through `^` ranges. The suites install a dist-tag: `latest` by default, which is what a person installing today gets, and the nightly adds `next`, upstream's prerelease line, so a breaking change surfaces before it reaches users.

An install that cannot resolve is not a test result. `dsh` publishes as a wave of packages that depend on each other by range, so between the first and last publish its own graph is briefly unresolvable; the suites recognise that and exit 2 SKIPPED rather than reporting a failure nobody can act on. A missing version of the package actually requested stays a real error — see `tests/install-classification.spec.ts`.

CI runs all four on pull requests, and the nightly re-runs the e2e on both channels.

## Releasing

`.github/workflows/release.yml` publishes to npm with **npm trusted publishing (OIDC)**. No npm token is stored in this repository — the workflow exchanges a short-lived GitHub OIDC token for registry credentials, so there is nothing to leak or rotate.

Releasing is deliberate rather than automatic: **pushing a tag does not publish anything.** The workflow only runs when someone starts it.

1. Bump the version on `main` (`npm version patch --no-git-tag-version`, or edit `package.json`) and merge it.
2. Actions → **release** → *Run workflow*, on `main`, with **dry_run unticked**.

The version comes from `package.json` on the ref you select, and a real publish is refused from anywhere but `main` — `workflow_dispatch` offers every branch, and npm's trusted publisher matches owner/repo/workflow rather than the branch, so this is the only place that can be enforced. Dry runs are exempt, since rehearsing a branch is the point of them. A version containing a hyphen publishes to `next`, everything else to `latest`, mirroring upstream's own channels.

The tag and the GitHub Release are created by the workflow **after** a successful publish, never before — a failed publish leaves no tag claiming a version that is not on the registry. Two guards run before the slow legs: a version already on the registry is refused, and so is a version whose tag exists with nothing published behind it, since that combination needs a person to look at it.

Leaving `dry_run` ticked (the default) runs the entire gate and stops at `npm publish --dry-run`, publishing nothing and creating no tag. That is the rehearsal.

The run is split into `verify` and `publish`, and the split is a security boundary rather than a tidiness one. Verifying means executing a great deal of code this repository does not control — `dsh@latest` is deliberately unpinned, plus a Chromium download and the built artifact — while publishing holds an OIDC credential that can push a package under this name. Anything running beside that credential can mint it, so `publish` installs nothing, runs no lifecycle scripts, and takes the built `lib/` from `verify` as an artifact.

All four verification layers run again on every release. A tag is an intent to release, not evidence the tree still works, and since nothing pins `dsh`, a commit that passed last week can fail against today's upstream. A SKIPPED e2e therefore blocks the release rather than passing.

### One-time setup, which the workflow cannot do for itself

OIDC cannot perform a package's **first** publish: npm requires the package to exist before a trusted publisher can be attached to it, and unlike PyPI it has no way to reserve a name in advance. (Confirmed against npm's docs on 2026-08-24 — `npm trust` says the same: "The package you're configuring must already exist on the npm registry.") So the first version is published by hand, once:

1. Own the `@koalafacts` scope on npm — as an org or a user scope. Publishing into a scope you do not own fails with a 404 that reads like the package is missing.
2. `npm login`, then `npm publish --access public` from a clean checkout. (A `0.0.0` placeholder works just as well if you would rather not spend the real version on it.)
3. Attach the trusted publisher. The CLI does it without touching the website:

   ```sh
   npm trust github @koalafacts/deepseek-harness-lanyard \
     --repo KoalaFacts/deepseek-harness-lanyard \
     --file release.yml \
     --allow-publish
   ```

   `--allow-publish` is not optional: a configuration must now grant at least one action explicitly (the other is `--allow-stage-publish`), and one granting nothing publishes nothing. In the website UI the same setting lives under **Packages → the package → Settings → Trusted publishing**, which is where it moved from the old `/access` tab. Pass no `--env`: this workflow declares no environment, and the two sides must agree exactly.

   npm does not validate any of this when it is saved. A wrong repository, filename or environment is accepted quietly and only surfaces as a failure at the next publish.

After that every release goes through the Actions tab. **The trusted publisher names this workflow by filename**, so renaming `release.yml` breaks publishing until the npm side is changed to match; that failure surfaces as an authentication error that says nothing about the rename.

Two version floors are load-bearing and easy to misread if they drift: trusted publishing needs npm **≥ 11.5.1** and Node **≥ 22.14**. The npm bundled with Node 22 is older than that, so the workflow upgrades npm before publishing; without it the publish fails on authentication with an error that never mentions the version.
