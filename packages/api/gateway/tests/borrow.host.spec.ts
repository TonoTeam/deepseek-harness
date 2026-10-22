/** Host borrow lifetime through Gateway acquisition, unary completion, and stream cleanup. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  bindTypertRemote,
  Remote,
  type PeerScope,
  type Principal,
  type TypertContext,
  type TypertLookup,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { ownerPeer, peerFor } from './peer.ts'

interface FixtureAgent { readonly id: string }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    borrowAgent: TypertLookup<FixtureAgent, string>
    borrowOther: TypertLookup<FixtureAgent, string>
  }
  interface TypertContextMap {
    borrowScope: TypertContext<string>
  }
  interface PrincipalMap {
    'borrow-guest': { readonly kind: 'borrow-guest'; readonly guest: string }
  }
}

const GUEST: Principal = { kind: 'borrow-guest', guest: 'borrow' }

class BorrowService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'borrowService', { namespace: 'borrow' })
  readonly slow = Promise.withResolvers<undefined>()
  readonly cleanup = Promise.withResolvers<undefined>()
  streamCleanup = false

  constructor(ctx: Context) { super(ctx, 'borrowService') }

  @Remote
  async unary(agent: FixtureAgent, signal: AbortSignal): Promise<string> {
    await this.slow.promise
    signal.throwIfAborted()
    return agent.id
  }

  @Remote({ mode: 'stream' })
  async *stream(agent: FixtureAgent): AsyncGenerator<string> {
    try {
      yield agent.id
    } finally {
      await this.cleanup.promise
      this.streamCleanup = true
    }
  }

  customSource: Iterable<unknown> | AsyncIterable<unknown> | undefined
  customCalls = 0

  @Remote({ mode: 'stream' })
  custom(agent: FixtureAgent): Iterable<unknown> | AsyncIterable<unknown> {
    void agent
    this.customCalls += 1
    if (this.customSource === undefined) throw new Error('custom source was not configured')
    return this.customSource
  }

  @Remote({ mode: 'stream' })
  plain(agent: FixtureAgent): object {
    void agent
    return { not: 'iterable' }
  }

  @Remote
  two(agent: FixtureAgent, other: FixtureAgent): string {
    return `${agent.id}:${other.id}`
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup(): Promise<{ ctx: Context; service: BorrowService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService, {})
  const fiber = ctx.plugin(BorrowService)
  await fiber
  return { ctx, service: ctx.get('borrowService') as BorrowService }
}

function registerLookup(
  ctx: Context,
  key: 'borrowAgent' | 'borrowOther',
  parameter: string,
  acquire: (id: string) => { readonly value: FixtureAgent; release(): void },
): void {
  ctx.typert.lookups.register(key, {
    parameter,
    wire: parameter === 'agent' ? 'agentId' : 'otherId',
    hostTypeSymbol: '@fixture/domain#Agent',
    wireTypeSymbol: '@fixture/domain#AgentId',
    resolve: () => { throw new Error('plain resolve must not be used when borrow exists') },
    borrow: id => acquire(id),
  })
}

describe('Gateway Host borrowing', () => {
  it('pins a unary borrow until the business method settles and ignores cancellation for cleanup', async () => {
    const { ctx, service } = await setup()
    const agent = { id: 'agent-1' }
    const release = vi.fn()
    const borrow = vi.fn(() => ({ value: agent, release }))
    registerLookup(ctx, 'borrowAgent', 'agent', borrow)
    const abort = new AbortController()

    const call = ctx.typertGateway.invoke({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'unary',
      args: { agentId: 'agent-1' },
      signal: abort.signal,
    })
    await vi.waitFor(() => { expect(borrow).toHaveBeenCalledOnce() })
    // Cancellation only aborts the signal; the method is still running and its
    // Host lease must stay with it.
    abort.abort()
    expect(release).not.toHaveBeenCalled()
    service.slow.resolve(undefined)
    await expect(call).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('resolves lookups in order and unwinds acquired borrows in reverse on a later failure', async () => {
    const { ctx } = await setup()
    const releaseFirst = vi.fn()
    const acquireFirst = vi.fn(() => ({ value: { id: 'agent-1' }, release: releaseFirst }))
    const acquireSecond = vi.fn(() => { throw new Error('second lookup failed') })
    registerLookup(ctx, 'borrowAgent', 'agent', acquireFirst)
    registerLookup(ctx, 'borrowOther', 'other', acquireSecond)

    await expect(ctx.typertGateway.invoke({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'two',
      args: { agentId: 'agent-1', otherId: 'agent-2' },
    })).rejects.toMatchObject({ code: 'gateway/lookup-failed' })
    expect(acquireFirst).toHaveBeenCalledOnce()
    expect(acquireSecond).toHaveBeenCalledOnce()
    expect(releaseFirst).toHaveBeenCalledOnce()
  })

  it('releases a started stream only after iterator return cleanup and an unstarted stream on close', async () => {
    const { ctx, service } = await setup()
    const agent = { id: 'agent-1' }
    const release = vi.fn()
    registerLookup(ctx, 'borrowAgent', 'agent', () => ({ value: agent, release }))

    const started = (await ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'stream',
      args: { agentId: 'agent-1' },
    }))[Symbol.asyncIterator]()
    await expect(started.next()).resolves.toEqual({ done: false, value: 'agent-1' })
    const returned = started.return?.(undefined)
    // The generator's finally is waiting; release must not race that cleanup.
    await Promise.resolve()
    expect(service.streamCleanup).toBe(false)
    expect(release).not.toHaveBeenCalled()
    service.cleanup.resolve(undefined)
    await returned
    expect(service.streamCleanup).toBe(true)
    expect(release).toHaveBeenCalledOnce()

    const unstarted = (await ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'stream',
      args: { agentId: 'agent-1' },
    }))[Symbol.asyncIterator]()
    await unstarted.return?.(undefined)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('waits for a pending next that lost the abort race and releases when the factory throws', async () => {
    const { ctx, service } = await setup()
    const release = vi.fn()
    registerLookup(ctx, 'borrowAgent', 'agent', () => ({ value: { id: 'agent-1' }, release }))
    const pending = Promise.withResolvers<IteratorResult<unknown>>()
    const nextCalled = Promise.withResolvers<undefined>()
    let returned = false
    service.customSource = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCalled.resolve(undefined)
          return pending.promise
        },
        // A custom iterator need not serialize return() behind next(); this
        // one resolves immediately while the read above is still in flight.
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        },
      }),
    }
    const abort = new AbortController()
    const iterator = (await ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'custom',
      args: { agentId: 'agent-1' },
      signal: abort.signal,
    }))[Symbol.asyncIterator]()
    const first = iterator.next()
    await nextCalled.promise
    abort.abort()
    await vi.waitFor(() => { expect(returned).toBe(true) })
    // return() already resolved done, but the abandoned read still runs and
    // the Host borrow must stay leased until it actually settles.
    expect(release).not.toHaveBeenCalled()
    pending.resolve({ done: true, value: undefined })
    await expect(first).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(release).toHaveBeenCalledOnce()

    service.customSource = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        throw new Error('factory failed')
      },
    }
    const failed = (await ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'custom',
      args: { agentId: 'agent-1' },
    }))[Symbol.asyncIterator]()
    await expect(failed.next()).rejects.toThrow('factory failed')
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('returns an unstarted custom iterator before releasing its borrow, without a next or replay', async () => {
    const { ctx, service } = await setup()
    const release = vi.fn()
    registerLookup(ctx, 'borrowAgent', 'agent', () => ({ value: { id: 'agent-1' }, release }))
    const sourceCleanup = Promise.withResolvers<undefined>()
    const returned = vi.fn(async (): Promise<IteratorResult<unknown>> => {
      await sourceCleanup.promise
      return { done: true, value: undefined }
    })
    const next = vi.fn((): Promise<IteratorResult<unknown>> =>
      Promise.resolve({ done: true, value: undefined }))
    service.customSource = {
      [Symbol.asyncIterator]: () => ({ next, return: returned }),
    }
    const iterator = (await ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'custom',
      args: { agentId: 'agent-1' },
    }))[Symbol.asyncIterator]()

    const closing = iterator.return?.(undefined)
    // The business iterator owns resources allocated when the method returned
    // it: its own asynchronous return cleanup must own the Agent pin.
    await vi.waitFor(() => { expect(returned).toHaveBeenCalledOnce() })
    expect(next).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    sourceCleanup.resolve(undefined)
    await expect(closing).resolves.toEqual({ done: true, value: undefined })
    expect(release).toHaveBeenCalledOnce()
    // A repeated close stays idempotent: the wrapper never re-enters the
    // business iterator cleanup or releases the borrow twice.
    await expect(iterator.return?.(undefined)).resolves.toEqual({ done: true, value: undefined })
    expect(returned).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    // Unstarted cleanup closes the one business iterator; the Remote method was
    // invoked once and is never replayed to obtain a fresh source.
    expect(service.customCalls).toBe(1)
  })

  it('releases the borrow when a source getter throws during stream validation', async () => {
    const { ctx, service } = await setup()
    const release = vi.fn()
    registerLookup(ctx, 'borrowAgent', 'agent', () => ({ value: { id: 'agent-1' }, release }))
    service.customSource = {
      get [Symbol.asyncIterator](): () => AsyncIterator<unknown> {
        throw new Error('iterator getter failed')
      },
    }
    await expect(ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'custom',
      args: { agentId: 'agent-1' },
    })).rejects.toThrow('iterator getter failed')
    expect(release).toHaveBeenCalledOnce()

    // A value implementing neither protocol is refused through the same
    // cleanup path instead of escaping as an uncleaned validation error.
    await expect(ctx.typertGateway.stream({
      peer: ownerPeer(ctx),
      namespace: 'borrow',
      method: 'plain',
      args: { agentId: 'agent-1' },
    })).rejects.toMatchObject({ code: 'gateway/result-invalid' })
    expect(release).toHaveBeenCalledTimes(2)
    expect(service.customCalls).toBe(1)
  })

  it('decides access before acquiring a borrow', async () => {
    const { ctx } = await setup()
    const borrow = vi.fn(() => ({ value: { id: 'agent-1' }, release: () => {} }))
    registerLookup(ctx, 'borrowAgent', 'agent', borrow)
    const peer: PeerScope = peerFor(ctx, GUEST)

    await expect(ctx.typertGateway.invoke({
      peer,
      namespace: 'borrow',
      method: 'unary',
      args: { agentId: 'agent-1' },
    })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(borrow).not.toHaveBeenCalled()
  })
})
