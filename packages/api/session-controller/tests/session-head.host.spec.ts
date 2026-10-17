/** Resident-only head reads and stable-cut checks over the real Session store. */
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { provideBrowserCredentials } from '../../gateway/tests/browser-credentials.ts'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import { createSessionTestController, installSessionReadTestServices } from './test-remote.ts'

/** Exercise the real Connection authentication and unary Gateway using a local descriptor. */
async function checkHeadWire(): Promise<void> {
  const ctx = new Context()
  try {
    provideBrowserCredentials(ctx)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    createSessionTestController(ctx, {
      cwd: '/workspace', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
    })
    ctx.typert.register({
      package: '@fixture/session-head', face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [{
        id: '@fixture/session-head#session/head', service: 'sessionController', namespace: 'session', method: 'head',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }],
        result: { mode: 'src-json' },
      }],
    })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const body = JSON.stringify({ type: 'client-request', rpcId: 'local-head', method: 'session/head',
      payload: { args: { request: { address: { kind: 'session', sessionId: session.id } } } } })
    const denied = await fetch(`${origin}/api/session/head`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(denied.status).toBe(401)
    const target = new URL(ctx.connection.authenticatedUrl(origin))
    let cookie: string | undefined
    ctx.connection.authorizeIndex({ method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } }, {
      writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] }, end() {},
    })
    if (cookie === undefined) throw new Error('local authentication cookie unavailable')
    const accepted = await fetch(`${origin}/api/session/head`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body,
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ type: 'server-response', rpcId: 'local-head', result: {
      ok: true, value: { resident: true, throughSeq: -1, header: { id: session.id } },
    } })
    expect(session.seq).toBe(0)
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('resident Session head', () => {
  it('returns unavailable without reading storage or promoting cold Sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const promote = vi.fn()
    const storageRead = vi.fn(() => { throw new Error('unexpected storage access') })
    ctx.provide('sessionPersistence', { stat: storageRead, open: storageRead, list: storageRead } as never)
    const history = new SessionHistoryController(ctx, promote)
    try {
      expect(history.head({ address: { kind: 'session', sessionId: 'cold' as SessionId } })).toEqual({ resident: false })
      expect(ctx.sessions.get('cold' as SessionId)).toBeUndefined()
      const hidden = ctx.sessions.create('hidden' as SessionId)
      expect(() => history.head({ address: { kind: 'session', sessionId: hidden.id } })).toThrow('not found')
      const child = ctx.sessions.create('child' as SessionId, { meta: { cwd: '/child', origin: 'subagent', parentSession: 'parent' as SessionId } })
      expect(() => history.head({ address: { kind: 'session', sessionId: child.id } })).toThrow('subagent Sessions require their durable parent address')
      expect(storageRead).not.toHaveBeenCalled()
      expect(promote).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
    await checkHeadWire()
  })

  it('observes appended terminal events without a cached projection or a log write', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/private-path' } })
    const history = new SessionHistoryController(ctx, vi.fn())
    try {
      const empty = history.head({ address: { kind: 'session', sessionId: session.id } })
      expect(empty).toMatchObject({ resident: true, throughSeq: -1 })
      session.append('turn/start', { turn: 1 })
      const before = history.head({ address: { kind: 'session', sessionId: session.id } })
      const page = await history.page({ address: { kind: 'session', sessionId: session.id }, throughSeq: 0 }, new AbortController().signal)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const after = history.head({ address: { kind: 'session', sessionId: session.id } })
      expect(page.records.map(record => record.event.type)).toEqual(['turn/start'])
      expect(before).toMatchObject({ resident: true, throughSeq: 0 })
      expect(after).toMatchObject({ ...before, throughSeq: 1 })
      expect(after).not.toEqual(before)
      expect(history.head({ address: { kind: 'session', sessionId: session.id } })).toEqual(after)
      expect(session.seq).toBe(2)
      expect(JSON.stringify(after)).not.toContain('/private-path')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('changes resident identity when an identical durable header is reattached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const first = ctx.sessions.prepare('same' as SessionId, { meta: { cwd: '/workspace' } })
    const detach = ctx.sessions.enter(first)
    const history = new SessionHistoryController(ctx, vi.fn())
    try {
      const before = history.head({ address: { kind: 'session', sessionId: first.id } })
      detach()
      expect(history.head({ address: { kind: 'session', sessionId: first.id } })).toEqual({ resident: false })
      const second = Session.create(first.id, undefined, first.header)
      const detachSecond = ctx.sessions.enter(second)
      try {
        const after = history.head({ address: { kind: 'session', sessionId: first.id } })
        if (!before.resident || !after.resident) throw new Error('expected resident head')
        expect(after.header).toEqual(before.header)
        expect(after.throughSeq).toEqual(before.throughSeq)
        expect(after.residentId).not.toEqual(before.residentId)
      } finally {
        detachSecond()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
