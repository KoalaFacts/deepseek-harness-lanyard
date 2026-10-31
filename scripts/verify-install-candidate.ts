/**
 * Verify a CI candidate: main downloads its artifact; PRs pack ephemerally in the job.
 * LANYARD_CANDIDATE_DIR and LANYARD_EXPECTED_SHA are required.
 * Use --verify-only to check archive identity without a registry connection.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
interface PackageManifest {
  name: string
  version: string
  exports: Record<string, string | { types?: string; default?: string }>
}
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest
const tarballName = (manifest: PackageManifest): string =>
  manifest.name.replace(/^@/, '').replace('/', '-') + '-' + manifest.version + '.tgz'

/** Exact three-file payload, trusted main-run identity and content checksum. */
export function verifyInstallCandidate(directory: string, expectedSha: string): string {
  assert.match(expectedSha, /^[0-9a-f]{40}$/, 'expected full commit SHA')
  const tarName = tarballName(source)
  const expectedFiles = ['SHA256SUMS', 'SOURCE_SHA', tarName].sort()
  assert.deepEqual(readdirSync(directory).sort(), expectedFiles, 'candidate must contain exactly the published three files')
  for (const name of expectedFiles) {
    assert.ok(lstatSync(join(directory, name)).isFile(), 'candidate contains non-file: ' + name)
  }
  const sourceSha = readFileSync(join(directory, 'SOURCE_SHA'), 'utf8')
  assert.equal(sourceSha, expectedSha + '\n', 'candidate SOURCE_SHA differs from this main run')
  const checksum = readFileSync(join(directory, 'SHA256SUMS'), 'utf8')
  const match = /^([0-9a-f]{64})  ([^\n/\\]+\.tgz)\n$/.exec(checksum)
  assert.ok(match, 'expected one strict SHA256SUMS entry')
  assert.equal(match[2], tarName, 'checksum must name the candidate tarball')
  const tarball = join(directory, tarName)
  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  assert.equal(actual, match[1], 'candidate tarball checksum mismatch')
  return tarball
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, command + ' ' + args.join(' ') + ' failed:\n' + result.stdout + '\n' + result.stderr)
}

/** A resolved filename is not sufficient: exercise its installed ESM entrypoint. */
export async function verifyInstalledModule(resolved: string, specifier: string): Promise<void> {
  const loaded = await import(pathToFileURL(resolved).href) as Record<string, unknown>
  assert.ok(Object.keys(loaded).length > 0, 'installed module exported nothing: ' + specifier)
}

/** A loadable export is still wrong when it points to a different module.
 * Compare the entire installed map, including JS/types targets and wildcards.
 */
export function verifyInstalledExportMap(
  installed: PackageManifest['exports'], reviewed: PackageManifest['exports'],
): void {
  assert.deepEqual(installed, reviewed, 'installed export targets differ from reviewed source')
}

async function installCandidate(tarball: string): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'lanyard-candidate-consumer-'))
  try {
    writeFileSync(join(workspace, 'package.json'), '{"name":"lanyard-candidate-consumer","private":true}\n')
    console.log('lanyard candidate: installing published @deepseek-ai/dsh@latest into a clean workspace')
    run('pnpm', ['add', '@deepseek-ai/dsh@latest'], workspace)
    const dsh = join(workspace, 'node_modules', '.bin', 'dsh')
    assert.ok(existsSync(dsh), 'published CLI installed no dsh binary')
    const home = join(workspace, 'dsh-home')
    console.log('lanyard candidate: adding the DOWNLOADED tarball with dsh plugin --profile web add')
    run(dsh, ['plugin', '--profile', 'web', 'add', tarball], workspace, { ...process.env, DSH_HOME: home })

    const profilePath = join(home, 'profiles', 'web', 'package.json')
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.ok(profile.dsh?.profile?.bundles?.includes(source.name), 'installed bundle missing from the web profile')
    const fromProfile = createRequire(profilePath)
    const manifestPath = fromProfile.resolve(source.name + '/package.json')
    const installedRoot = realpathSync(dirname(manifestPath))
    const nested = relative(realpathSync(workspace), installedRoot)
    assert.ok(nested !== '..' && !nested.startsWith('..' + sep) && !isAbsolute(nested), 'package resolved outside clean workspace')
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    assert.equal(installed.name, source.name)
    assert.equal(installed.version, source.version)
    verifyInstalledExportMap(installed.exports, source.exports)
    let modules = 0
    for (const [subpath, target] of Object.entries(installed.exports)) {
      if (typeof target === 'string') continue
      assert.ok(typeof target.types === 'string' && typeof target.default === 'string', 'missing JS/type export: ' + subpath)
      const specifier = subpath === '.' ? source.name : source.name + subpath.slice(1)
      const resolved = realpathSync(fromProfile.resolve(specifier))
      const inside = relative(installedRoot, resolved)
      assert.ok(inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside), 'module escapes installed package: ' + subpath)
      assert.ok(resolved.endsWith('.js'), 'not executable JS: ' + subpath)
      assert.ok(existsSync(join(installedRoot, target.types)), 'missing installed declaration: ' + subpath)
      // Optional DSH/Cordis peers are supplied by the running carrier's
      // composition, not by the standalone profile's module resolver. A raw
      // Node import of those exports incorrectly fails with ERR_MODULE_NOT_FOUND.
      // Import the dependency-free admission export directly; below, boot
      // the exact verified tarball in real DSH to exercise every plugin row.
      if (subpath === './admission') await verifyInstalledModule(resolved, specifier)
      modules++
    }
    assert.equal(modules, 7, 'expected seven consumer module exports')
    console.log('lanyard candidate: all seven installed JS/type exports resolve inside the installed package')

    // An ordinary Node import cannot resolve the carrier-provided optional
    // Cordis/DSH peer packages in this clean plugin profile. Test the actual
    // supported load path instead: a fresh real DSH composition loading the
    // *same* SHA-verified tarball, with a live TLS listener and upstream login.
    const { withDshDeployment, probe, rpcCall, refused, sessionCookie, sessionCookieSecure, succeeded } = await import('./dsh-harness.ts')
    await withDshDeployment(async ({ bundles, packageName, pairingLink, port, ca }) => {
      assert.equal(packageName, source.name)
      assert.ok(bundles.includes(source.name), 'candidate bundle did not join the real DSH profile')
      const url = new URL(pairingLink)
      assert.equal(url.protocol, 'https:', 'pairing did not use TLS')
      const denied = await probe(url.hostname, port, '/api/session/list', rpcCall('session/list', { _request: {} }), ca)
      assert.equal(refused(denied), true, 'unauthenticated LAN request was not denied by the gate')
      const paired = await probe(url.hostname, port, url.pathname + url.search, {}, ca)
      assert.equal(paired.status, 303, 'upstream launch-token exchange did not redirect')
      const cookie = sessionCookie(paired)
      assert.ok(cookie, 'upstream did not issue a session cookie')
      assert.equal(sessionCookieSecure(paired), true, 'TLS session cookie was not Secure')
      // A successful token exchange alone does not prove that the downloaded
      // candidate can actually use the authenticated API. Exercise the real
      // installed bundle with the newly issued cookie, not a fresh checkout.
      const request = rpcCall('session/list', { _request: {} })
      const authenticated = await probe(url.hostname, port, '/api/session/list',
        { ...request, headers: { ...request.headers, cookie } }, ca)
      assert.equal(succeeded(authenticated), true, 'paired candidate could not execute the authenticated session RPC')
    }, { tarball })
    console.log('lanyard candidate: PASS; verified ' + source.name + '@' + source.version
      + ' installed with seven exports, booted in real DSH, denied anonymous LAN traffic and completed TLS pairing')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.LANYARD_CANDIDATE_DIR
  const expectedSha = process.env.LANYARD_EXPECTED_SHA
  assert.ok(directory && expectedSha, 'set LANYARD_CANDIDATE_DIR and LANYARD_EXPECTED_SHA')
  const tarball = verifyInstallCandidate(directory, expectedSha)
  console.log('lanyard candidate: download members, commit identity and SHA-256 verified')
  if (!process.argv.includes('--verify-only')) await installCandidate(tarball)
}
