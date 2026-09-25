/** Admission: peer classification, deferring to upstream's session, and the privileged pin. */
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { admit, isLoopbackAddress, isSessionAuthority } from '../src/admission.ts'
import { isPrivilegedEndpoint } from '../src/webserver.ts'

const SESSION = 'dsh-auth-test=v1.valid'

/** A request whose socket peer the kernel would have filled in. */
function req(headers: Record<string, string>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

/** Upstream's check as a stand-in: exactly one cookie is a session. */
const upstream = {
  requestRejection: (request: IncomingMessage): 401 | undefined => request.headers.cookie === SESSION ? undefined : 401,
}

describe('isLoopbackAddress', () => {
  it('accepts the forms node actually reports', () => {
    for (const a of ['127.0.0.1', '127.8.9.10', '127.255.255.255', '::1', '::ffff:127.0.0.1']) {
      expect([a, isLoopbackAddress(a)]).toEqual([a, true])
    }
  })

  it('fails closed on every other spelling', () => {
    // Each denotes loopback to some resolver and none is a form node reports.
    // Reading any of them as loopback would hand out the session exemption.
    for (const a of [
      undefined, '', '192.168.1.5', '::ffff:192.168.1.5', '0.0.0.0',
      '::FFFF:127.0.0.1', '::ffff:7f00:1', '2130706433', '127.1',
      '0127.0.0.1', '127.0.0.01', '127.000.000.001', '::ffff:127.0.0.1%eth0',
      ' 127.0.0.1', '127.0.0.1 ',
    ]) {
      expect([a, isLoopbackAddress(a)]).toEqual([a, false])
    }
  })
})

describe('isSessionAuthority', () => {
  it('recognises a connection that can check a session', () => {
    expect(isSessionAuthority(upstream)).toBe(true)
  })

  it('does not mistake anything else for one', () => {
    // A connection from before upstream's browser authentication has no such
    // member; neither does whatever a rename leaves behind.
    for (const candidate of [undefined, null, {}, { requestRejection: 'nope' }, { admit: () => ({}) }]) {
      expect([candidate, isSessionAuthority(candidate)]).toEqual([candidate, false])
    }
  })
})

describe('admit', () => {
  it('exempts a genuine loopback peer, whether or not a connection is mounted', () => {
    expect(admit(req({}, '127.0.0.1'), undefined)).toBe(true)
    expect(admit(req({}, '::1'), upstream)).toBe(true)
    // No peer at all is not loopback.
    expect(admit(req({}), undefined)).toBe(false)
  })

  it('admits a network peer upstream vouches for, and refuses one it does not', () => {
    expect(admit(req({ cookie: SESSION }, '192.168.1.5'), upstream)).toBe(true)
    expect(admit(req({}, '192.168.1.5'), upstream)).toBe(false)
    expect(admit(req({ cookie: 'dsh-auth-test=v1.forged' }, '192.168.1.5'), upstream)).toBe(false)
  })

  it('refuses whichever status upstream refuses with', () => {
    // 401 is a missing session, 403 the Host/Origin fence; either is a refusal.
    for (const status of [401, 403] as const) {
      expect([status, admit(req({ cookie: SESSION }, '192.168.1.5'), { requestRejection: () => status })])
        .toEqual([status, false])
    }
  })

  it('refuses every network peer while no connection can vouch for it', () => {
    // Before Connection mounts, after it is disposed, and on a connection that
    // predates browser authentication: fail closed, never open.
    for (const authority of [undefined, {}, { requestRejection: undefined }]) {
      expect(admit(req({ cookie: SESSION }, '192.168.1.5'), authority)).toBe(false)
    }
  })

  it('refuses a non-loopback peer forging a loopback Host', () => {
    // The peer is what the kernel saw; Host is what the client claims. Deriving
    // the exemption from the header would be a complete bypass.
    expect(admit(req({ host: '127.0.0.1:3080' }, '192.168.1.5'), upstream)).toBe(false)
    expect(admit(req({ host: 'localhost:3080' }, '192.168.1.5'), upstream)).toBe(false)
  })

  it('asks upstream as a method call, so a connection reading its own state still works', () => {
    // HostConnectionService reads its trusted hosts and signing secret off
    // `this`; a detached call would throw instead of deciding.
    class Connection {
      readonly #session = SESSION
      requestRejection(request: IncomingMessage): 401 | undefined {
        return request.headers.cookie === this.#session ? undefined : 401
      }
    }
    expect(admit(req({ cookie: SESSION }, '192.168.1.5'), new Connection())).toBe(true)
  })
})

describe('isPrivilegedEndpoint', () => {
  it('pins every namespace of the configuration plane', () => {
    for (const m of [
      'settings/describe', 'settings/update', 'credentials/describe', 'credentials/set',
      'account/startSignIn', 'account/signOut', 'llm/discoverModels', 'llm/listProviders',
      'pluginManager/installBundle', 'pluginRegistryProbe/fastest', 'pluginInventory/list',
    ]) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, true])
    }
  })

  it('pins what acts on this machine\'s desktop or reads an agent preset, inside namespaces a device may use', () => {
    for (const m of [
      'session/openWorkspacePath', 'directoryPicker/pick',
      'agentPresets/read', 'agentPresets/copy', 'agentPresets/deletePreset',
    ]) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, true])
    }
  })

  it('leaves everything the GUI needs to hold a session reachable for a paired device', () => {
    for (const m of [
      'session/list', 'session/create', 'session/prompt', 'session/follow', 'session/modelCatalog',
      'session/uploadFileBinary', 'workspace/create', 'workspace/follow', 'workspaceFiles/read',
      'directoryPicker/list', 'agentPresets/list', 'agentPresets/select', 'permissionPresets/catalog',
      'commands/execute', 'goals/create', 'messageFeedback/put', 'sessionFeedback/record',
      'job/kill', 'terminal/create', 'subagents/prompt', 'fileUploads/upload', 'skills/list',
    ]) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, false])
    }
  })

  it('lets a paired device answer what the host asks it', () => {
    // Tool approvals and the agent's questions arrive over `$events` and are
    // answered here; pinning it strands the agent on a prompt the phone sees.
    expect(isPrivilegedEndpoint('$events/result')).toBe(false)
  })

  it('pins every method of an unlisted Gateway namespace, including ones no list names', () => {
    // The Gateway claims any namespace/method a live remote service exposes, so
    // a per-method list would default each new endpoint to LAN-reachable.
    for (const m of [
      'dynamicCordisRunner/inventory', 'dynamicCordisRunner/invoke',
      'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/aMethodAddedLater',
      'speech/transcribe', 'somethingUnclassified/read',
    ]) {
      expect([m, isPrivilegedEndpoint(m)]).toEqual([m, true])
    }
  })

  it('reads an endpoint with no namespace as no Gateway method at all', () => {
    // Upstream's stream WebSocket lives at /api/remote.mux.
    expect(isPrivilegedEndpoint('remote.mux')).toBe(false)
  })
})
