/** Pairing-token resolution: the reference travels through config, never the secret. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolvePairingToken } from '../src/credentials.ts'

const TOKEN = 'pairing-token_0123456789-ab'

/** A context whose credentials seam answers from one fixed table. */
function withCredentials(table: Record<string, string>): Context {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: (ref: string) => Promise.resolve(ref in table ? { value: table[ref], source: 'env' } : undefined),
  })
  return ctx
}

describe('resolvePairingToken', () => {
  it('resolves a configured reference through the seam', async () => {
    await expect(resolvePairingToken(withCredentials({ DSH_PAIRING_TOKEN: TOKEN }), 'DSH_PAIRING_TOKEN'))
      .resolves.toBe(TOKEN)
  })

  it('resolves to nothing when no reference is configured, leaving the deployment loopback-only', async () => {
    await expect(resolvePairingToken(new Context(), undefined)).resolves.toBeUndefined()
  })

  it('fails loudly when the composition provides no credentials seam', async () => {
    await expect(resolvePairingToken(new Context(), 'DSH_PAIRING_TOKEN'))
      .rejects.toThrow(/needs the credentials service/)
  })

  it('fails loudly when the reference holds no value, rather than serving unauthenticated', async () => {
    await expect(resolvePairingToken(withCredentials({}), 'DSH_PAIRING_TOKEN'))
      .rejects.toThrow(/holds no value/)
  })

  it('fails loudly on a value too weak to guard network access', async () => {
    await expect(resolvePairingToken(withCredentials({ DSH_PAIRING_TOKEN: 'short' }), 'DSH_PAIRING_TOKEN'))
      .rejects.toThrow(/at least 16 characters/)
  })

  it('refuses a reference that is not an environment-variable name', async () => {
    await expect(resolvePairingToken(withCredentials({}), 'not a ref')).rejects.toThrow(/credential ref/)
  })
})
