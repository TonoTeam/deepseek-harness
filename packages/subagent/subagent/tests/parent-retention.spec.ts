/** Parent lifetime leases across local and external subagent materialization. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '../src/index.ts'
import type { SubagentResult, SubagentRun } from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { mountLocalActivations, startTestActivation } from './local-activation.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { subagentManager } from './manager-internals.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

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

    // A native create rejection may follow partial Agent startup; the factory
    // swallows its rollback failure, so the parent stays pinned.
    const create = vi.spyOn(ctx.agents, 'create').mockRejectedValueOnce(new Error('native create failed'))
    ctx.subagents.registerProvider({
      name: 'created-local',
      inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
      prepareContinuable: async () => ({}),
    })
    await expect(ctx.subagents.startActivation({
      provider: 'created-local',
      label: 'created local child',
      signal: new AbortController().signal,
      delivery: 'parent',
      request: { parent, prompt: [{ type: 'text', text: 'fail after create' }] },
    })).rejects.toThrow('native create failed')
    expect(create).toHaveBeenCalledOnce()
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })

  it('pins through external startup and cleanup, and releases after confirmed cleanup', async () => {
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
  })

  it.each([
    { outcome: 'a plain error', rejection: () => new Error('backend start failed') },
    { outcome: 'a cancellation', rejection: () => Object.assign(new Error('startup cancelled'), { name: 'AbortError' }) },
    {
      outcome: 'an AggregateError from failed startup cleanup',
      rejection: () => new AggregateError([new Error('cleanup outcome unknown')], 'startup cancelled'),
    },
  ])('retains the parent lease when external start rejects after partial startup with $outcome', async ({ rejection }) => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const parent = await externalTestParent(ctx)

    let childAlive = false
    const failure = rejection()
    ctx.subagents.registerProvider({
      name: 'partially-started-external',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => {
        childAlive = true
        throw failure
      },
    })
    await expect(ctx.subagents.startActivation({
      provider: 'partially-started-external',
      label: 'partially started external child',
      signal: new AbortController().signal,
      delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'fail after startup' }] },
    })).rejects.toThrow(failure.message)

    // The provider started the backend before rejecting and returned no run,
    // so no public cleanup success exists: the parent stays pinned.
    expect(childAlive).toBe(true)
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })

  it.each([
    {
      outcome: 'resolves',
      settle: (result: PromiseWithResolvers<SubagentResult>) => { result.resolve(complete) },
    },
    {
      outcome: 'rejects',
      settle: (result: PromiseWithResolvers<SubagentResult>) => {
        result.reject(new Error('external run failed'))
      },
    },
    {
      outcome: 'is cancelled',
      settle: (result: PromiseWithResolvers<SubagentResult>) => {
        result.reject(Object.assign(new Error('external run cancelled'), { name: 'AbortError' }))
      },
    },
  ])('retains the parent lease when an unpublished external disposal rejects and its result $outcome', async ({ settle }) => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const parent = await externalTestParent(ctx)

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

    // The rollback could not confirm that the backend stopped, so the parent
    // is pinned even though the run is no longer reachable by the manager.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()

    // Result settlement, rejection, and cancellation are not stop proof: none
    // of them may reduce the retained lease or let the parent be reclaimed.
    settle(unknownResult)
    await unknownResult.promise.catch(() => undefined)
    await Promise.resolve()
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })

  it('retains the parent lease when a published external activation disposal rejects', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const parent = await externalTestParent(ctx)

    const result = Promise.withResolvers<SubagentResult>()
    const disposeEntered = Promise.withResolvers<undefined>()
    const run: SubagentRun = {
      id: SessionId('retention-published-child'),
      result: result.promise,
      dispose: async () => {
        disposeEntered.resolve(undefined)
        throw new Error('dispose outcome unknown')
      },
    }
    ctx.subagents.registerProvider({
      name: 'rejecting-dispose-external',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => run,
    })
    const activation = await ctx.subagents.startActivation({
      provider: 'rejecting-dispose-external',
      label: 'rejecting external child',
      signal: new AbortController().signal,
      delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'work' }] },
    })
    expect(ctx.agents.retention(parent)?.leases).toBe(1)

    result.resolve(complete)
    await disposeEntered.promise
    await expect(activation.result).resolves.toEqual(complete)
    // The captured result was delivered, but the failed handle teardown can
    // still hide a running backend, so the parent remains pinned.
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
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
    const resumeMock = vi.spyOn(ctx.agents, 'resume').mockImplementation(async (options) => {
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

    // A native resume rejection may follow partial Agent startup; the factory
    // swallows its rollback failure, so the parent stays pinned.
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    resumeMock.mockRejectedValueOnce(new Error('native resume failed'))
    await expect(queue(started.childId, 'fail resume')).rejects.toThrow('is unavailable')
    expect(ctx.agents.retention(parent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(parent)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })

  it.each([
    { outcome: 'its SDK startup rejects after a partial start', failure: 'startup' },
    { outcome: 'its published SDK cleanup rejects', failure: 'cleanup' },
  ] as const)('keeps the root lineage pinned when a nested SDK grandchild $outcome', async ({ failure }) => {
    const ctx = new Context()
    await mountLocalActivations(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const adapter = new MockAdapter([
      toolCallResponse('start-grandchild', 'start_grandchild', {}),
      textResponse('child finished'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const rootHandle = await ctx.agents.create({
      sessionId: SessionId(`nested-retention-root-${failure}`),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const root = rootHandle.agent

    let starts = 0
    let grandchildAlive = false
    let cleanupAttempted = false
    const publishedResult = Promise.withResolvers<SubagentResult>()
    ctx.subagents.registerProvider({
      name: 'sdk-grandchild',
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => {
        starts += 1
        grandchildAlive = true
        if (failure === 'startup') {
          throw new AggregateError(
            [new Error('SDK cleanup outcome unknown')],
            'SDK grandchild partial startup failed',
          )
        }
        return {
          id: SessionId('nested-sdk-grandchild'),
          result: publishedResult.promise,
          dispose: async () => {
            cleanupAttempted = true
            // A settled result can precede backend process shutdown; throw to
            // expose the unknown cleanup without pretending the backend stopped.
            publishedResult.resolve(complete)
            throw new AggregateError(
              [new Error('SDK cleanup outcome unknown')],
              'SDK grandchild cleanup failed',
            )
          },
        }
      },
    })
    ctx.subagents.registerProvider({
      name: 'nested-local',
      inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
      prepareContinuable: () => Promise.resolve({}),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'start_grandchild',
      description: 'Start the nested SDK grandchild',
      parameters: {},
      async execute(_args, exec): Promise<ContentBlock[]> {
        const parent = exec.agent
        if (parent === undefined) throw new Error('expected the local child Agent')
        const startGrandchild = () => ctx.subagents.startActivation({
          provider: 'sdk-grandchild',
          label: 'nested SDK grandchild',
          signal: new AbortController().signal,
          delivery: 'caller',
          request: { parent, prompt: [{ type: 'text', text: 'work independently' }] },
        })
        if (failure === 'cleanup') {
          const grandchild = await startGrandchild()
          await grandchild.dispose().catch(() => undefined)
        } else {
          try {
            await startGrandchild()
          } catch (error: unknown) {
            if (!(error instanceof AggregateError)) throw error
          }
        }
        return [{ type: 'text', text: 'grandchild handled' }]
      },
    }))

    const child = await startTestActivation(ctx, 'nested-local', {
      parent: root,
      label: 'nested local child',
      agentOptions: { provider: 'mock', model: 'mock' },
      prompt: [{ type: 'text', text: 'start the SDK grandchild, then finish' }],
    })
    await child.result
    // Let the child's natural settlement and handle disposal finish: the
    // unknown grandchild must protect the root after its own child is gone.
    await vi.waitFor(() => { expect(ctx.agents.get(child.childId)).toBeUndefined() })
    expect(starts).toBe(1)
    expect(grandchildAlive).toBe(true)
    if (failure === 'cleanup') expect(cleanupAttempted).toBe(true)
    // The child's own root lease is released with its normal completion; the
    // failed grandchild's lineage lease is the only one left on the root.
    expect(ctx.agents.retention(root)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(root)).toBeUndefined()
    expect(ctx.agents.get(root.id)).toBe(root)
  })
})
