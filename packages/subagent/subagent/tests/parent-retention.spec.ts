/** Parent lifetime leases across local and external subagent materialization. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import type { SubagentResult, SubagentRun } from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { mountLocalActivations } from './local-activation.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { subagentManager } from './manager-internals.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const complete: SubagentResult = {
  output: [{ type: 'text', text: 'CHILD_RESULT_42' }],
  stopReason: 'completed',
}

describe('subagent parent retention', () => {
  it('pins the exact parent from local preparation through the queued settlement notice', async () => {
    const ctx = new Context()
    await mountLocalActivations(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    // One child turn followed by the parent turn the settlement notice wakes.
    const adapter = new MockAdapter([textResponse('CHILD_RESULT_42'), textResponse('parent acknowledged')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('retention-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = handle.agent
    const reclaim = handle.reclaim
    if (reclaim === undefined) throw new Error('native loop must expose reclaim')

    const prepared = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({
      name: 'gated-local',
      inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
      prepareContinuable: async () => {
        prepared.resolve(undefined)
        await gate.promise
        return {}
      },
    })
    const starting = ctx.subagents.startActivation({
      provider: 'gated-local',
      label: 'gated local child',
      signal: new AbortController().signal,
      delivery: 'parent',
      request: { parent, prompt: [{ type: 'text', text: 'do the work' }] },
    })
    await prepared.promise

    // Provider preparation is still pending: the parent is pinned, the real
    // native reclaim capability cannot seal, and its state stays open.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'busy', reason: 'active' })
    expect(ctx.agents.get(parent.id)).toBe(parent)

    let noticeLease: number | undefined
    const followup = parent.followup.bind(parent)
    vi.spyOn(parent, 'followup').mockImplementation((message) => {
      noticeLease = ctx.agents.retention(parent)?.leases
      followup(message)
    })

    gate.resolve(undefined)
    const activation = await starting
    await activation.result
    // The notice is queued before the lease is released; the parent turn then
    // consumes the full child output without loss.
    expect(noticeLease).toBe(1)
    expect(ctx.agents.retention(parent)?.leases).toBe(0)
    await parent.whenIdle()
    expect(JSON.stringify(adapter.requests.at(-1)?.messages ?? [])).toContain('CHILD_RESULT_42')

    // A provider preparation that rejects releases the local start's lease too.
    ctx.subagents.registerProvider({
      name: 'failing-local',
      inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
      prepareContinuable: async () => { throw new Error('prepare failed') },
    })
    await expect(ctx.subagents.startActivation({
      provider: 'failing-local',
      label: 'failing local child',
      signal: new AbortController().signal,
      delivery: 'parent',
      request: { parent, prompt: [{ type: 'text', text: 'fail' }] },
    })).rejects.toThrow('prepare failed')
    expect(ctx.agents.retention(parent)?.leases).toBe(0)
  })

  it('pins through external startup and cleanup, and releases on failure or cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const parent = await externalTestParent(ctx)

    const startEntered = Promise.withResolvers<undefined>()
    const startGate = Promise.withResolvers<SubagentRun>()
    const result = Promise.withResolvers<SubagentResult>()
    const disposeEntered = Promise.withResolvers<undefined>()
    const disposeGate = Promise.withResolvers<undefined>()
    const run: SubagentRun = {
      id: SessionId('retention-external-child'),
      result: result.promise,
      dispose: async () => {
        disposeEntered.resolve(undefined)
        await disposeGate.promise
      },
    }
    ctx.subagents.registerProvider({
      name: 'gated-external',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => {
        startEntered.resolve(undefined)
        return startGate.promise
      },
    })
    const starting = ctx.subagents.startActivation({
      provider: 'gated-external',
      label: 'gated external child',
      signal: new AbortController().signal,
      delivery: 'parent',
      request: { parent, prompt: [{ type: 'text', text: 'work independently' }] },
    })
    await startEntered.promise

    // External startup is suspended; the parent lease is already held.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(parent.inbox.nextTurn).toEqual([])
    startGate.resolve(run)
    const activation = await starting
    expect(ctx.agents.retention(parent)?.leases).toBe(1)

    let noticeLease: number | undefined
    const followup = parent.followup.bind(parent)
    vi.spyOn(parent, 'followup').mockImplementation((message) => {
      noticeLease = ctx.agents.retention(parent)?.leases
      followup(message)
    })

    result.resolve(complete)
    await disposeEntered.promise
    // Cleanup is still running, so the parent remains pinned.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    disposeGate.resolve(undefined)
    await activation.result
    expect(noticeLease).toBe(1)
    expect(ctx.agents.retention(parent)?.leases).toBe(0)
    expect(JSON.stringify(parent.inbox.nextTurn)).toContain('CHILD_RESULT_42')

    // A rejecting backend start releases the lease before the caller sees it.
    ctx.subagents.registerProvider({
      name: 'failing-external',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => { throw new Error('backend start failed') },
    })
    await expect(ctx.subagents.startActivation({
      provider: 'failing-external',
      label: 'failing external child',
      signal: new AbortController().signal,
      delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'fail' }] },
    })).rejects.toThrow('backend start failed')
    expect(ctx.agents.retention(parent)?.leases).toBe(0)

    // A returned run whose publication is aborted after startup, and whose
    // disposal rejects while its result is still pending, has no confirmed stop.
    // Every rollback layer shares one lease owner, so the parent stays pinned
    // until the run's own terminal signal, then becomes reclaimable again.
    const abortRun = new AbortController()
    const startReached = Promise.withResolvers<undefined>()
    const returnedRun = Promise.withResolvers<SubagentRun>()
    const unknownResult = Promise.withResolvers<SubagentResult>()
    const unknownRun: SubagentRun = {
      id: SessionId('retention-unknown-child'),
      result: unknownResult.promise,
      dispose: async () => { throw new Error('dispose outcome unknown') },
    }
    ctx.subagents.registerProvider({
      name: 'unknown-external',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => {
        startReached.resolve(undefined)
        return returnedRun.promise
      },
    })
    const unknown = ctx.subagents.startActivation({
      provider: 'unknown-external',
      label: 'unknown external child',
      signal: abortRun.signal,
      delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'unknown' }] },
    })
    await startReached.promise
    abortRun.abort(new Error('startup cancelled'))
    returnedRun.resolve(unknownRun)
    await expect(unknown).rejects.toThrow('startup cancelled')
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)

    unknownResult.resolve(complete)
    await vi.waitFor(() => { expect(ctx.agents.retention(parent)?.leases).toBe(0) })
    const released = ctx.agents.sealReclaim(parent)
    expect(released).toBeDefined()
    released?.abort()
    // Cancellation during a hung startup rejects the start and also releases.
    const abortEntered = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({
      name: 'cancelled-external',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: ({ signal }) => new Promise((_resolve, reject) => {
        abortEntered.resolve(undefined)
        signal.addEventListener('abort', () => { reject(new Error('startup cancelled')) }, { once: true })
      }),
    })
    const cancelled = ctx.subagents.startActivation({
      provider: 'cancelled-external',
      label: 'cancelled external child',
      signal: new AbortController().signal,
      delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'cancel' }] },
    })
    await abortEntered.promise
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    await ctx.subagents.drainDescendants([parent])
    await expect(cancelled).rejects.toThrow('startup cancelled')
    expect(ctx.agents.retention(parent)?.leases).toBe(0)

  })

  it('pins the parent across a hung cold-resume observation and releases after the queued notice', async () => {
    const ctx = new Context()
    await mountLocalActivations(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentRuntime)
    const adapter = new MockAdapter([
      textResponse('first child'),
      textResponse('resumed child'),
      textResponse('parent acknowledged'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cold-retention-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = handle.agent
    ctx.subagents.registerProvider({
      name: 'cold-local',
      inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
      prepareContinuable: async () => ({}),
    })
    const started = await ctx.subagents.startActivation({
      provider: 'cold-local',
      label: 'cold child',
      signal: new AbortController().signal,
      delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'first task' }] },
    })
    await started.result
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    expect(ctx.agents.retention(parent)?.leases).toBe(0)

    // A missing durable child fails observation before materialization and
    // releases the lease normally.
    const queue = (childId: SessionId, text: string) => subagentManager(ctx).queuePrompt(
      parent,
      childId,
      [{ type: 'text', text }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await expect(queue(SessionId('missing-cold-child'), 'continue missing'))
      .rejects.toThrow('is unavailable')
    expect(ctx.agents.retention(parent)?.leases).toBe(0)

    const query = ctx.sessionQuery
    const observe = query.observeSession.bind(query)
    const observed = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    vi.spyOn(query, 'observeSession').mockImplementation(async (sessionId, options) => {
      observed.resolve(undefined)
      await releaseObservation.promise
      return observe(sessionId, options)
    })
    const resumeAgent = ctx.agents.resume.bind(ctx.agents)
    const resumeObserved = Promise.withResolvers<undefined>()
    const releaseResume = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async (options) => {
      resumeObserved.resolve(undefined)
      await releaseResume.promise
      return resumeAgent(options)
    })
    let noticeLease: number | undefined
    const followup = parent.followup.bind(parent)
    vi.spyOn(parent, 'followup').mockImplementation((message) => {
      noticeLease = ctx.agents.retention(parent)?.leases
      followup(message)
    })

    const resumed = queue(started.childId, 'continue please')
    await observed.promise
    // Observation/materialization is suspended: the exact parent is pinned.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()

    releaseObservation.resolve(undefined)
    await resumeObserved.promise
    // Materialization is suspended: the same lease still pins the parent.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()

    releaseResume.resolve(undefined)
    await resumed
    await vi.waitFor(() => { expect(noticeLease).toBe(1) })
    await vi.waitFor(() => { expect(ctx.agents.retention(parent)?.leases).toBe(0) })
    await parent.whenIdle()
    expect(JSON.stringify(adapter.requests.at(-1)?.messages ?? [])).toContain('resumed child')
  })
})
