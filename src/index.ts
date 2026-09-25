/**
 * `@koalafacts/deepseek-harness-lanyard` — use the DeepSeek Harness web GUI
 * from your phone, as an out-of-tree `dsh` plugin bundle. Everything here
 * exists to make that one thing safe; nothing here is a general-purpose
 * gateway, and nothing here authenticates — upstream's own browser session
 * does that.
 *
 * The bundle is composed through `cordis.patch.yml`, which loads each row from
 * its own subpath export; this module is the package's public surface for
 * anything embedding the pieces directly (tests, another bundle, a deployment
 * assembling its own composition).
 * @module
 */

export { admit, isLoopbackAddress, isSessionAuthority } from './admission.ts'
export type { SessionAuthority } from './admission.ts'
export { GatedWebServer, isPrivilegedEndpoint } from './webserver.ts'
export type { Config as GatedWebServerConfig } from './webserver.ts'
export { lanIpv4Addresses, LANYARD_TLS_SERVICE } from './tls.ts'
export type { Config as LanyardTlsConfig, LanyardTlsValues } from './tls.ts'
export { resolveStartupValues, webCommand, WEB_STARTUP_SERVICE } from './startup.ts'
export type { WebStartupValues } from './startup.ts'
export { isLaunchLinkIssuer, pairingLink } from './pairing.ts'
export type { Config as PairingConfig, LaunchLinkIssuer } from './pairing.ts'
export { resolveInhibitor } from './keep-awake.ts'
export type { Config as KeepAwakeConfig, InhibitorCommand } from './keep-awake.ts'
