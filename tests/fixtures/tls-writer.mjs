/** Owned test process: pause at key publication, never contact a network service. */
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const [moduleUrl, directory, mode] = process.argv.slice(2)
// Preserve symlink/.. components for filesystem-semantics regression cases.
const cert = `${directory}/cert.pem`, key = `${directory}/key.pem`
const rename = fs.renameSync
const fault = Object.assign(new Error('controlled certificate rename EIO'), { code: 'EIO' })
if (mode === 'hold-fail' || mode === 'hold-success') {
  fs.renameSync = (from, to) => {
    if (to === key) {
      fs.writeFileSync(join(directory, 'ready'), '')
      const until = Date.now() + 15_000
      while (!fs.existsSync(join(directory, 'release'))) {
        if (Date.now() > until) throw new Error('owned fixture release timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    if (to === cert && mode === 'hold-fail') throw fault
    return rename(from, to)
  }
  syncBuiltinESMExports()
}
try {
  const { generateMaterial } = await import(moduleUrl)
  await generateMaterial(cert, key, ['192.0.2.10'])
  process.stdout.write(JSON.stringify({ ok: true }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: String(error.message), code: error.code, original: error === fault }) + '\n')
} finally {
  fs.renameSync = rename
  syncBuiltinESMExports()
}
