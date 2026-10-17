/**
 * The Remote surface of the installed dsh, held to the classification.
 *
 * Admission is per namespace: inside a namespace a paired device may reach,
 * every method is reachable unless pinned by exact name. With no upper bound
 * on the supported window, dsh no longer refuses this bundle on a new line
 * until someone has looked at it — so this is what makes a new or renamed
 * method in a reachable namespace a red test instead of a silent widening.
 * It reads every `lib/typert.host.js` the installed `@deepseek-ai/dsh` reaches,
 * the generated manifest the Gateway itself serves from; the nightly contract
 * job reruns it against upstream's `next`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PAIRED_NAMESPACES, DEFAULT_PRIVILEGED_METHODS } from '../src/webserver.ts'

/**
 * Every method of every reachable namespace, as a person classified it. A
 * failure here means upstream added, renamed or removed one: decide whether a
 * phone may call it, then either list it here or pin it in
 * `DEFAULT_PRIVILEGED_METHODS` (and list it here too), and update AGENTS.md.
 *
 * Notes on the ones that are not plainly "the conversation":
 * - `session/initializeDefaultModel` writes the deployment's default model when
 *   no provider is configured; `selectModel` already saves the default.
 * - `directoryPicker/createDirectory` writes to the filesystem, as the agent and
 *   the terminal already can; `pick` (the host's native chooser) is pinned.
 * - `session/canOpenWorkspacePath` and `workspacePathApplications` only read;
 *   `openWorkspacePath` acts on the desktop and is pinned.
 */
const REVIEWED: Record<string, string[]> = {
  agentPresets: ['list', 'read', 'select'],
  commands: ['execute', 'list'],
  directoryPicker: ['createDirectory', 'list', 'pick'],
  fileReferences: ['list'],
  fileUploads: ['upload'],
  goals: ['clear', 'complete', 'create', 'edit', 'get', 'pause', 'resume'],
  job: ['follow', 'kill', 'list'],
  messageFeedback: ['delete', 'list', 'put'],
  officeToPdf: ['generation', 'render'],
  permissionPresets: ['catalog'],
  schedule: ['catalog', 'delete', 'history', 'list', 'update'],
  session: [
    'attachment', 'canOpenWorkspacePath', 'cancel', 'control', 'create', 'follow', 'fork',
    'initializeDefaultModel', 'list', 'modelCatalog', 'openWorkspacePath', 'page', 'projections',
    'prompt', 'rename', 'search', 'selectModel', 'updateQueue', 'workspacePathApplications',
  ],
  sessionFeedback: ['record'],
  sessionReferenceResolver: ['candidates'],
  skills: ['list'],
  subagents: ['interruptByParent', 'prompt'],
  terminal: ['close', 'create', 'environment', 'follow', 'list', 'rename', 'resize', 'retain', 'shells', 'write'],
  userQuestions: ['answer', 'attachWait'],
  workspace: [
    'archiveSession', 'create', 'delete', 'follow', 'initializeDefault', 'insertBefore',
    'insertSessionBefore', 'pinSession', 'rename', 'unarchiveSession', 'unpinSession',
  ],
  workspaceFiles: ['changes', 'list', 'read', 'readBytes', 'stat'],
}

/**
 * Pins kept for releases still inside the window that the installed one no
 * longer has: `copy` and `deletePreset` exist only up to 0.1.6.
 */
const PINNED_FOR_OLDER_RELEASES = new Set(['agentPresets/copy', 'agentPresets/deletePreset'])

/** The package directory `name` resolves to from `from`, by Node's lookup, links followed. */
function packageDir(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) return undefined
  }
}

/** namespace → methods, over every `@deepseek-ai/*` package the installed dsh reaches. */
async function installedSurface(): Promise<Map<string, Set<string>>> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const start = packageDir(root, '@deepseek-ai/dsh')
  if (start === undefined) throw new Error('@deepseek-ai/dsh is not installed; it is a devDependency')
  const visited = new Map<string, string>()
  const queue = [start]
  while (queue.length > 0) {
    const dir = queue.pop() as string
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    if (visited.has(manifest.name)) continue
    visited.set(manifest.name, dir)
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }
    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith('@deepseek-ai/')) continue
      const found = packageDir(dir, dep)
      if (found !== undefined) queue.push(found)
    }
  }
  const surface = new Map<string, Set<string>>()
  for (const dir of visited.values()) {
    const file = join(dir, 'lib', 'typert.host.js')
    if (!existsSync(file)) continue
    const { TYPERT } = await import(pathToFileURL(file).href) as { TYPERT: { invocations: Array<{ namespace: string; method: string }> } }
    for (const { namespace, method } of TYPERT.invocations) {
      const methods = surface.get(namespace) ?? new Set<string>()
      methods.add(method)
      surface.set(namespace, methods)
    }
  }
  return surface
}

describe('the installed Remote surface', () => {
  let surface: Map<string, Set<string>>
  beforeAll(async () => { surface = await installedSurface() }, 60_000)

  it('finds the services it is meant to read, rather than passing over an empty tree', () => {
    // A walk that found nothing would make both checks below vacuous.
    for (const namespace of ['session', 'settings', 'credentials', 'pluginManager', 'userQuestions']) {
      expect([namespace, surface.has(namespace)]).toEqual([namespace, true])
    }
  })

  it('still has every method a pin names, so a renamed one cannot slip its pin', () => {
    const missing = DEFAULT_PRIVILEGED_METHODS
      .filter(endpoint => !PINNED_FOR_OLDER_RELEASES.has(endpoint))
      .filter(endpoint => {
        const [namespace, method] = endpoint.split('/') as [string, string]
        return surface.get(namespace)?.has(method) !== true
      })
    expect(missing).toEqual([])
  })

  it('has exactly the reviewed methods in every namespace a paired device may reach', () => {
    const reachable = Object.fromEntries(
      DEFAULT_PAIRED_NAMESPACES
        .filter(namespace => surface.has(namespace))
        .map(namespace => [namespace, [...(surface.get(namespace) as Set<string>)].sort()]),
    )
    // next folds terminal output, input and resize into the duplex attach
    // stream. It grants the same terminal capability already reviewed here.
    // Accept complete, known surfaces, never a per-method union that could
    // hide an unreviewed mixture or a newly added endpoint.
    const next = { ...REVIEWED, terminal: ['attach', 'close', 'create', 'environment', 'list', 'rename', 'retain', 'shells'] }
    expect([REVIEWED, next]).toContainEqual(reachable)
  })
})

