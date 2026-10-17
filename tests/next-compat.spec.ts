/** Compatibility contracts that do not need a live listener. */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { resolveStartupValues, webCommand } from '../src/startup.ts'
import { GatedWebServer } from '../src/webserver.ts'
import * as Pairing from '../src/pairing.ts'
import { installedWebCarrier, networkBindHost, plainProbe, readinessLines } from '../scripts/dsh-harness.ts'

function parse(args: string[]) {
  const command = webCommand().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  command.parse(args, { from: 'user' })
  return resolveStartupValues(command)
}

describe('the next web contract', () => {
  it('waits for the actual local URL after next runtime diagnostics', () => {
    const output = 'dsh web: listening on 192.168.1.20 over plain HTTP; restrict this port to a trusted proxy or network\n'
      + 'lanyard: pair a device by opening https://192.168.1.20:3443/?token=test once\n'
      + 'lanyard: the phone should show certificate SHA-256 AA:BB before you accept\n'
    expect(readinessLines(output)).toBeUndefined()
    expect(readinessLines(`${output}dsh web: http://127.0.0.1:3080/?token=loc`)).toBeUndefined()
    expect(readinessLines(`${output}dsh web: http://127.0.0.1:3080/?token=local\n`)).toEqual({
      pairingLink: 'https://192.168.1.20:3443/?token=test', fingerprint: 'AA:BB', localUrl: 'http://127.0.0.1:3080/?token=local',
    })
    // Stable appends a LAN annotation; next prints the local URL alone.
    const stable = `${output}dsh web: http://127.0.0.1:3080/?token=local (LAN: http://192.168.1.20:3080/?token=local)`
    expect(readinessLines(stable)).toBeUndefined()
    expect(readinessLines(`${stable}\r\n`)?.localUrl).toBe('http://127.0.0.1:3080/?token=local')
  })

  it('carries TLS files and the advertised URL without granting that URL trust', () => {
    expect(parse(['--tls-cert', 'server.pem', '--tls-key', 'key.pem', '--public-url', 'https://example.test/ui/']))
      .toMatchObject({ tls: { certFile: 'server.pem', keyFile: 'key.pem' }, publicUrl: 'https://example.test/ui/', trustedHosts: [] })
  })

  it.each([['--tls-cert', 'server.pem'], ['--tls-key', 'key.pem']])('rejects incomplete TLS material: %s', (...args) => {
    expect(() => parse(args)).toThrow(/--tls-cert and --tls-key must be supplied together/)
  })

  it.each(['https://user@example.test/', 'https://example.test/?token=x', 'https://example.test/#x', 'https://example.test/ bad', 'file:///tmp/index.html'])('rejects unsafe advertised roots: %s', url => {
    expect(() => parse(['--public-url', url])).toThrow(/--public-url/)
  })

  it('requires TLS for every non-loopback concrete bind, even when composed directly', () => {
    const ctx = new Context()
    expect(() => new GatedWebServer(ctx, { host: '192.168.1.20', port: 0 } as never)).toThrow(/network bind requires TLS material/)
  })

  it.each(['2001:db8::1', 'fe80::1234%eth0'])('fails closed on an unsupported IPv6 bind: %s', host => {
    const ctx = new Context()
    expect(() => new GatedWebServer(ctx, { host, port: 0, tls: { certFile: 'server.pem', keyFile: 'key.pem' } } as never))
      .toThrow(/IPv6 binds are not supported/)
    expect(Pairing.pairingLink({ authenticatedUrl: () => { throw new Error('must not issue a token') } }, 'https', 3443, host)).toBeUndefined()
  })

  it('does not relax the inherited wildcard policy', () => {
    for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0']) {
      let accepted = false
      try { WebServer.Config({ host, port: 0 } as never); accepted = true } catch { /* upstream rejects */ }
      if (!accepted) expect(() => GatedWebServer.Config({ host, port: 0 } as never)).toThrow()
    }
  })

  it('selects only a bind address the installed carrier validates', () => {
    const host = networkBindHost('192.168.1.20')
    expect(() => WebServer.Config({ host, port: 0 })).not.toThrow()
    let concreteAccepted = false
    try { WebServer.Config({ host: '192.168.1.20', port: 0 } as never); concreteAccepted = true } catch { /* legacy carrier */ }
    expect(host).toBe(concreteAccepted ? '192.168.1.20' : '0.0.0.0')
  })

  it('resolves the deployed carrier through the CLI, without a web app in the plugin profile', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lanyard-carrier-'))
    const cli = join(workspace, 'node_modules/@deepseek-ai/dsh')
    const app = join(cli, 'node_modules/@deepseek-ai/dsh-web-app')
    const carrier = join(app, 'node_modules/@deepseek-ai/dsh-host-webserver')
    try {
      for (const directory of [workspace, cli, app, carrier, join(workspace, 'home/profiles/web')]) {
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, 'package.json'), '{}')
      }
      writeFileSync(join(carrier, 'index.js'), 'module.exports = {}')
      expect(installedWebCarrier(workspace)).toBe(join(carrier, 'index.js'))
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('keeps the inherited listener plaintext when explicit TLS files are supplied', () => {
    const ctx = new Context()
    const server = new GatedWebServer(ctx, { host: '127.0.0.1', port: 0, tls: { certFile: 'server.pem', keyFile: 'key.pem' } })
    // protocol is public on next and absent on the older HTTP-only carrier.
    expect((server as unknown as { protocol?: string }).protocol ?? 'http:').toBe('http:')
  })

  it('probes the separate plaintext loopback listener with the actual RPC response body', async () => {
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        res.setHeader('x-method', req.method ?? '')
        res.end(`${req.headers.cookie ?? ''}:${body}`)
      })
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      const answer = await plainProbe(`http://127.0.0.1:${String(port)}/api/settings/describe`, {
        method: 'POST', headers: { cookie: 'local=session' }, body: 'request',
      })
      expect(answer).toMatchObject({ status: 200, headers: { 'x-method': 'POST' }, body: 'local=session:request' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('does not wait forever for the webRuntime service removed by next', () => {
    expect(Pairing.inject).toEqual(['webServer', 'connection'])
  })

  it('validates explicit TLS files and rejects ambiguous sources', () => {
    expect(() => GatedWebServer.Config({ host: '127.0.0.1', port: 0 })).not.toThrow()
    expect(() => GatedWebServer.Config({ host: '127.0.0.1', port: 0, tls: { certFile: 'server.pem' } } as never)).toThrow()
    const ctx = new Context()
    expect(() => new GatedWebServer(ctx, {
      host: '127.0.0.1', port: 0, tls: { certFile: 'server.pem', keyFile: 'key.pem' }, tlsCertPath: 'other.pem',
    })).toThrow(/configure tls or tlsCertPath\/tlsKeyPath, not both/)
  })

  it.each([undefined, { lanAddresses: ['10.0.0.2', '192.168.1.99'] }])('advertises only its concrete TLS interface with absent or stale webRuntime: %j', async runtime => {
    const ctx = new Context()
    ctx.provide('connection', { authenticatedUrl: (url: string) => `${url}?token=test` })
    ctx.provide('webServer', { host: '192.168.1.20', scheme: 'https', port: 3080, networkPort: 3443 })
    if (runtime !== undefined) ctx.provide('webRuntime', runtime)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const interfaces = vi.spyOn(Pairing.internals, 'networkInterfaces').mockReturnValue({})
    try {
      await ctx.plugin(Pairing, { printPairingUrl: true, printPairingQr: false }).await()
      expect(log.mock.calls.flat().filter(line => String(line).includes('?token=')))
        .toEqual(['lanyard: pair a device by opening https://192.168.1.20:3443/?token=test once'])
    } finally {
      await ctx.fiber.dispose()
      log.mockRestore()
      interfaces.mockRestore()
    }
  })
})
