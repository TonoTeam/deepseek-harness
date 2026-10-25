import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle } from '@deepseek-ai/dsh-agent'

/** Minimal live Agent value; the gate only reads registry state. */
function stubAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function stubHandle(rawId: string): AgentHandle {
  return { agent: stubAgent(rawId), dispose: () => Promise.resolve() }
}

describe('AgentRegistry.tryRunWhenIdle', () => {
  it('admits one synchronous callback only while every process-local lifecycle proof holds', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const registry = ctx.agents
    const invoked: string[] = []
    let quiescent = true
    let proofError: Error | undefined
    let runCount = 0
    const createGate = Promise.withResolvers<AgentHandle>()
    const resumeGate = Promise.withResolvers<AgentHandle>()
    const factory: AgentFactory = {
      createAgent: () => createGate.promise,
      resume: () => resumeGate.promise,
      isQuiescent: () => {
        if (proofError !== undefined) throw proofError
        return quiescent
      },
    }

    // A missing factory and a custom factory without the proof both refuse
    // without invoking the callback.
    expect(registry.tryRunWhenIdle(() => { invoked.push('no-factory') })).toBe(false)
    const unsupported = new Context()
    await unsupported.plugin(AgentRegistry)
    unsupported.agents.setFactory({
      createAgent: async () => stubHandle('unsupported'),
      resume: async () => stubHandle('unsupported'),
    })
    expect(unsupported.agents.tryRunWhenIdle(() => { invoked.push('unsupported') })).toBe(false)
    await unsupported.fiber.dispose()
    expect(invoked).toEqual([])

    ctx.agents.setFactory(factory)
    // The callback runs in this stack: no await follows the proof.
    expect(registry.tryRunWhenIdle(() => {
      runCount += 1
      invoked.push('idle')
    })).toBe(true)
    expect(invoked).toEqual(['idle'])
    expect(runCount).toBe(1)

    // A false proof refuses without invoking; a throwing proof propagates
    // without invoking.
    quiescent = false
    expect(registry.tryRunWhenIdle(() => { invoked.push('busy') })).toBe(false)
    quiescent = true
    proofError = new Error('proof failed')
    expect(() => registry.tryRunWhenIdle(() => { invoked.push('proof-error') })).toThrow('proof failed')
    proofError = undefined
    expect(() => registry.tryRunWhenIdle(() => { throw new Error('callback failed') })).toThrow('callback failed')
    expect(invoked).toEqual(['idle'])

    // A create or resume that has started and not settled keeps the gate
    // closed, then reopens it after settlement.
    const creating = registry.create({ sessionId: SessionId('pending-create') })
    expect(registry.tryRunWhenIdle(() => { invoked.push('during-create') })).toBe(false)
    createGate.resolve(stubHandle('pending-create'))
    await creating
    expect(registry.tryRunWhenIdle(() => { invoked.push('after-create') })).toBe(true)

    const resuming = registry.resume({ resumeSessionId: SessionId('pending-resume') })
    expect(registry.tryRunWhenIdle(() => { invoked.push('during-resume') })).toBe(false)
    resumeGate.resolve(stubHandle('pending-resume'))
    await resuming
    expect(registry.tryRunWhenIdle(() => { invoked.push('after-resume') })).toBe(true)

    // A returned-Promise initiator boundary counts as active work until it
    // settles, even without a live entry.
    const held = Promise.withResolvers<undefined>()
    const boundary = registry.withInitiator(stubAgent('initiator'), () => held.promise)
    expect(registry.tryRunWhenIdle(() => { invoked.push('initiator') })).toBe(false)
    held.resolve(undefined)
    await boundary
    expect(registry.tryRunWhenIdle(() => { invoked.push('after-initiator') })).toBe(true)

    // A detach covered by the registered factory's ledger does not withdraw
    // the registry proof.
    const owned = stubAgent('factory-owned')
    const detachOwned = registry.enter(owned, undefined, factory)
    detachOwned()
    expect(registry.get(owned.id)).toBeUndefined()
    expect(registry.tryRunWhenIdle(() => { invoked.push('after-owned-detach') })).toBe(true)

    // An explicitly supplied factory must be the registered factory, and the
    // mismatch throws before the entry is stored.
    const mismatched = stubAgent('mismatch')
    const otherFactory: AgentFactory = {
      createAgent: async () => stubHandle('other'),
      resume: async () => stubHandle('other'),
      isQuiescent: () => true,
    }
    expect(() => registry.enter(mismatched, undefined, otherFactory))
      .toThrow(/not the registered factory/)
    expect(registry.get(mismatched.id)).toBeUndefined()
    expect(registry.retention(mismatched)).toBeUndefined()

    // Any live entry blocks the gate, and the refusal leaves its exact
    // lifecycle untouched rather than sealing or evicting it. A plain entry
    // has no factory ledger, so its first accepted detach permanently latches
    // the registry instead of reopening the gate.
    const foreign = stubAgent('foreign')
    const unregister = await registry.register(foreign)
    expect(registry.tryRunWhenIdle(() => { invoked.push('foreign') })).toBe(false)
    expect(registry.get(foreign.id)).toBe(foreign)
    expect(registry.retention(foreign)?.state).toBe('open')
    await unregister()
    expect(registry.tryRunWhenIdle(() => { invoked.push('after-plain-detach') })).toBe(false)

    // Shutdown refuses even though every earlier entry has settled.
    await ctx.fiber.dispose()
    expect(registry.tryRunWhenIdle(() => { invoked.push('shutdown') })).toBe(false)
    expect(invoked).toEqual([
      'idle',
      'after-create',
      'after-resume',
      'after-initiator',
      'after-owned-detach',
    ])
  })

  it('latches a plain detach during a deferred announcement and never resets after a factory change', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const factory: AgentFactory = {
      createAgent: async () => stubHandle('deferred'),
      resume: async () => stubHandle('deferred'),
      isQuiescent: () => true,
    }
    ctx.agents.setFactory(factory)
    const invoked: string[] = []
    const agent = stubAgent('deferred')
    const detaching = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/created', async () => {
      detach()
      // The accepted detach latched before announce() defers the removal, so a
      // synchronous idle callback already refuses.
      expect(ctx.agents.tryRunWhenIdle(() => { invoked.push('during-deferred') })).toBe(false)
      detaching.resolve(undefined)
      await release.promise
    })
    const detach = ctx.agents.enter(agent, undefined)
    const announcing = ctx.agents.announce(agent, 'startup')
    await detaching.promise
    expect(ctx.agents.get(agent.id)).toBe(agent)
    release.resolve(undefined)
    await announcing
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(ctx.agents.tryRunWhenIdle(() => { invoked.push('after-deferred') })).toBe(false)
    await ctx.fiber.dispose()

    // Disposing the current factory registration blocks idle callbacks before
    // the slot clears; a replacement factory cannot reset the proof.
    const replacementCtx = new Context()
    await replacementCtx.plugin(AgentRegistry)
    const unregisterFactory = replacementCtx.agents.setFactory(factory)
    expect(replacementCtx.agents.tryRunWhenIdle(() => { invoked.push('before-unregister') })).toBe(true)
    unregisterFactory()
    expect(replacementCtx.agents.tryRunWhenIdle(() => { invoked.push('after-unregister') })).toBe(false)
    replacementCtx.agents.setFactory(factory)
    expect(replacementCtx.agents.tryRunWhenIdle(() => { invoked.push('after-replacement') })).toBe(false)
    await replacementCtx.fiber.dispose()
    expect(invoked).toEqual(['before-unregister'])
  })
})
