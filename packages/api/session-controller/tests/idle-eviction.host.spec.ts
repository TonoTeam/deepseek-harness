/** API-owned idle reclamation policy against the real AgentLoop and JSONL persistence. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ApiSessionAgentController, type ApiIdleEvictionConfig } from '../src/agent.ts'
import { SessionHistoryController } from '../src/history.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const roots: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function harness(
  overrides: Partial<ApiIdleEvictionConfig> = {},
): Promise<{ ctx: Context; controller: ApiSessionAgentController; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-idle-'))
  dirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  installSessionReadTestServices(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from(
    { length: 16 },
    (_, index) => textResponse(`answer ${index}`),
  )))
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  installModelSelectionProjection(ctx)
  const controller = new ApiSessionAgentController(ctx, {
    enabled: true,
    idleTtlMs: 1,
    sweepPeriodMs: 600_000,
    maxPerSweep: 8,
    reclaimTimeoutMs: 5_000,
    ...overrides,
  })
  return { ctx, controller, root }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

/** Run one complete turn so the Session has a real persisted recovery point. */
async function runTurn(ctx: Context, agent: Agent): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'one task' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
}

describe('API idle reclamation policy', () => {
  it('does not reclaim a blank Session and reclaims it after one complete turn', async () => {
    const { ctx, controller, root } = await harness()
    const { agent } = await controller.createSession({ cwd: root, reusable: () => true })
    const sessionId = agent.id
    const lease = ctx.agents.retain(agent)
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBe(agent)
    lease.release()
    await settle()
    // No turn has started, so this identity has no complete persisted turn to
    // recover; reclamation defers by the real turnBoundary projection.
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBe(agent)
    await runTurn(ctx, agent)
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    // The same durable identity resumes cold instead of remaining retired.
    await expect(controller.resolveAgent(sessionId)).resolves.toMatchObject({ agent: { id: sessionId } })
  })

  it('keeps a cold-follow promotion resident until the follower closes, then sweeps it', async () => {
    const { ctx, controller, root } = await harness()
    const { agent } = await controller.createSession({ cwd: root, reusable: () => true })
    const sessionId = agent.id
    await runTurn(ctx, agent)
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const history = new SessionHistoryController(ctx, async (observation) => {
      using owned = observation
      const resolved = await controller.resolveObservedAgent(owned)
      if ('error' in resolved) return undefined
      return controller.retainLive(sessionId)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
    const waiting = iterator.next()
    let promoted: Agent | undefined
    await vi.waitFor(() => {
      promoted = ctx.agents.get(sessionId)
      expect(promoted).toBeDefined()
    })
    if (promoted === undefined) throw new Error('cold follow did not promote a live Agent')
    await settle()
    await controller.sweepIdleAgents()
    // The follower's promotion lease outlives event delivery; a sweep during
    // the open cold follow must not reclaim the Agent it just promoted.
    expect(ctx.agents.get(sessionId)).toBe(promoted)
    abort.abort()
    let frame = await waiting
    while (frame.done !== true) frame = await iterator.next()
    expect(frame.done).toBe(true)
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('skips reported workspace activity and retains the same Agent through a failed flush', async () => {
    const { ctx, controller, root } = await harness()
    const { agent } = await controller.createSession({ cwd: root, reusable: () => true })
    await runTurn(ctx, agent)
    const sessionId = agent.id
    const stopActivity = ctx.on('workspace/session-activity', async (_request, next) => [
      ...await next(),
      { kind: 'turn' },
    ])
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBe(agent)
    stopActivity()
    const flushFailure = ctx.on('session/flush', () => { throw new Error('disk full') })
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBe(agent)
    expect(ctx.agents.retention(agent)?.state).toBe('open')
    flushFailure()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('quarantines an unknown teardown identity against automatic resolve or create replacement', async () => {
    const { ctx, controller, root } = await harness()
    const { agent } = await controller.createSession({ cwd: root, reusable: () => true })
    await runTurn(ctx, agent)
    const sessionId = agent.id
    const handles = (controller as unknown as { handles: Map<SessionId, AgentHandle> }).handles
    const handle = handles.get(sessionId)
    if (handle === undefined) throw new Error('creator-owned handle was not retained')
    const machine = handle.agent as unknown as { scope: { dispose(): Promise<void> } }
    machine.scope.dispose = async () => { throw new Error('close exploded') }
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await expect(controller.resolveAgent(sessionId)).resolves.toMatchObject({
      error: { code: 'gateway/internal' },
    })
    await expect(controller.createSession({ sessionId, cwd: root, reusable: () => true }))
      .rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('rotates the sweep cursor so blocked candidates cannot starve later ones', async () => {
    const { ctx, controller, root } = await harness({ maxPerSweep: 2 })
    const created: Agent[] = []
    for (let index = 0; index < 4; index += 1) {
      const { agent } = await controller.createSession({ cwd: root, reusable: () => true })
      await runTurn(ctx, agent)
      created.push(agent)
    }
    const blocked = new Set(created.slice(0, 2).map(agent => agent.id))
    const stopActivity = ctx.on('workspace/session-activity', async (request, next) => {
      if (!blocked.has(request.sessionId)) return next()
      return [...await next(), { kind: 'turn' }]
    })
    await settle()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(created[0]!.id)).toBe(created[0])
    expect(ctx.agents.get(created[1]!.id)).toBe(created[1])
    // The next sweep starts after the blocked prefix instead of retrying it.
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(created[2]!.id)).toBeUndefined()
    expect(ctx.agents.get(created[3]!.id)).toBeUndefined()
    stopActivity()
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(created[0]!.id)).toBeUndefined()
    expect(ctx.agents.get(created[1]!.id)).toBeUndefined()
  })

  it('bounds the activity proof by policy timeout and aborts it on shutdown', async () => {
    const { ctx, controller, root } = await harness({ reclaimTimeoutMs: 15 })
    const { agent } = await controller.createSession({ cwd: root, reusable: () => true })
    await runTurn(ctx, agent)
    const sessionId = agent.id
    const stopActivity = ctx.on('workspace/session-activity', () => new Promise<never>(() => {}))
    await settle()
    // A hung read-only proof must expire instead of sealing the identity.
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBe(agent)
    expect(ctx.agents.retention(agent)?.state).toBe('open')
    // Owner shutdown aborts a still-running proof and leaves the Agent live.
    const hanging = controller.sweepIdleAgents()
    await Promise.resolve()
    controller.disposeIdleEviction()
    await expect(hanging).resolves.toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBe(agent)
    stopActivity()
  })
})
