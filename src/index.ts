/**
 * `@koalafacts/lanyard` — secure LAN access for the DeepSeek Harness web GUI,
 * as an out-of-tree `dsh` plugin bundle.
 *
 * The bundle is composed through `cordis.patch.yml`, which loads each row from
 * its own subpath export; this module is the package's public surface for
 * anything embedding the pieces directly (tests, another bundle, a deployment
 * assembling its own composition).
 * @module
 */

export {
  admit, assertPairingToken, isLoopbackAddress,
  AUTH_COOKIE_NAME, AUTH_FRAGMENT_PARAM, AUTH_STORAGE_KEY,
  PAIRING_TOKEN_PATTERN, PAIRING_TOKEN_REQUIREMENT,
} from './admission.ts'
export { GENERATE_TOKEN_HINT, resolvePairingToken } from './credentials.ts'
export { bootstrapAuthToken, injectPairingBootstrap, pairingBootstrapScript } from './browser-auth.ts'
export { GatedWebServer, isPrivilegedEndpoint } from './webserver.ts'
export type { Config as GatedWebServerConfig } from './webserver.ts'
export { lanIpv4Addresses, LANYARD_TLS_SERVICE } from './tls.ts'
export type { Config as LanyardTlsConfig, LanyardTlsValues } from './tls.ts'
export { resolveStartupValues, webCommand, WEB_STARTUP_SERVICE } from './startup.ts'
export type { WebStartupValues } from './startup.ts'
export { pairingAnnouncement } from './pairing.ts'
export type { Config as PairingConfig, PairingAnnouncement } from './pairing.ts'
export { resolveInhibitor } from './keep-awake.ts'
export type { Config as KeepAwakeConfig, InhibitorCommand } from './keep-awake.ts'
