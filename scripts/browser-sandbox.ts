/**
 * Browser E2E launch policy only: selecting a sandbox is an explicit opt-in.
 * This never modifies TLS, admission, administrator URL policy or DSH itself.
 */
export interface BrowserSandboxPolicy {
  chromiumSandbox: boolean
  nativeArgs: string[]
}

export function browserSandboxPolicy(mode: string | undefined): BrowserSandboxPolicy {
  if (mode === undefined) return { chromiumSandbox: false, nativeArgs: ['--no-sandbox'] }
  if (mode === 'required') return { chromiumSandbox: true, nativeArgs: [] }
  throw new Error('LANYARD_CHROMIUM_SANDBOX must be "required" or unset')
}
