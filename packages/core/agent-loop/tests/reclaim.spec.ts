import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry, { AgentReclaimTeardownError, AgentReclaimingError } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * Mount the real loop. `persistent` adds the JSONL backend before the loop so
 * `sessions.flush()` has a participating writer; the memory-only variant
 * proves the no-participant refusal. Every instance is torn down with its
 * temporary storage even when an assertion fails.
 * @param options - whether the session has durable storage.
 * @returns the mounted context.
 */
async function harness(options: { persistent?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  let root: string | undefined
  if (options.persistent === true) root = await mkdtemp(join(tmpdir(), 'dsh-reclaim-'))
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    textResponse('ok'),
    textResponse('done'),
    textResponse('again'),
  ]))
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

describe('owner idle reclamation', () => {
  it('keeps the same live Agent when no durability listener participates or the flush rejects', async () => {
    const memory = await harness()
    const memoryHandle = await memory.agents.create({
      sessionId: SessionId('reclaim-memory'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const memoryReclaim = memoryHandle.reclaim
    if (memoryReclaim === undefined) throw new Error('native loop must expose reclaim')
    expect(memoryReclaim.idleSince()).toBeTypeOf('number')
    await expect(memoryReclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'busy', reason: 'persistence' })
    expect(memory.agents.retention(memoryHandle.agent)?.state).toBe('open')
    expect(memory.agents.get(memoryHandle.agent.id)).toBe(memoryHandle.agent)
    memoryHandle.agent.inject(message('still accepted'))
    memoryHandle.agent.cancel({ kind: 'user' })

    const durable = await harness({ persistent: true })
    const handle = await durable.agents.create({
      sessionId: SessionId('reclaim-flush-reject'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const reclaim = handle.reclaim
    if (reclaim === undefined) throw new Error('native loop must expose reclaim')
    durable.on('session/flush', () => { throw new Error('disk full') })
    await expect(reclaim.tryReclaim(async () => true)).rejects.toThrow('disk full')
    expect(durable.agents.retention(handle.agent)?.state).toBe('open')
    expect(durable.agents.get(handle.agent.id)).toBe(handle.agent)
    handle.agent.inject(message('accepted after failed flush'))
    handle.agent.cancel({ kind: 'user' })
  })

  it('rejects stale instances after teardown and a same-id resume, and quarantines unknown teardown', async () => {
    const ctx = await harness({ persistent: true })
    const sessionId = SessionId('reclaim-restore')
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const reclaim = handle.reclaim
    if (reclaim === undefined) throw new Error('native loop must expose reclaim')
    handle.agent.followup(message('persist me'))
    await handle.agent.whenIdle()
    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'reclaimed' })
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const stored = await ctx.sessionPersistence.open(sessionId, 'read')
    const durable = await stored.read()
    await stored.close()
    expect(durable.events.length).toBeGreaterThan(0)

    // The detached exact instance stays closed through the weak admission
    // record even though its registry entry and durable session handle are gone.
    expect(() => { handle.agent.inject(message('stale')) }).toThrow(AgentReclaimingError)
    expect(() => { ctx.agents.retain(handle.agent) }).toThrow()
    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'busy', reason: 'active' })

    const resumed = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(resumed.agent).not.toBe(handle.agent)
    expect(ctx.agents.get(sessionId)).toBe(resumed.agent)
    expect(() => { handle.agent.followup(message('replacement must not accept old input')) }).toThrow(AgentReclaimingError)
    resumed.agent.inject(message('new instance accepts'))
    resumed.agent.cancel({ kind: 'user' })

    // A failing scope disposer happens after the seal commit; the registry
    // already dropped the entry, so quarantine must still reach the old instance.
    const failedId = SessionId('reclaim-unknown-teardown')
    const failed = await ctx.agents.create({
      sessionId: failedId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const failedReclaim = failed.reclaim
    if (failedReclaim === undefined) throw new Error('native loop must expose reclaim')
    const machine = failed.agent as ReactLoopAgent
    machine.scope.dispose = async () => { throw new Error('close exploded') }
    const failure = await failedReclaim.tryReclaim(async () => true).then(() => undefined, (error: unknown) => error)
    if (!(failure instanceof AgentReclaimTeardownError)) throw new Error('expected an unknown-teardown rejection')
    expect(failure.kind).toBe('unknown-teardown')
    expect(failure.id).toBe(failedId)
    expect(ctx.agents.get(failedId)).toBeUndefined()
    expect(ctx.agents.retention(failed.agent)).toBeUndefined()
    expect(() => { failed.agent.inject(message('quarantined')) }).toThrow(AgentReclaimingError)
    expect(() => { ctx.agents.retain(failed.agent) }).toThrow()
    await resumed.dispose()
  })

  it('withholds idle eligibility through maintenance, pending input, and leases, then reclaims durably', async () => {
    const ctx = await harness({ persistent: true })
    const sessionId = SessionId('reclaim-busy')
    // Hold the creation announcement open: the entry is visible, but
    // publication has not settled, so quiescence must not begin yet.
    const released = Promise.withResolvers<undefined>()
    const announce = ctx.agents.announce.bind(ctx.agents)
    const spy = vi.spyOn(ctx.agents, 'announce').mockImplementation(async (agent, source, signal) => {
      await released.promise
      await announce(agent, source, signal)
    })
    const creating = ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await vi.waitFor(() => {
      if (ctx.agents.get(sessionId) === undefined) throw new Error('agent not entered')
    })
    expect((ctx.agents.get(sessionId) as ReactLoopAgent).idleSince()).toBeUndefined()
    released.resolve(undefined)
    const handle = await creating
    spy.mockRestore()
    const reclaim = handle.reclaim
    if (reclaim === undefined) throw new Error('native loop must expose reclaim')
    expect(reclaim.idleSince()).toBeTypeOf('number')

    const gate = Promise.withResolvers<undefined>()
    const maintenance = handle.agent.runMaintenance(async () => { await gate.promise })
    expect(reclaim.idleSince()).toBeUndefined()
    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'busy', reason: 'active' })
    gate.resolve()
    await maintenance
    expect(reclaim.idleSince()).toBeTypeOf('number')

    handle.agent.inject(message('pending'))
    expect(reclaim.idleSince()).toBeUndefined()
    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'busy', reason: 'active' })
    // Non-waking input clears without a phase transition; quiescence must
    // still restart from the latest committed inbox mutation rather than its
    // pre-inject timestamp.
    const clearedAt = Date.now()
    handle.agent.cancel({ kind: 'user' })
    const refreshed = reclaim.idleSince()
    expect(refreshed).toBeTypeOf('number')
    expect(refreshed).toBeGreaterThanOrEqual(clearedAt)
    handle.agent.followup(message('run'))
    await handle.agent.whenIdle()
    expect(reclaim.idleSince()).toBeTypeOf('number')

    const lease = ctx.agents.retain(handle.agent)
    expect(reclaim.idleSince()).toBeUndefined()
    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'busy', reason: 'active' })
    lease.release()
    lease.release()
    expect(ctx.agents.retention(handle.agent)?.leases).toBe(0)
    expect(reclaim.idleSince()).toBeTypeOf('number')

    await expect(reclaim.tryReclaim(async () => true)).resolves.toEqual({ kind: 'reclaimed' })
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
  })

  it('bounds a hung background check and converges with a racing owner teardown', async () => {
    const ctx = await harness({ persistent: true })
    const handle = await ctx.agents.create({
      sessionId: SessionId('reclaim-race'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const reclaim = handle.reclaim
    if (reclaim === undefined) throw new Error('native loop must expose reclaim')

    const hung = Promise.withResolvers<boolean>()
    const timed = reclaim.tryReclaim(async () => await hung.promise, { timeoutMs: 25 })
    // Same-tick input reaches the sealed admission before any await.
    expect(() => { handle.agent.inject(message('late')) }).toThrow(AgentReclaimingError)
    expect(ctx.agents.retention(handle.agent)?.state).toBe('sealed')
    await expect(timed).resolves.toEqual({ kind: 'busy', reason: 'background' })
    expect(ctx.agents.retention(handle.agent)?.state).toBe('open')
    expect(ctx.agents.get(handle.agent.id)).toBe(handle.agent)
    hung.resolve(true)
    handle.agent.inject(message('accepted after timeout'))
    handle.agent.cancel({ kind: 'user' })

    // A cached public inbox object cannot splice around the seal either.
    const ref = handle.agent.inbox
    const stuck = Promise.withResolvers<boolean>()
    const blocked = reclaim.tryReclaim(async () => await stuck.promise)
    expect(() => { ref.splice('next-step', 0, 0, [message('queued')]) }).toThrow(AgentReclaimingError)
    expect(() => { handle.agent.inject(message('second late')) }).toThrow(AgentReclaimingError)

    // Owner teardown removes the lifecycle while the proof still hangs: the
    // seal aborts, the attempt converges without reclaiming twice, and the
    // old instance is permanently closed.
    await handle.dispose()
    await expect(blocked).resolves.toEqual({ kind: 'busy', reason: 'active' })
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(() => { handle.agent.inject(message('after teardown')) }).toThrow(AgentReclaimingError)
    stuck.resolve(true)
  })
})
