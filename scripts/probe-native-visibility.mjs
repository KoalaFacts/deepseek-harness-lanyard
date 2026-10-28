// Standalone diagnostic; NOT a product E2E and NOT run on the blocked local browser.
// Usage in an already-authorized protected browser runner:
//   xvfb-run -a node scripts/probe-native-visibility.mjs /path/to/repository
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

assert(process.argv[2], 'supply the repository containing installed pinned Playwright')
const { chromium } = createRequire(resolve(process.argv[2], 'package.json'))('playwright')

// Cancel a winning race's unused timeout; otherwise this diagnostic can keep
// the Node process alive after Chromium is gone.
async function settleWithin(work, ms, fallback) {
  let timer
  try {
    return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function probe(noDefaults) {
  const profile = await mkdtemp(join(tmpdir(), 'lanyard-visibility-'))
  // This isolated, blank-page diagnostic needs the same test-runner sandbox
  // exemption used by Playwright's managed Chromium on GitHub-hosted Linux,
  // where unprivileged namespaces are unavailable. It has no DSH, secrets,
  // LAN listener, certificates or external navigation; runtime TLS/auth/pins
  // and the separate real-DSH browser gate are not affected.
  const child = spawn(chromium.executablePath(), [
    '--no-sandbox',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let launchError
  let spawned = false
  child.once('spawn', () => { spawned = true })
  // Do not log browser/profile metadata; expose only a bounded diagnostic on failure.
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000) })
  // Chromium helpers can inherit stderr, so 'close' can lag behind 'exit'.
  // A failed spawn has no 'exit' event: settle on its pre-spawn 'error' only.
  // Never treat a post-spawn error as permission to delete a live profile.
  const childExited = new Promise(resolveExit => {
    child.once('exit', resolveExit)
    child.once('error', error => {
      launchError = error
      if (!spawned) resolveExit()
    })
  })
  let browser
  try {
    let port
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`owned Chromium exited before CDP readiness: ${stderr}`)
      try {
        const first = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
        if (/^\d+$/.test(first) && Number(first) > 0 && Number(first) <= 65535) {
          port = Number(first)
          break
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await delay(100)
    }
    assert(port, 'owned Chromium CDP readiness timed out')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults })
    const context = browser.contexts()[0]
    assert(context, 'the owned default context must exist')
    const original = context.pages()[0]
    assert(original, 'the native initial page must exist')
    await original.setContent('<textarea aria-label="draft"></textarea>')
    await original.getByLabel('draft').fill('synthetic unsent draft')
    await original.evaluate(() => {
      window.visibilityEvents = []
      document.addEventListener('visibilitychange', () => window.visibilityEvents.push(document.visibilityState))
    })
    const other = await context.newPage()
    await other.bringToFront()
    if (noDefaults) {
      await original.waitForFunction(() => document.visibilityState === 'hidden', undefined,
        { polling: 100, timeout: 10000 })
      assert.equal(await original.evaluate(() => document.visibilityState), 'hidden')
    } else {
      // Negative control: ordinary Playwright attachment retains focus capture.
      await delay(1000)
      assert.equal(await original.evaluate(() => document.visibilityState), 'visible')
    }
    await original.bringToFront()
    await original.waitForFunction(() => document.visibilityState === 'visible', undefined,
      { polling: 100, timeout: 10000 })
    assert.equal(await original.getByLabel('draft').inputValue(), 'synthetic unsent draft')
    const events = await original.evaluate(() => window.visibilityEvents)
    if (noDefaults) {
      const hidden = events.indexOf('hidden')
      assert(hidden >= 0 && events.slice(hidden + 1).includes('visible'), 'native hidden then visible events required')
    }
    console.log(JSON.stringify({ noDefaults, events, draftRetained: true }))
  } finally {
    // Only terminate this fixture's process; await exit before removing its profile.
    try {
      if (browser) {
        const closed = await settleWithin(browser.close().then(() => true), 5000, false)
        if (!closed) throw new Error('CDP disconnect timed out')
      }
    }
    finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      let stopped = await settleWithin(childExited.then(() => true), 5000, false)
      if (!stopped) {
        child.kill('SIGKILL')
        stopped = await settleWithin(childExited.then(() => true), 5000, false)
      }
      // Never hold this diagnostic open on inherited helper stderr handles.
      child.stderr.destroy()
      if (!stopped) throw new Error(`owned browser did not exit; retained temporary profile ${profile}`)
      await rm(profile, { recursive: true, force: true })
    }
  }
}

await probe(false)
await probe(true)
console.log('native visibility diagnostic passed; no DSH/mobile/security acceptance implied')
