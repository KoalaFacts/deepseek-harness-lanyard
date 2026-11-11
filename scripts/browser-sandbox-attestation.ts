/**
 * Read the Chromium-owned chrome://sandbox diagnostic in required-mode E2E.
 * A launch flag alone does not prove the renderer acquired kernel isolation.
 * Never accept an unavailable, administrator-blocked or incomplete report.
 * This test-only check does not establish certificate trust or phone security.
 */
import type { BrowserContext } from 'playwright'

export function sandboxReportIndicatesProtection(report: string): boolean {
  const flat = report.replace(/\s+/g, ' ')
  return /\bYou are adequately sandboxed\b/i.test(flat)
    && /\bPID namespaces\s*:?\s*Yes\b/i.test(flat)
    && /\bSeccomp-BPF sandbox\s*:?\s*Yes\b/i.test(flat)
}

export async function assertActualChromiumSandbox(context: BrowserContext): Promise<void> {
  const page = await context.newPage()
  try {
    await page.goto('chrome://sandbox', { waitUntil: 'domcontentloaded', timeout: 15_000 })
    if (!page.url().startsWith('chrome://sandbox')) {
      throw new Error('Chromium sandbox diagnostic did not open')
    }
    const report = await page.locator('body').innerText({ timeout: 10_000 })
    if (!sandboxReportIndicatesProtection(report)) {
      throw new Error('Chromium did not attest PID namespaces, Seccomp-BPF and adequate sandboxing')
    }
    console.log('lanyard e2e: chrome://sandbox reports PID namespaces and Seccomp-BPF enabled')
  } finally {
    await page.close()
  }
}
