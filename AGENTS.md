# AGENTS.md

Guidance for coding agents (including Claude Code) working in this repository. `CLAUDE.md` is a symlink to this file, following the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) convention — edit this one.

## What this is

`@koalafacts/deepseek-harness-lanyard` is an **out-of-tree `dsh` plugin bundle** whose purpose is using the `dsh` web GUI from a phone on your own network. It makes binding `0.0.0.0` safe with a pairing token plus self-signed TLS. It publishes to npm and installs with `dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard`.

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

The gate works because **every consumer registers routes through `ctx.webServer.register` / `registerUpgrade`**. Overriding those two methods puts admission in front of everything the composition serves, so `dsh-client-connection` — which owns `/api` — runs completely unmodified.

## Load-bearing invariants

Break any of these and the plugin fails **open** — serving the LAN with no gate — while tests may still look green. Each has a test that fails when mutated; keep it that way.

- **TLS is terminated in-process and the decrypted socket handed to the inherited `node:http` server.** A TCP-forwarding proxy would make every request read as a loopback peer and silently disable the token gate entirely. Do not "simplify" this into a proxy. Held down by the real-LAN-peer test in `tests/gated-webserver.spec.ts`.
- **Loopback means the socket peer, never the `Host` header.** On an all-interfaces bind any client can claim `Host: localhost`.
- **Unknown Gateway namespaces deny.** The Typert Gateway claims every `namespace/method` a live service exposes, so a per-method allowlist would default each new endpoint to reachable.
- **`bootstrapAuthToken` must stay entirely self-contained.** It reaches the browser through `Function.prototype.toString`, so a reference to module scope would serialize to an identifier that does not exist in the page. `npm run build` evaluates the built artifact and fails if it stops working.
- **The gate's refusal body is its own marker**, not the bare `forbidden` that `dsh-client-connection`'s Host fence also answers with — otherwise nothing can tell admission from the fence behind it.
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
