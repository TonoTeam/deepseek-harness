import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentReclaimingError } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionResources } from '../src/index.ts'

const contexts: Context[] = []

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  async function owner(id: string) {
    const fiber = ctx.plugin(() => {})
    const session = Session.create(SessionId(id))
    const agent: Agent = {
      id: session.id, session, ctx: fiber.ctx, options: {}, status: 'idle',
      inbox: unsupportedInbox(), send() {}, followup() {}, inject() {}, cancel() {},
      steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(undefined),
    }
    const unregister = ctx.agents.register(agent)
    await unregister
    return { agent, async dispose() { await fiber.dispose(); await unregister() } }
  }
  return { ctx, owner }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('Session browser resource ownership', () => {
  it('acquires once across concurrent requests and gives another Session a different resource', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const close = vi.fn(async () => {})
    const open = vi.fn(async (agent: Agent) => ({ value: { id: agent.id }, close }))
    const resources = new SessionResources(ctx, { label: 'test', exclusive: false, open })
    const [first, again, other] = await Promise.all([resources.get(a.agent), resources.get(a.agent), resources.get(b.agent)])
    expect(first).toBe(again)
    expect(other).not.toBe(first)
    expect(open).toHaveBeenCalledTimes(2)
    await a.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    await expect(resources.get(a.agent)).rejects.toThrow('not a live browser owner')
    const resumed = await owner('a')
    expect(await resources.get(resumed.agent)).not.toBe(first)
    await resources.dispose()
    expect(close).toHaveBeenCalledTimes(3)
    expect(resources.available(b.agent)).toBe(false)
    await expect(resources.get(b.agent)).rejects.toThrow('not a live browser owner')
  })

  it('reserves an attached browser while acquisition or cleanup is pending', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const opened = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const closing = Promise.withResolvers<undefined>()
    const resources = new SessionResources(ctx, {
      label: 'attached', exclusive: true,
      async open() {
        await opened.promise
        return { value: {}, async close() { closing.resolve(undefined); await released.promise } }
      },
    })
    expect(resources.available(a.agent)).toBe(true)
    expect(resources.available(b.agent)).toBe(true)
    const first = resources.get(a.agent)
    expect(resources.available(a.agent)).toBe(true)
    expect(resources.available(b.agent)).toBe(false)
    await expect(resources.get(b.agent)).rejects.toThrow('already reserved')
    opened.resolve(undefined)
    await first
    const disposing = a.dispose()
    await closing.promise
    expect(resources.available(a.agent)).toBe(false)
    expect(resources.available(b.agent)).toBe(false)
    await expect(resources.get(b.agent)).rejects.toThrow('already reserved')
    released.resolve(undefined)
    await disposing
    expect(resources.available(b.agent)).toBe(true)
    await resources.get(b.agent)
    await resources.dispose()
  })

  it('keeps a failed acquisition pinned and refuses another exclusive owner', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const failure = new Error('browser unavailable')
    const open = vi.fn().mockRejectedValue(failure)
    const resources = new SessionResources<number>(ctx, { label: 'test', exclusive: true, open })
    await expect(resources.get(a.agent, new AbortController().signal)).rejects.toBe(failure)
    // A rejected open may follow an unconfirmed rollback, so the entry and pin stay.
    expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
    expect(resources.available(a.agent)).toBe(true)
    await expect(resources.get(a.agent)).rejects.toBe(failure)
    expect(open).toHaveBeenCalledOnce()
    await expect(resources.get(b.agent)).rejects.toThrow('already reserved')
    await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
    expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
    expect(open).toHaveBeenCalledOnce()
    await a.dispose()
    await resources.dispose().catch(() => undefined)
  })

  it('does not replay a failed acquisition for the same live owner', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const close = vi.fn(async () => {})
    const open = vi.fn().mockRejectedValueOnce(new Error('launch failed')).mockResolvedValue({ value: 1, close })
    const resources = new SessionResources<number>(ctx, { label: 'test', exclusive: false, open })
    await expect(resources.get(a.agent)).rejects.toThrow('launch failed')
    await expect(resources.get(a.agent)).rejects.toThrow('launch failed')
    expect(open).toHaveBeenCalledOnce()
    expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
    await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
    expect(close).not.toHaveBeenCalled()
    await a.dispose()
    await resources.dispose().catch(() => undefined)
  })

  it('retains the pin when an in-flight acquisition fails during rollback', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const entered = Promise.withResolvers<undefined>()
    const failed = Promise.withResolvers<never>()
    const resources = new SessionResources(ctx, {
      label: 'test', exclusive: false,
      async open() { entered.resolve(undefined); return failed.promise },
    })
    const acquiring = resources.get(a.agent)
    const rejected = expect(acquiring).rejects.toThrow('launch failed')
    await entered.promise
    const disposing = resources.dispose()
    failed.reject(new Error('launch failed'))
    await rejected
    await expect(disposing).rejects.toThrow('browser cleanup failed')
    expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
    await a.dispose()
    await resources.dispose().catch(() => undefined)
  })

  it('serializes one Session while another proceeds and skips cancelled queued work', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const resources = new SessionResources(ctx, {
      label: 'test', exclusive: false,
      open: async () => ({ value: {}, close: async () => {} }),
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const first = resources.run(a.agent, new AbortController().signal, async () => {
      entered.resolve(undefined)
      await release.promise
      return 1
    })
    await entered.promise
    const abort = new AbortController()
    const queued = vi.fn(async () => 2)
    const second = resources.run(a.agent, abort.signal, queued)
    const rejected = expect(second).rejects.toThrow('cancel queued')
    abort.abort(new Error('cancel queued'))
    expect(await resources.run(b.agent, new AbortController().signal, async () => 3)).toBe(3)
    release.resolve(undefined)
    expect(await first).toBe(1)
    await rejected
    expect(queued).not.toHaveBeenCalled()
    expect(await resources.run(a.agent, new AbortController().signal, async () => 4)).toBe(4)
    await resources.dispose()
  })

  it.each(['get', 'run'] as const)('cancels one %s caller while another waiter retains the same acquisition', async (kind) => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const close = vi.fn(async () => {})
    let acquisitionSignal: AbortSignal | undefined
    const open = vi.fn(async (_agent: Agent, signal: AbortSignal) => {
      acquisitionSignal = signal
      entered.resolve(undefined)
      await release.promise
      return { value: 1, close }
    })
    const resources = new SessionResources(ctx, { label: 'test', exclusive: true, open })
    const controller = new AbortController()
    const execute = vi.fn(async (value: number) => value)
    const acquiring = kind === 'get'
      ? resources.get(a.agent, controller.signal)
      : resources.run(a.agent, controller.signal, execute)
    const canceled = acquiring.catch((error: unknown) => error)
    const retained = resources.get(a.agent, new AbortController().signal).catch((error: unknown) => error)
    try {
      await entered.promise
      controller.abort(new Error('cancel turn'))
      expect(await canceled).toMatchObject({ message: 'cancel turn' })
      expect(acquisitionSignal?.aborted).toBe(false)
      expect(resources.available(b.agent)).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      release.resolve(undefined)
      expect(await retained).toBe(1)
      expect(await resources.get(a.agent)).toBe(1)
      expect(open).toHaveBeenCalledOnce()
    } finally {
      release.resolve(undefined)
      await resources.dispose()
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it('honors caller cancellation between shared readiness and the waiting continuation', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const ready = Promise.withResolvers<undefined>()
    const resources = new SessionResources(ctx, {
      label: 'test', exclusive: false,
      async open() { await ready.promise; return { value: 1, close: async () => {} } },
    })
    const controller = new AbortController()
    const error = new Error('cancel ready waiter')
    const retained = resources.get(a.agent)
    const canceled = resources.get(a.agent, controller.signal).catch((failure: unknown) => failure)
    const abort = retained.then(() => { controller.abort(error) })
    try {
      ready.resolve(undefined)
      await abort
      expect(await canceled).toBe(error)
      expect(await retained).toBe(1)
      expect(await resources.get(a.agent)).toBe(1)
    } finally {
      ready.resolve(undefined)
      await resources.dispose()
    }
  })

  it('retains a late initialization failure and its pin after its only caller canceled', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const ready = Promise.withResolvers<never>()
    const open = vi.fn().mockImplementationOnce(() => ready.promise).mockResolvedValue({ value: 1, close: async () => {} })
    const resources = new SessionResources<number>(ctx, { label: 'test', exclusive: true, open })
    const controller = new AbortController()
    const running = resources.run(a.agent, controller.signal, async value => value)
    controller.abort(new Error('cancel before waiting'))
    await expect(running).rejects.toThrow('cancel before waiting')
    ready.reject(new Error('late browser startup failed'))
    await vi.waitFor(() => { expect(ctx.agents.retention(a.agent)?.leases).toBe(1) })
    expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
    expect(resources.available(b.agent)).toBe(false)
    expect(await resources.get(a.agent).catch((error: unknown) => error)).toMatchObject({ message: 'late browser startup failed' })
    await expect(resources.get(b.agent)).rejects.toThrow('already reserved')
    expect(open).toHaveBeenCalledOnce()
    await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
    await a.dispose()
    await resources.dispose().catch(() => undefined)
  })

  it('reports non-Error cancellation and acquisition failures through cancellable waits', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const entered = Promise.withResolvers<undefined>()
    const ready = Promise.withResolvers<undefined>()
    const open = vi.fn().mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await ready.promise
      return { value: 1, close: async () => {} }
    })
    const resources = new SessionResources<number>(ctx, { label: 'test', exclusive: false, open })
    const controller = new AbortController()
    const waiting = resources.get(a.agent, controller.signal)
    const canceled = expect(waiting).rejects.toMatchObject({ message: 'browser operation canceled', cause: 'stop' })
    await entered.promise
    controller.abort('stop')
    await canceled
    ready.resolve(undefined)
    await resources.dispose()

    const b = await owner('b')
    const failed = new SessionResources<number>(ctx, { label: 'test', exclusive: false, open: vi.fn().mockRejectedValue('failed to connect') })
    await expect(failed.get(b.agent, new AbortController().signal)).rejects.toThrow('failed to connect')
    expect(ctx.agents.retention(b.agent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(b.agent)).toBeUndefined()
    await expect(failed.dispose()).rejects.toThrow('browser cleanup failed')
    await b.dispose()
    await failed.dispose().catch(() => undefined)
  })

  it('closes a late acquisition and waits for its shutdown during racing disposals', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const closeEntered = Promise.withResolvers<undefined>()
    const closeReleased = Promise.withResolvers<undefined>()
    const close = vi.fn(async () => { closeEntered.resolve(undefined); await closeReleased.promise })
    const resources = new SessionResources(ctx, {
      label: 'test', exclusive: false,
      async open() { entered.resolve(undefined); await release.promise; return { value: {}, close } },
    })
    const acquiring = resources.get(a.agent)
    const rejected = expect(acquiring).rejects.toThrow('closing')
    await entered.promise
    const ownerDisposal = a.dispose()
    const providerDisposal = resources.dispose()
    expect(resources.dispose()).toBe(providerDisposal)
    let disposed = false
    void providerDisposal.then(() => { disposed = true })
    release.resolve(undefined)
    await closeEntered.promise
    expect(disposed).toBe(false)
    closeReleased.resolve(undefined)
    await Promise.all([ownerDisposal, providerDisposal, rejected])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('interrupts resources before awaiting an operation that needs close to settle', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const running = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    const resources = new SessionResources(ctx, {
      label: 'test', exclusive: false,
      open: async () => ({ value: {}, close: async () => { stopped.resolve(undefined) } }),
    })
    const call = resources.run(a.agent, new AbortController().signal, async (_resource, signal) => {
      running.resolve(undefined)
      await stopped.promise
      signal.throwIfAborted()
    })
    const rejected = expect(call).rejects.toThrow('closing')
    await running.promise
    await resources.dispose()
    await rejected
  })

  it('retains exclusive ownership when resource shutdown fails', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('a')
    const b = await owner('b')
    const resources = new SessionResources(ctx, {
      label: 'test', exclusive: true,
      open: async () => ({ value: {}, close: async () => { throw new Error('close failed') } }),
    })
    await resources.get(a.agent)
    await a.dispose()
    await expect(resources.get(b.agent)).rejects.toThrow('already reserved')
    await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
    await expect(resources.get(b.agent)).rejects.toThrow('not a live browser owner')
  })
})


it('reports early disposal cleanup failure while retaining the owned resource', async () => {
  const { ctx, owner } = await fixture()
  const a = await owner('early-close-failure')
  const entered = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const warning = vi.spyOn(ctx.logger, 'warn')
  const resources = new SessionResources(ctx, {
    label: 'early-close', exclusive: true,
    open: async () => ({ value: {}, async close() { stopped.resolve(undefined); throw new Error('Close failed') } }),
  })
  const controller = new AbortController()
  const running = resources.run(a.agent, controller.signal, async () => { entered.resolve(undefined); await stopped.promise })
  const canceled = expect(running).rejects.toMatchObject({ kind: 'disposed' })
  await entered.promise
  controller.abort({ kind: 'disposed' })
  await canceled
  await a.dispose()
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('cleanup during Session cancellation failed'))
  await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
  warning.mockRestore()
})

describe('Session browser resource idle reclamation pin', () => {
  it.each(['pending open', 'resident connection', 'closing connection'] as const)(
    'holds the exact-owner lease during %s and releases it only after successful close',
    async (stage) => {
      const { ctx, owner } = await fixture()
      const a = await owner(`pin-${stage}`)
      const entered = Promise.withResolvers<undefined>()
      const openRelease = Promise.withResolvers<undefined>()
      const closeEntered = Promise.withResolvers<undefined>()
      const closeRelease = Promise.withResolvers<undefined>()
      let acquisitionSignal: AbortSignal | undefined
      const close = vi.fn(async () => {
        if (stage !== 'closing connection') return
        closeEntered.resolve(undefined)
        await closeRelease.promise
      })
      const resources = new SessionResources<number>(ctx, {
        label: 'pin',
        exclusive: true,
        async open(_agent, signal) {
          acquisitionSignal = signal
          if (stage === 'pending open') {
            entered.resolve(undefined)
            await openRelease.promise
          }
          return { value: 1, close }
        },
      })
      const acquiring = resources.get(a.agent)
      if (stage === 'pending open') {
        await entered.promise
        expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
        expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
        expect(acquisitionSignal?.aborted).toBe(false)
        openRelease.resolve(undefined)
      }
      expect(await acquiring).toBe(1)

      expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
      expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
      expect(acquisitionSignal?.aborted).toBe(false)

      let disposing: Promise<void>
      if (stage === 'closing connection') {
        disposing = resources.dispose()
        await closeEntered.promise
        expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
        expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
        expect(close).toHaveBeenCalledTimes(1)
        closeRelease.resolve(undefined)
      } else {
        if (stage === 'resident connection') expect(close).not.toHaveBeenCalled()
        disposing = resources.dispose()
      }
      await disposing
      expect(close).toHaveBeenCalledTimes(1)
      expect(ctx.agents.retention(a.agent)?.leases).toBe(0)
      const reclaimable = ctx.agents.sealReclaim(a.agent)
      expect(reclaimable).toBeDefined()
      reclaimable?.abort()
    },
  )

  it.each(['failed open', 'failed close'] as const)(
    'keeps the entry and pin when %s leaves owned or unconfirmed resources',
    async (failure) => {
      const { ctx, owner } = await fixture()
      const a = await owner(`failure-${failure}`)
      const b = await owner(`failure-peer-${failure}`)
      const open = failure === 'failed open'
        ? vi.fn().mockRejectedValue(new Error('browser unavailable'))
        : vi.fn(async () => ({ value: 1, close: async () => { throw new Error('close failed') } }))
      const resources = new SessionResources<number>(ctx, { label: 'failure', exclusive: true, open })
      if (failure === 'failed open') {
        await expect(resources.get(a.agent)).rejects.toThrow('browser unavailable')
        expect(open).toHaveBeenCalledOnce()
        expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
        expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
        expect(resources.available(a.agent)).toBe(true)
        await expect(resources.get(a.agent)).rejects.toThrow('browser unavailable')
        await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
        expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
        expect(open).toHaveBeenCalledOnce()
      } else {
        expect(await resources.get(a.agent)).toBe(1)
        await expect(resources.get(b.agent)).rejects.toThrow('already reserved')
        await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
        expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
        expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
        expect(resources.available(a.agent)).toBe(false)
        expect(open).toHaveBeenCalledOnce()
      }
      await resources.dispose().catch(() => undefined)
      await a.dispose()
    },
  )

  it('keeps idle reclamation blocked when an unknown child close accompanies a rejected open', async () => {
    const { ctx, owner } = await fixture()
    const a = await owner('unconfirmed-close-open')
    let childAlive = false
    const open = vi.fn(async () => {
      childAlive = true
      // The provider's startup rollback could not confirm that its child exited.
      throw new AggregateError(
        [new Error('listTools failed'), new Error('connection close did not confirm child termination')],
        'browser serving startup failed and its child close was not confirmed',
      )
    })
    const resources = new SessionResources<number>(ctx, { label: 'unconfirmed', exclusive: false, open })
    expect(await resources.get(a.agent).catch((error: unknown) => error)).toBeInstanceOf(AggregateError)
    expect(childAlive).toBe(true)
    // The rejection is not proof of rollback: the owner stays pinned against idle reclamation.
    expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
    expect(resources.available(a.agent)).toBe(true)
    // Repeated close attempts report the retained unknown outcome instead of releasing the pin.
    await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
    await expect(resources.dispose()).rejects.toThrow('browser cleanup failed')
    expect(open).toHaveBeenCalledOnce()
    expect(childAlive).toBe(true)
    expect(ctx.agents.retention(a.agent)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(a.agent)).toBeUndefined()
    await a.dispose()
    await resources.dispose().catch(() => undefined)
  })

  it.each(['get', 'run'] as const)(
    'rejects sealed %s before open side effects while available reports false',
    async (method) => {
      const { ctx, owner } = await fixture()
      const a = await owner(`sealed-${method}`)
      const open = vi.fn(async () => ({ value: 1, close: async () => {} }))
      const resources = new SessionResources<number>(ctx, { label: 'sealed', exclusive: false, open })
      const ticket = ctx.agents.sealReclaim(a.agent)
      expect(ticket).toBeDefined()
      expect(resources.available(a.agent)).toBe(false)
      if (method === 'get') {
        await expect(resources.get(a.agent)).rejects.toBeInstanceOf(AgentReclaimingError)
      } else {
        expect(() => resources.run(a.agent, new AbortController().signal, async () => 1)).toThrow(AgentReclaimingError)
      }
      expect(open).not.toHaveBeenCalled()
      expect(ctx.agents.retention(a.agent)?.leases).toBe(0)
      ticket?.abort()
      expect(resources.available(a.agent)).toBe(true)
      await a.dispose()
      await resources.dispose()
    },
  )
})
