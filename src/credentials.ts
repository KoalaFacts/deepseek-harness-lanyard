/**
 * Pairing-token resolution. Configuration carries a credential *reference* —
 * an environment-variable-shaped name — never the secret, so the surfaces that
 * echo composition config (`dsh --dump-config`, the plugin-inventory RPC, a
 * crash dump) cannot leak it, and the value may live in the environment, the
 * managed credential store, or a `.env` layer.
 *
 * Resolution happens once per load because admission is synchronous; a rotated
 * token takes effect on the next boot.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertPairingToken } from './admission.ts'

/** How to generate a pairing token, appended to the errors that demand one. */
export const GENERATE_TOKEN_HINT
  = 'generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'

/**
 * Resolve the deployment's pairing token from the credential reference its
 * configuration names.
 * @param ctx - plugin context; the credentials seam must be composed.
 * @param ref - environment-variable-shaped reference, or undefined for a loopback-only deployment.
 * @returns the token, or undefined when no reference was configured.
 * @throws when the seam is absent, the reference holds no value, or the value is too weak.
 */
export async function resolvePairingToken(ctx: Context, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(
      `lanyard: pairingTokenEnv ${JSON.stringify(ref)} needs the credentials service, which this composition does not provide`,
    )
  }
  const hit = await credentials.resolve(credentialRef(ref))
  if (hit === undefined) {
    throw new Error(
      `lanyard: pairingTokenEnv names ${JSON.stringify(ref)}, which holds no value in the environment, `
      + `the credential store, or a .env layer; ${GENERATE_TOKEN_HINT}`,
    )
  }
  assertPairingToken(hit.value)
  return hit.value
}
