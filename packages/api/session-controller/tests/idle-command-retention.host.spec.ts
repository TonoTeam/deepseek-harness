/**
 * Command retention against idle reclamation on the real AgentLoop, JSONL
 * persistence, and Session Query: a sealed identity must not take a business
 * mutation, and the replacement applies it exactly once.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionController } from '../src/index.ts'
import { createSessionTestController } from './test-remote.ts'

const roots: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function jsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(entry.parentPath, entry.name))
}

async function harness(): Promise<{ ctx: Context; controller: SessionController; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-command-retention-'))
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
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from(
    { length: 8 },
    (_, index) => textResponse(`answer ${index}`),
  )))
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: root,
    idleEviction: {
      enabled: true,
      idleTtlMs: 1,
      sweepPeriodMs: 20,
      maxPerSweep: 8,
      reclaimTimeoutMs: 60_000,
    },
  })
  return { ctx, controller, root }
}

describe('Session command retention during idle reclamation', () => {
  it('holds rename until the sealed Agent is torn down and applies the title once to its replacement', async () => {
    // The controller owns its sweep timer, so the clock advances inside the
    // same stack as the rename: the seal lands after the acquisition yielded
    // and before its continuation observes the Agent.
    vi.useFakeTimers()
    const { ctx, controller, root } = await harness()
    const activity = Promise.withResolvers<undefined>()
    let held = false
    const stopActivity = ctx.on('workspace/session-activity', async (_request, next) => {
      if (held) return next()
      held = true
      // The sweep seals admission before this read-only proof; hold it there
      // to issue a rename inside the exact reclamation window.
      await activity.promise
      return next()
    })
    const created = await controller.create({ cwd: root })
    const sessionId = created.sessionId
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('create did not publish a live Agent')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'one task' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    const sealedEventCount = agent.session.snapshotEvents().length

    const titles = ctx.get('sessionTitle')
    if (titles === undefined) throw new Error('session title service was not composed')
    const rename = vi.spyOn(titles, 'rename')

    const renaming = controller.rename({ sessionId, title: '  sealed   rename  ' })
    let settled = false
    void renaming.then(() => { settled = true }, () => { settled = true })
    // Same-stack competition: the sweep seals admission synchronously while
    // the rename is suspended at its first acquisition yield.
    vi.advanceTimersByTime(20)
    // Drain the queued acquisition continuation without firing another timer.
    await vi.advanceTimersByTimeAsync(0)
    // The durable mutation waits for the owner teardown instead of appending
    // to the sealed Session or acquiring a lease on the dying instance.
    expect(settled).toBe(false)
    expect(rename).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents()).toHaveLength(sealedEventCount)
    expect(ctx.agents.retention(agent)).toMatchObject({ leases: 0, state: 'sealed' })

    activity.resolve(undefined)
    const renamed = await renaming
    expect(renamed.title).toBe('sealed rename')
    expect(rename).toHaveBeenCalledOnce()
    expect(agent.session.snapshotEvents()).toHaveLength(sealedEventCount)

    const resumed = ctx.agents.get(sessionId)
    if (resumed === undefined) throw new Error('rename did not cold-acquire the replacement Agent')
    expect(resumed).not.toBe(agent)
    expect(ctx.agents.retention(resumed)?.state).toBe('open')
    // A turn may carry an automatic fallback title; the rename must be the
    // only user-sourced title and must land exactly once.
    const titleEvents = resumed.session.snapshotEvents()
      .filter(event => event.type === 'session/title' && event.data.source.kind === 'user')
    expect(titleEvents).toHaveLength(1)
    expect(titleEvents[0]).toMatchObject({
      seq: renamed.seq,
      data: { title: 'sealed rename', messageSeqs: [], source: { kind: 'user' } },
    })

    await ctx.sessions.flush(resumed.session)
    const files = await jsonlFiles(root)
    expect(files).toHaveLength(1)
    const persisted = (await readFile(files[0] as string, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as {
        type?: string
        seq?: number
        data?: { source?: { kind?: string } }
      })
      .filter(event => event.type === 'session/title' && event.data?.source?.kind === 'user')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      seq: renamed.seq,
      data: { title: 'sealed rename', messageSeqs: [], source: { kind: 'user' } },
    })
    stopActivity()
    vi.useRealTimers()
  }, 20_000)
})
