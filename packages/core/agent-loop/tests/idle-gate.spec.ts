import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Config } from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * Mount the real loop; `beforeLoop` runs after every dependency and before the
 * loop registers its factory, and each context releases its temporary storage
 * at test teardown.
 * @param options - persistence, config agents, and a pre-loop hook.
 * @returns the mounted context.
 */
async function harness(options: {
  persistent?: boolean
  agents?: Config['agents']
  beforeLoop?: (ctx: Context) => void
} = {}): Promise<Context> {
  const ctx = new Context()
  let root: string | undefined
  if (options.persistent === true) root = await mkdtemp(join(tmpdir(), 'dsh-idle-gate-'))
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  options.beforeLoop?.(ctx)
  await ctx.plugin(AgentLoop, { agents: options.agents ?? [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok'), textResponse('done')]))
  onTestFinished(async () => {
    // Teardown failures are asserted by their test; cleanup always releases
    // the temporary root without masking the primary failure.
    await ctx.fiber.dispose().catch(() => undefined)
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  return ctx
}

/** One ordinary user message. */
function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('native loop idle proof', () => {
  it('proves quiescence across config startup, live agents, cold resume, clean cleanup, and shutdown', async () => {
    const invoked: string[] = []
    const configId = SessionId('idle-gate-config')
    const startupRelease = Promise.withResolvers<undefined>()
    let duringPublish: boolean | undefined
    const startupCtx = await harness({
      persistent: true,
      agents: [{ id: 'config', sessionId: configId, provider: 'mock', model: 'mock' }],
      beforeLoop: (ctx) => {
        ctx.on('agent/created', () => {
          // A reentrant synchronous proof during publication must refuse.
          duringPublish = ctx.agents.tryRunWhenIdle(() => { invoked.push('during-publish') })
        })
        const persistence = ctx.sessionPersistence
        const realCreate = persistence.create.bind(persistence)
        vi.spyOn(persistence, 'create').mockImplementation(async (header, createOptions) => {
          await startupRelease.promise
          return realCreate(header, createOptions)
        })
      },
    })
    const startupRegistry = startupCtx.agents
    // Config startup that has begun and not settled is owned work.
    expect(startupCtx.agentLoop.isQuiescent()).toBe(false)
    expect(startupRegistry.tryRunWhenIdle(() => { invoked.push('config-startup') })).toBe(false)
    startupRelease.resolve(undefined)
    await vi.waitFor(() => {
      if (startupRegistry.get(configId) === undefined) throw new Error('configured agent did not publish')
    })
    expect(duringPublish).toBe(false)
    expect(startupCtx.agentLoop.isQuiescent()).toBe(false)
    await startupCtx.fiber.dispose()
    expect(startupRegistry.tryRunWhenIdle(() => { invoked.push('config-shutdown') })).toBe(false)

    // An empty loop proves quiescence; a live Agent withholds it until complete
    // disposal, and a cold resume withholds it again.
    const ctx = await harness({ persistent: true })
    const registry = ctx.agents
    expect(ctx.agentLoop.isQuiescent()).toBe(true)
    expect(registry.tryRunWhenIdle(() => { invoked.push('idle') })).toBe(true)
    const sessionId = SessionId('idle-gate-resume')
    const handle = await registry.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentLoop.isQuiescent()).toBe(false)
    expect(registry.tryRunWhenIdle(() => { invoked.push('live') })).toBe(false)
    handle.agent.followup(message('persist me'))
    await handle.agent.whenIdle()
    await handle.dispose()
    expect(ctx.agentLoop.isQuiescent()).toBe(true)
    const resumed = await registry.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentLoop.isQuiescent()).toBe(false)
    await resumed.dispose()
    expect(ctx.agentLoop.isQuiescent()).toBe(true)

    // A failed setup whose rollback cleanup succeeds does not poison the proof.
    await expect(registry.create({
      sessionId: SessionId('idle-gate-setup-failed'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: () => { throw new Error('setup failed') },
    })).rejects.toThrow('setup failed')
    await vi.waitFor(() => {
      if (!ctx.agentLoop.isQuiescent()) throw new Error('successful rollback left the factory busy')
    })
    expect(registry.tryRunWhenIdle(() => { invoked.push('after-failed-setup') })).toBe(true)
    expect(invoked).toEqual(['idle', 'after-failed-setup'])

    await ctx.fiber.dispose()
    expect(registry.tryRunWhenIdle(() => { invoked.push('shutdown') })).toBe(false)
    expect(invoked).toEqual(['idle', 'after-failed-setup'])
  })

  it('refuses quiescence after rollback, teardown, or abandoned close cleanup fails', async () => {
    const invoked: string[] = []

    const rollbackCtx = await harness({ persistent: true })
    const rollbackRegistry = rollbackCtx.agents
    const rollback = rollbackRegistry.create({
      sessionId: SessionId('idle-gate-rollback'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (_agentCtx, agent) => {
        ;(agent as ReactLoopAgent).scope.dispose = async () => { throw new Error('rollback cleanup failed') }
        throw new Error('setup failed')
      },
    })
    await expect(rollback).rejects.toThrow('setup failed')
    await vi.waitFor(() => {
      if (rollbackCtx.agentLoop.isQuiescent()) throw new Error('rollback cleanup failure did not latch')
    })
    expect(rollbackRegistry.tryRunWhenIdle(() => { invoked.push('rollback') })).toBe(false)
    expect(rollbackRegistry.list()).toEqual([])

    const teardownCtx = await harness({ persistent: true })
    const teardownHandle = await teardownCtx.agents.create({
      sessionId: SessionId('idle-gate-teardown'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    ;(teardownHandle.agent as ReactLoopAgent).scope.dispose = async () => {
      throw new Error('teardown cleanup failed')
    }
    await expect(teardownHandle.dispose()).rejects.toThrow('teardown cleanup failed')
    expect(teardownCtx.agents.get(teardownHandle.agent.id)).toBeUndefined()
    await vi.waitFor(() => {
      if (teardownCtx.agentLoop.isQuiescent()) throw new Error('teardown cleanup failure did not latch')
    })
    expect(teardownCtx.agents.tryRunWhenIdle(() => { invoked.push('teardown') })).toBe(false)

    // Abandoned handle close: the caller returned while creation was still
    // pending, so the close must stay tracked and a rejection must latch.
    const abandonedCtx = await harness({ persistent: true })
    const abandonedRegistry = abandonedCtx.agents
    const persistence = abandonedCtx.sessionPersistence
    const realCreate = persistence.create.bind(persistence)
    const release = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    vi.spyOn(persistence, 'create').mockImplementation(async (header) => {
      await release.promise
      const handle = await realCreate(header)
      return {
        id: handle.id,
        header: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        access: handle.access,
        read: (offset, length, options) => handle.read(offset, length, options),
        append: (events, options) => handle.append(events, options),
        flush: options => handle.flush(options),
        close: async () => {
          await handle.close()
          closed.resolve(undefined)
          throw new Error('abandoned close failed')
        },
        [Symbol.asyncDispose]: async () => { await handle.close() },
      } satisfies SessionHandle
    })
    const abort = new AbortController()
    const creating = abandonedRegistry.create({
      sessionId: SessionId('idle-gate-abandoned'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: abort.signal,
    })
    abort.abort(new Error('create cancelled'))
    await expect(creating).rejects.toThrow('create cancelled')
    // The abandoned close is still a factory continuation, so the gate stays closed.
    expect(abandonedCtx.agentLoop.isQuiescent()).toBe(false)
    release.resolve(undefined)
    await closed.promise
    // Once the tracked close has settled and left the ledger, only the latch
    // can still refuse quiescence.
    await vi.waitFor(() => {
      if (abandonedCtx.agentLoop.isQuiescent()) throw new Error('abandoned close failure did not latch')
    })
    expect(abandonedRegistry.tryRunWhenIdle(() => { invoked.push('abandoned') })).toBe(false)
    expect(invoked).toEqual([])
  })

  it('holds idle refusal through asynchronous cleanup and latches only a failed cleanup', async () => {
    const invoked: string[] = []

    const successCtx = await harness({ persistent: true })
    const successRegistry = successCtx.agents
    const successHandle = await successRegistry.create({
      sessionId: SessionId('idle-gate-async-success'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const successAgent = successHandle.agent as ReactLoopAgent
    const disposeSuccessScope = successAgent.scope.dispose.bind(successAgent.scope)
    const releaseSuccess = Promise.withResolvers<undefined>()
    successAgent.scope.dispose = async () => {
      await releaseSuccess.promise
      await disposeSuccessScope()
    }
    const disposingSuccess = successHandle.dispose()
    // The full cleanup, including follow effects, keeps the proof closed.
    expect(successCtx.agentLoop.isQuiescent()).toBe(false)
    expect(successRegistry.tryRunWhenIdle(() => { invoked.push('success-hold') })).toBe(false)
    releaseSuccess.resolve(undefined)
    await disposingSuccess
    expect(successCtx.agentLoop.isQuiescent()).toBe(true)
    expect(successRegistry.tryRunWhenIdle(() => { invoked.push('success') })).toBe(true)
    await successCtx.fiber.dispose()

    const failureCtx = await harness({ persistent: true })
    const failureRegistry = failureCtx.agents
    const failureHandle = await failureRegistry.create({
      sessionId: SessionId('idle-gate-async-failure'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const failureAgent = failureHandle.agent as ReactLoopAgent
    const releaseFailure = Promise.withResolvers<undefined>()
    failureAgent.scope.dispose = async () => {
      await releaseFailure.promise
      throw new Error('asynchronous cleanup failed')
    }
    const disposingFailure = failureHandle.dispose()
    expect(failureCtx.agentLoop.isQuiescent()).toBe(false)
    expect(failureRegistry.tryRunWhenIdle(() => { invoked.push('failure-hold') })).toBe(false)
    releaseFailure.resolve(undefined)
    await expect(disposingFailure).rejects.toThrow('asynchronous cleanup failed')
    expect(failureCtx.agentLoop.isQuiescent()).toBe(false)
    expect(failureRegistry.tryRunWhenIdle(() => { invoked.push('failure') })).toBe(false)
    await failureCtx.fiber.dispose().catch(() => undefined)

    expect(invoked).toEqual(['success'])
  })

  it('withholds idle while a direct loop create waits on its persistence handle', async () => {
    const invoked: string[] = []
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let idleInsidePersistence: boolean | undefined
    const ctx = await harness({
      persistent: true,
      beforeLoop: (ctx) => {
        const persistence = ctx.sessionPersistence
        const realCreate = persistence.create.bind(persistence)
        vi.spyOn(persistence, 'create').mockImplementation(async (header, createOptions) => {
          idleInsidePersistence = ctx.agents.tryRunWhenIdle(() => { invoked.push('inside-persistence') })
          entered.resolve(undefined)
          await release.promise
          return realCreate(header, createOptions)
        })
      },
    })
    const creating = ctx.agentLoop.create(SessionId('idle-gate-direct-create'), { provider: 'mock', model: 'mock' })
    try {
      await entered.promise
      expect(idleInsidePersistence).toBe(false)
      expect(ctx.agents.tryRunWhenIdle(() => { invoked.push('while-awaiting') })).toBe(false)
      expect(invoked).toEqual([])
    } finally {
      release.resolve(undefined)
      try {
        await creating
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('closes the factory without waiting for stalled direct acquisition', async () => {
    let closed = false
    let rejection: unknown
    const release = Promise.withResolvers<undefined>()
    const ctx = await harness({
      persistent: true,
      beforeLoop: (ctx) => {
        const persistence = ctx.sessionPersistence
        const realCreate = persistence.create.bind(persistence)
        vi.spyOn(persistence, 'create').mockImplementation(async (header, createOptions) => {
          await release.promise
          return realCreate(header, createOptions)
        })
      },
    })
    const registry = ctx.agents
    const creation = ctx.agentLoop.create(SessionId('idle-gate-stalled-direct'), { provider: 'mock', model: 'mock' })
    creation.catch((error: unknown) => { rejection = error })
    const closing = ctx.fiber.dispose().then(() => { closed = true })
    try {
      // Before the fix disposal waited for the stalled acquisition, so the
      // factory never closed while the persistence backend was held.
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 })
      await expect(creation).rejects.toThrow(/not active/)
      expect(rejection).toBeInstanceOf(Error)
      expect(registry.get(SessionId('idle-gate-stalled-direct'))).toBeUndefined()
    } finally {
      // Release the backend and settle both sides so the pre-fix failure does
      // not leave the test hanging.
      release.resolve(undefined)
      await creation.catch(() => undefined)
      await closing
    }
  })
})
