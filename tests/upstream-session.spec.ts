/**
 * The contract this plugin takes on by deferring authentication to upstream.
 *
 * The gate has exactly one credential check — `ctx.connection.requestRejection`
 * — and the pairing line exactly one source of a link —
 * `ctx.connection.authenticatedUrl`. Both belong to
 * `@deepseek-ai/dsh-client-connection`, so both are exercised here against the
 * INSTALLED package, driven the way a phone drives them: from this machine's
 * LAN address, over real TLS, through the launch-token exchange and the cookie
 * it mints. A stand-in cannot fail when upstream changes what these mean; this
 * can.
 */
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as ClientConnection from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { generate } from 'selfsigned'
import { isSessionAuthority } from '../src/admission.ts'
import { isLaunchLinkIssuer, pairingLink } from '../src/pairing.ts'
import { GatedWebServer, REFUSAL_BODY } from '../src/webserver.ts'
import { lanIpv4Addresses } from '../src/tls.ts'

const LAN = lanIpv4Addresses()[0]
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

/** One answer from the composition. */
interface Answer { status: number; headers: IncomingHttpHeaders; body: string }

/** A credential store holding records in memory — all Connection needs for its signing secret. */
function memoryCredentials(): unknown {
  const records = new Map<string, unknown>()
  return {
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const id = JSON.stringify(key)
      const next = await mutate(records.get(id))
      if (next !== undefined) records.set(id, next)
      return records.get(id)
    },
  }
}

/** A self-signed pair naming this machine's addresses, as the tls row would write it. */
function certificateFiles(): { certPath: string; keyPath: string; ca: string } {
  const pems = generate([{ name: 'commonName', value: 'dsh' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{
      name: 'subjectAltName',
      altNames: [{ type: 7, ip: '127.0.0.1' }, ...lanIpv4Addresses().map(ip => ({ type: 7 as const, ip }))],
    }],
  })
  const dir = mkdtempSync(join(tmpdir(), 'lanyard-'))
  writeFileSync(join(dir, 'cert.pem'), pems.cert)
  writeFileSync(join(dir, 'key.pem'), pems.private)
  return { certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem'), ca: pems.cert }
}

/** The body the shipped client posts for one Gateway call. */
function envelope(method: string): string {
  return JSON.stringify({ type: 'client-request', rpcId: 'contract-1', method, payload: { args: {} } })
}

describe.skipIf(LAN === undefined)('lanyard over the installed dsh-client-connection', () => {
  /** The composition a phone meets: the gated carrier, upstream's connection, and an index owner. */
  async function compose(): Promise<{
    connection: HostConnectionHandle
    call: (host: string, method: string, path: string, headers?: Record<string, string>, body?: string) => Promise<Answer>
    port: number
  }> {
    const lan = LAN as string
    const { certPath, keyPath, ca } = certificateFiles()
    ctx = new Context()
    ctx.provide('credentials', memoryCredentials())
    await ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0, tlsCertPath: certPath, tlsKeyPath: keyPath }).await()
    // Exactly the trust dsh-web-app derives from an all-interfaces bind.
    await ctx.plugin(ClientConnection, { trustedHosts: [lan] }).await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const server = ctx.get('webServer') as GatedWebServer
    // What dsh-host-frontend-static does on the fallback seat.
    server.registerFallback((request, res) => {
      if (!connection.authorizeIndex(request, res)) return
      res.writeHead(200)
      res.end('INDEX')
    })
    // A Gateway-shaped interceptor, so /api answers the way the shipped composition does.
    connection.rpc.intercept('/api', () => true, endpoint => Promise.resolve({ ok: true, value: endpoint }))
    const port = server.networkPort
    const call = (host: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> =>
      new Promise((resolve, reject) => {
        const rq = httpsRequest({ host, port, path, method, headers, ca }, (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => { text += chunk })
          res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }) })
        })
        rq.on('error', reject)
        rq.end(body)
      })
    return { connection, call, port }
  }

  /** Open a pairing link the way a phone does, returning the cookie the exchange set. */
  async function pair(call: Awaited<ReturnType<typeof compose>>['call'], host: string, link: string): Promise<{ answer: Answer; cookie: string }> {
    const target = new URL(link)
    const answer = await call(host, 'GET', `${target.pathname}${target.search}`)
    const cookie = (answer.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? ''
    return { answer, cookie }
  }

  const rpc = { 'content-type': 'application/json' }

  it('offers exactly the two members the gate and the pairing line rely on', async () => {
    const { connection } = await compose()
    expect(isSessionAuthority(connection)).toBe(true)
    expect(isLaunchLinkIssuer(connection)).toBe(true)
  })

  it('issues a pairing link at the address and port a device reaches, carrying the launch token', async () => {
    const { connection, port } = await compose()
    const link = pairingLink(connection, 'https', port, LAN)
    expect(link).toMatch(new RegExp(`^https://${(LAN as string).replaceAll('.', '\\.')}:${String(port)}/\\?token=[A-Za-z0-9_-]{43}$`))
  })

  it('refuses an anonymous LAN peer at the gate, before upstream sees it', async () => {
    const { call } = await compose()
    const answer = await call(LAN as string, 'POST', '/api/session/list', rpc, envelope('session/list'))
    expect([answer.status, answer.body]).toEqual([403, REFUSAL_BODY])
  })

  it('lets the index through to upstream, which refuses it without a session', async () => {
    // The fallback seat is public so the exchange can arrive there at all; the
    // index behind it is upstream's to authenticate, and it does.
    const { call } = await compose()
    const answer = await call(LAN as string, 'GET', '/')
    expect(answer.status).toBe(401)
    expect(answer.body).not.toBe(REFUSAL_BODY)
  })

  it('exchanges the launch token for a host-bound session cookie, then serves the device', async () => {
    const { connection, call, port } = await compose()
    const lan = LAN as string
    const link = pairingLink(connection, 'https', port, lan) as string
    const { answer, cookie } = await pair(call, lan, link)
    expect(answer.status).toBe(303)
    // The redirect strips the token from the address bar, back to the bare origin.
    expect(new URL(String(answer.headers.location), link).href).toBe(`https://${lan}:${String(port)}/`)
    expect(answer.headers['set-cookie']?.[0]).toMatch(/HttpOnly/)
    expect(answer.headers['set-cookie']?.[0]).toMatch(/SameSite=Strict/)
    expect(cookie).toMatch(/^dsh-auth-[A-Za-z0-9_-]+=v1\./)

    expect(await call(lan, 'GET', '/', { cookie })).toMatchObject({ status: 200, body: 'INDEX' })
    const listed = await call(lan, 'POST', '/api/session/list', { ...rpc, cookie }, envelope('session/list'))
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({ type: 'server-response', result: { ok: true, value: 'session/list' } })
  })

  it('keeps the configuration plane at the machine, even for a device holding a session', async () => {
    const { connection, call, port } = await compose()
    const lan = LAN as string
    const { cookie } = await pair(call, lan, pairingLink(connection, 'https', port, lan) as string)
    const answer = await call(lan, 'POST', '/api/settings/update', { ...rpc, cookie }, envelope('settings/update'))
    expect([answer.status, answer.body]).toEqual([403, REFUSAL_BODY])
  })

  it('refuses a cookie whose signature was not minted by this deployment', async () => {
    const { connection, call, port } = await compose()
    const lan = LAN as string
    const { cookie } = await pair(call, lan, pairingLink(connection, 'https', port, lan) as string)
    const forged = cookie.replace(/.$/, last => (last === 'A' ? 'B' : 'A'))
    const answer = await call(lan, 'POST', '/api/session/list', { ...rpc, cookie: forged }, envelope('session/list'))
    expect([answer.status, answer.body]).toEqual([403, REFUSAL_BODY])
  })

  it('refuses a session minted for another address, which is what "host-bound" buys', async () => {
    // Paired over loopback, presented from the LAN: a different authority, so a
    // different cookie as far as upstream is concerned.
    const { connection, call, port } = await compose()
    const { cookie } = await pair(call, '127.0.0.1', connection.authenticatedUrl(`https://127.0.0.1:${String(port)}/`))
    expect(cookie).not.toBe('')
    const answer = await call(LAN as string, 'POST', '/api/session/list', { ...rpc, cookie }, envelope('session/list'))
    expect([answer.status, answer.body]).toEqual([403, REFUSAL_BODY])
  })
})
