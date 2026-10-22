import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { AgentReclaimingError } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService, { TerminalBackendCleanupError, TerminalError, TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionId as TerminalSessionIdType,
  TerminalSessionStatus,
  TerminalSignal,
} from '@deepseek-ai/dsh-terminal'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()
const ptyServiceDisposers = new WeakMap<Context, () => Promise<void>>()

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  const session = Session.create(id)
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error('missing agent scope')
  await dispose()
}

class StubSession implements TerminalBackendSession {
  readonly motd = 'stub ready'
  readonly pid = 123
  closed: string[] = []
  statusValue: TerminalSessionStatus = { kind: 'running' }
  childAlive = true
  operation: TerminalSendOperation | undefined
  rejectSend = false
  rejectClose = false
  closeGate: PromiseWithResolvers<undefined> | undefined

  startSend(_request: TerminalSendRequest): TerminalSendOperation {
    if (this.rejectSend) {
      return { done: Promise.reject(new Error('send failed')), readOutput: () => ({ delta: '', truncated: false }), cancel: () => false }
    }
    let settle!: () => void
    let settled = false
    const done = new Promise<void>((resolve) => { settle = resolve }).then(() => ({
      viewport: 'done',
      waitReason: 'stdin_read' as const,
      sessionStatus: this.statusValue,
      truncated: false,
    }))
    const operation: TerminalSendOperation = {
      done,
      readOutput: () => ({ delta: 'delta', truncated: false }),
      cancel: () => {
        if (settled) return false
        settled = true
        settle()
        return true
      },
    }
    this.operation = operation
    return operation
  }

  read(request: TerminalReadRequest) {
    return { text: `${request.offset ?? 0}:${request.count ?? 0}`, totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }
  }

  async signal(signal: TerminalSignal) {
    return { delivered: true as const, targetPgid: signal === 'SIGINT' ? 12 : 13 }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  async close(reason: string): Promise<void> {
    this.closed.push(reason)
    if (this.rejectClose) throw new Error('close failed')
    if (this.closeGate !== undefined) await this.closeGate.promise
    this.childAlive = false
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    this.operation?.cancel()
  }
}

function backend(type = 'stub') {
  const sessions: StubSession[] = []
  const provider: TerminalBackend = {
    type,
    async spawn() {
      const session = new StubSession()
      sessions.push(session)
      return session
    },
  }
  return { provider, sessions }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(TerminalSessionService)
  ptyServiceDisposers.set(ctx, async () => { await fiber.dispose() })
  return ctx
}

async function disposeTerminalSessionService(ctx: Context): Promise<void> {
  const dispose = ptyServiceDisposers.get(ctx)
  if (dispose === undefined) throw new Error('missing PTY service fiber')
  await dispose()
}

describe('TerminalSessionService backend registry', () => {
  it('preserves the id brand and disposes exact backend contributions', async () => {
    expectTypeOf(TerminalSessionId('pty-1')).toEqualTypeOf<TerminalSessionIdType>()
    const ctx = await harness()
    const first = backend()
    const dispose = ctx.terminals.registerBackend(first.provider)
    expect(ctx.terminals.listBackends()).toEqual(['stub'])
    expect(() => ctx.terminals.registerBackend(backend().provider)).toThrow(TerminalError)
    const internal = ctx.terminals as unknown as { backends: Map<string, TerminalBackend> }
    internal.backends.set('stub', backend('replacement').provider)
    dispose()
    expect(ctx.terminals.listBackends()).toEqual(['stub'])
    internal.backends.clear()
  })

  it('rejects empty backend types', async () => {
    const ctx = await harness()
    expect(() => ctx.terminals.registerBackend(backend('').provider)).toThrow('must be non-empty')
  })
})

describe('TerminalSessionService ownership and lifecycle', () => {
  it('publishes only after spawn and fences every operation to the exact owner', async () => {
    const ctx = await harness()
    const b = backend()
    ctx.terminals.registerBackend(b.provider)
    const owner = stubAgent(ctx, 'owner')
    const foreign = stubAgent(ctx, 'foreign')
    await ctx.agents.register(owner)
    await ctx.agents.register(foreign)

    const created = await ctx.terminals.spawn(owner, { type: 'stub', name: 'main', cwd: '/tmp' })
    expect(created).toMatchObject({ sessionId: 'pty-1', name: 'main', type: 'stub', pid: 123, motd: 'stub ready', status: { kind: 'running' } })
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    expect(ctx.terminals.list(owner)).toHaveLength(1)
    expect(ctx.terminals.list(foreign)).toEqual([])
    expect(() => ctx.terminals.read(foreign, created.sessionId)).toThrow('belongs to another agent')
    expect(() => ctx.terminals.signal(foreign, created.sessionId, 'SIGINT')).toThrow('belongs to another agent')
    await expect(Promise.resolve().then(() => ctx.terminals.kill(foreign, created.sessionId))).rejects.toThrow('belongs to another agent')
  })

  it('rejects unknown backends, non-live owners, duplicate names, and active sends', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    await expect(ctx.terminals.spawn(owner, { type: 'missing' })).rejects.toMatchObject({ code: 'OWNER_NOT_LIVE' })
    await ctx.agents.register(owner)
    await expect(ctx.terminals.spawn(owner, { type: 'missing' })).rejects.toMatchObject({ code: 'NO_BACKEND' })
    const b = backend()
    ctx.terminals.registerBackend(b.provider)
    const created = await ctx.terminals.spawn(owner, { type: 'stub', name: 'main' })
    await expect(ctx.terminals.spawn(owner, { type: 'stub', name: '' })).rejects.toThrow('must be non-empty')
    const aborted = new AbortController()
    const abortReason = new Error('spawn aborted')
    aborted.abort(abortReason)
    await expect(ctx.terminals.spawn(owner, { type: 'stub' }, aborted.signal)).rejects.toBe(abortReason)
    await expect(ctx.terminals.spawn(owner, { type: 'stub', name: 'main' })).rejects.toMatchObject({ code: 'DUPLICATE_NAME' })

    const operation = ctx.terminals.startSend(owner, created.sessionId, { text: 'echo hi', submit: true })
    expect(() => ctx.terminals.startSend(owner, created.sessionId, { text: 'pwd', submit: true })).toThrow(TerminalError)
    expect(operation.readOutput()).toEqual({ delta: 'delta', truncated: false })
    expect(operation.cancel()).toBe(true)
    await operation.done
    const next = ctx.terminals.startSend(owner, created.sessionId, { text: 'pwd', submit: true })
    next.cancel()
    await next.done

    b.sessions[0]!.rejectSend = true
    await expect(ctx.terminals.startSend(owner, created.sessionId, { text: 'bad', submit: true }).done).rejects.toThrow('send failed')
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('reserves concurrent names and rolls back a spawn whose owner disappears', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<TerminalBackendSession>()
    const session = new StubSession()
    ctx.terminals.registerBackend({ type: 'slow', spawn: () => gate.promise })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const pending = ctx.terminals.spawn(owner, { type: 'slow', name: 'main' })
    await expect(ctx.terminals.spawn(owner, { type: 'slow', name: 'main' })).rejects.toMatchObject({ code: 'DUPLICATE_NAME' })
    const disposal = disposeAgentScope(owner)
    gate.resolve(session)
    await expect(pending).rejects.toMatchObject({ code: 'OWNER_NOT_LIVE' })
    await disposal
    expect(session.closed).toEqual(['PTY spawn rolled back'])
  })

  it('preserves caller cancellation when a pending backend spawn completes', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<TerminalBackendSession>()
    const session = new StubSession()
    ctx.terminals.registerBackend({ type: 'slow', spawn: () => gate.promise })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const controller = new AbortController()
    const reason = new Error('cancelled by caller')

    const pending = ctx.terminals.spawn(owner, { type: 'slow' }, controller.signal)
    controller.abort(reason)
    gate.resolve(session)

    await expect(pending).rejects.toBe(reason)
    expect(session.closed).toEqual(['PTY spawn rolled back'])
    expect(ctx.agents.get(owner.id)).toBe(owner)
  })

  it('preserves caller cancellation and keeps the owner pinned when unpublished rollback fails', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<TerminalBackendSession>()
    const session = new StubSession()
    session.rejectClose = true
    ctx.terminals.registerBackend({ type: 'slow', spawn: () => gate.promise })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const controller = new AbortController()
    const reason = new Error('cancelled by caller')

    const pending = ctx.terminals.spawn(owner, { type: 'slow' }, controller.signal)
    controller.abort(reason)
    gate.resolve(session)

    await expect(pending).rejects.toBe(reason)
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    const internal = ctx.terminals as unknown as { disposeAll(): Promise<void> }
    await expect(internal.disposeAll()).rejects.toThrow('failed to clean up PTY lifecycle')
    // The failed rollback may still own a live child: service teardown reports
    // the failure but cannot prove the child exited, so the exact owner stays pinned.
    expect(ctx.agents.get(owner.id)).toBe(owner)
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    expect(ctx.agents.retention(owner)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(owner)).toBeUndefined()
    expect(session.closed).toEqual(['PTY spawn rolled back'])
  })

  it('preserves caller cancellation when a backend rejects in response to it', async () => {
    const ctx = await harness()
    const started = Promise.withResolvers<undefined>()
    const backendFailure = new Error('backend observed cancellation')
    ctx.terminals.registerBackend({
      type: 'abortable',
      spawn: ({ signal }) => new Promise((_resolve, reject) => {
        if (signal === undefined) throw new Error('missing spawn signal')
        started.resolve(undefined)
        signal.addEventListener('abort', () => { reject(backendFailure) }, { once: true })
      }),
    })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const controller = new AbortController()
    const reason = new Error('cancelled by caller')

    const pending = ctx.terminals.spawn(owner, { type: 'abortable' }, controller.signal)
    await started.promise
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it.each(['owner', 'service'] as const)('retains caller-triggered backend cleanup failure and its owner pin past %s disposal', async (scope) => {
    const ctx = await harness()
    const started = Promise.withResolvers<undefined>()
    const cleanupFailure = new Error('backend cleanup failed')
    ctx.terminals.registerBackend({
      type: 'cleanup-failing',
      spawn: ({ signal }) => new Promise((_resolve, reject) => {
        if (signal === undefined) throw new Error('missing spawn signal')
        started.resolve(undefined)
        signal.addEventListener('abort', () => {
          reject(new TerminalBackendCleanupError(signal.reason, cleanupFailure))
        }, { once: true })
      }),
    })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const controller = new AbortController()
    const reason = new Error('cancelled by caller')

    const pending = ctx.terminals.spawn(owner, { type: 'cleanup-failing' }, controller.signal)
    await started.promise
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    const internal = ctx.terminals as unknown as {
      disposeOwned(owner: Agent): Promise<void>
      disposeAll(): Promise<void>
    }
    const disposal = scope === 'owner' ? internal.disposeOwned(owner) : internal.disposeAll()
    await expect(disposal).rejects.toThrow('failed to clean up PTY lifecycle')
    expect(ctx.agents.get(owner.id)).toBe(owner)
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(true)
    expect(ctx.agents.retention(owner)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(owner)).toBeUndefined()
  })

  it.each([
    { scope: 'owner', code: 'OWNER_NOT_LIVE' },
    { scope: 'service', code: 'SERVICE_DISPOSING' },
  ] as const)('$scope disposal aborts and awaits unpublished backend setup', async ({ scope, code }) => {
    const ctx = await harness()
    const gate = Promise.withResolvers<TerminalBackendSession>()
    const started = Promise.withResolvers<undefined>()
    const session = new StubSession()
    let backendSignal: AbortSignal | undefined
    ctx.terminals.registerBackend({
      type: 'slow',
      spawn: (spec) => {
        backendSignal = spec.signal
        started.resolve(undefined)
        return gate.promise
      },
    })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)

    const pending = ctx.terminals.spawn(owner, { type: 'slow' })
    const pendingFailure = pending.then(
      () => { throw new Error('pending spawn unexpectedly succeeded') },
      (error: unknown) => error,
    )
    await started.promise
    let disposalSettled = false
    const disposal = (scope === 'owner' ? disposeAgentScope(owner) : disposeTerminalSessionService(ctx))
      .then(() => { disposalSettled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    const signalAbortedBeforeRelease = backendSignal?.aborted ?? false
    const signalReasonBeforeRelease: unknown = backendSignal?.reason
    const disposalSettledBeforeRelease = disposalSettled
    gate.resolve(session)

    expect(await pendingFailure).toMatchObject({ code })
    await disposal
    expect(signalAbortedBeforeRelease).toBe(true)
    expect(signalReasonBeforeRelease).toMatchObject({ code })
    expect(disposalSettledBeforeRelease).toBe(false)
    expect(session.closed).toEqual(['PTY spawn rolled back'])
  })

  it('reports unpublished rollback failure through service disposal', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<TerminalBackendSession>()
    const session = new StubSession()
    session.rejectClose = true
    ctx.terminals.registerBackend({ type: 'slow', spawn: () => gate.promise })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)

    const pending = ctx.terminals.spawn(owner, { type: 'slow' })
    const pendingFailure = expect(pending).rejects.toThrow('PTY spawn and rollback both failed')
    const internal = ctx.terminals as unknown as { disposeAll(): Promise<void> }
    const disposalFailure = expect(internal.disposeAll()).rejects.toThrow('failed to clean up PTY lifecycle')
    gate.resolve(session)

    await pendingFailure
    await disposalFailure
    expect(session.closed).toEqual(['PTY spawn rolled back'])
  })

  it.each([
    { scope: 'owner', code: 'OWNER_NOT_LIVE' },
    { scope: 'service', code: 'SERVICE_DISPOSING' },
  ] as const)('$scope disposal retains backend-side startup cleanup failure', async ({ scope, code }) => {
    const ctx = await harness()
    const started = Promise.withResolvers<undefined>()
    const cleanupFailure = new Error('backend cleanup failed')
    let backendAbortReason: unknown
    ctx.terminals.registerBackend({
      type: 'cleanup-failing',
      spawn: ({ signal }) => new Promise((_resolve, reject) => {
        if (signal === undefined) throw new Error('missing spawn signal')
        started.resolve(undefined)
        signal.addEventListener('abort', () => {
          backendAbortReason = signal.reason
          reject(new TerminalBackendCleanupError(signal.reason, cleanupFailure))
        }, { once: true })
      }),
    })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)

    const pending = ctx.terminals.spawn(owner, { type: 'cleanup-failing' })
    await started.promise
    const internal = ctx.terminals as unknown as {
      disposeOwned(owner: Agent): Promise<void>
      disposeAll(): Promise<void>
    }
    const disposal = scope === 'owner' ? internal.disposeOwned(owner) : internal.disposeAll()
    const pendingError = await pending.then(
      () => { throw new Error('pending spawn unexpectedly succeeded') },
      (error: unknown) => error,
    )

    expect(pendingError).toBe(backendAbortReason)
    expect(pendingError).toMatchObject({ code })
    const disposalError = await disposal.then(
      () => { throw new Error('disposal unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(disposalError).toMatchObject({ message: 'failed to clean up PTY lifecycle' })
    const rollbackError: unknown = (disposalError as AggregateError).errors[0]
    const cleanupErrors = (rollbackError as AggregateError).errors as unknown[]
    expect(cleanupErrors).toEqual([cleanupFailure])
  })

  it('keeps independent reservations and handles provider failure before publication', async () => {
    const ctx = await harness()
    const firstGate = Promise.withResolvers<TerminalBackendSession>()
    const secondGate = Promise.withResolvers<TerminalBackendSession>()
    let count = 0
    ctx.terminals.registerBackend({
      type: 'slow',
      spawn: () => ++count === 1 ? firstGate.promise : secondGate.promise,
    })
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const first = ctx.terminals.spawn(owner, { type: 'slow', name: 'one' })
    const second = ctx.terminals.spawn(owner, { type: 'slow', name: 'two' })
    firstGate.resolve(new StubSession())
    await first
    secondGate.resolve(new StubSession())
    await second

    ctx.terminals.registerBackend({ type: 'throwing', spawn: () => Promise.reject(new Error('provider failed')) })
    await expect(ctx.terminals.spawn(owner, { type: 'throwing' })).rejects.toThrow('provider failed')

    const controller = new AbortController()
    const b = backend('signaled')
    ctx.terminals.registerBackend(b.provider)
    await ctx.terminals.spawn(owner, { type: 'signaled' }, controller.signal)
  })

  it('omits optional pid metadata when a backend has no process id', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const session = new StubSession()
    Object.defineProperty(session, 'pid', { value: undefined })
    ctx.terminals.registerBackend({ type: 'virtual', spawn: () => Promise.resolve(session) })
    expect(await ctx.terminals.spawn(owner, { type: 'virtual' })).not.toHaveProperty('pid')
  })

  it('reports rollback and close failures without publishing false success', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const failedSpawn = new StubSession()
    failedSpawn.rejectClose = true
    let ownerDisposal = Promise.resolve()
    const internal = ctx.terminals as unknown as {
      disposedOwners: WeakSet<Agent>
      disposeOwned(owner: Agent): Promise<void>
    }
    ctx.terminals.registerBackend({
      type: 'bad-spawn',
      async spawn({ signal }) {
        if (signal === undefined) throw new Error('missing spawn signal')
        internal.disposedOwners.add(owner)
        ownerDisposal = internal.disposeOwned(owner)
        if (!signal.aborted) {
          await new Promise<undefined>((resolve) => {
            signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
          })
        }
        return failedSpawn
      },
    })
    await expect(ctx.terminals.spawn(owner, { type: 'bad-spawn' })).rejects.toThrow('spawn and rollback both failed')
    await expect(ownerDisposal).rejects.toThrow('failed to clean up PTY lifecycle')

    const nextOwner = stubAgent(ctx, 'next')
    await ctx.agents.register(nextOwner)
    const b = backend('bad-close')
    ctx.terminals.registerBackend(b.provider)
    const created = await ctx.terminals.spawn(nextOwner, { type: 'bad-close' })
    b.sessions[0]!.rejectClose = true
    await expect(ctx.terminals.kill(nextOwner, created.sessionId)).rejects.toThrow('close failed')
    expect(ctx.terminals.list(nextOwner)).toHaveLength(1)
  })

  it('joins an already-running close and refuses new sends while closing', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const b = backend()
    ctx.terminals.registerBackend(b.provider)
    const created = await ctx.terminals.spawn(owner, { type: 'stub' })
    b.sessions[0]!.closeGate = Promise.withResolvers<undefined>()
    const first = ctx.terminals.kill(owner, created.sessionId)
    expect(() => ctx.terminals.startSend(owner, created.sessionId, { text: '', submit: false })).toThrow('closing')
    const second = ctx.terminals.kill(owner, created.sessionId)
    b.sessions[0]!.closeGate?.resolve(undefined)
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(() => ctx.terminals.read(owner, created.sessionId)).toThrow('unknown PTY')
  })

  it('awaits owner cleanup and removes sessions while backend registration may reload', async () => {
    const ctx = await harness()
    const b = backend()
    const disposeBackend = ctx.terminals.registerBackend(b.provider)
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    const created = await ctx.terminals.spawn(owner, { type: 'stub' })
    disposeBackend()
    expect(ctx.terminals.listBackends()).toEqual([])
    expect(ctx.terminals.read(owner, created.sessionId).text).toBe('0:0')

    await disposeAgentScope(owner)
    expect(b.sessions[0]?.closed).toEqual(['PTY owner disposed'])
    expect(ctx.terminals.list(owner)).toEqual([])
  })

  it('kills idempotently and service disposal closes all owners', async () => {
    const ctx = await harness()
    const b = backend()
    ctx.terminals.registerBackend(b.provider)
    const first = stubAgent(ctx, 'first')
    const second = stubAgent(ctx, 'second')
    await ctx.agents.register(first)
    await ctx.agents.register(second)
    const a = await ctx.terminals.spawn(first, { type: 'stub' })
    await ctx.terminals.spawn(second, { type: 'stub' })
    expect(await ctx.terminals.kill(first, a.sessionId)).toBe(true)
    expect(b.sessions[0]?.closed).toEqual(['model request'])

    const service = ctx.terminals
    await disposeTerminalSessionService(ctx)
    expect(b.sessions[1]?.closed).toEqual(['PTY service disposed'])
    await expect(service.spawn(first, { type: 'stub' })).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
  })

  it('aggregates service-disposal close failures after attempting every record', async () => {
    const ctx = await harness()
    const service = ctx.terminals
    const b = backend()
    ctx.terminals.registerBackend(b.provider)
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    await ctx.terminals.spawn(owner, { type: 'stub' })
    b.sessions[0]!.rejectClose = true
    const internal = service as unknown as {
      sessions: Map<TerminalSessionIdType, unknown>
      closeRecords(records: unknown[], reason: string): Promise<void>
    }
    const records = [...internal.sessions.values()]
    const firstFailure = expect(internal.closeRecords(records, 'test failure')).rejects.toThrow('failed to close 1 PTY session')
    const joinedFailure = expect(internal.closeRecords(records, 'joined failure')).rejects.toThrow('failed to close 1 PTY session')
    await firstFailure
    await joinedFailure
    b.sessions[0]!.rejectClose = false
    await expect(internal.closeRecords([...internal.sessions.values()], 'retry')).resolves.toBeUndefined()
    expect(b.sessions[0]!.closed).toEqual(['test failure', 'retry'])
    expect(internal.sessions.size).toBe(0)
    await disposeTerminalSessionService(ctx)
    await expect(service.spawn(owner, { type: 'stub' })).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
  })

  it('clears registries and runs owner cleanups even when a session close fails', async () => {
    const ctx = await harness()
    const service = ctx.terminals
    const b = backend()
    service.registerBackend(b.provider)
    const owner = stubAgent(ctx, 'owner')
    await ctx.agents.register(owner)
    await service.spawn(owner, { type: 'stub' })
    b.sessions[0]!.rejectClose = true
    const internal = service as unknown as {
      disposeAll(): Promise<void>
      backends: Map<string, unknown>
      ownerCleanups: Map<Agent, unknown>
    }
    // Teardown surfaces the close failure, but its finally still clears the
    // backend and owner-cleanup registries instead of orphaning them.
    await expect(internal.disposeAll()).rejects.toThrow('failed to clean up PTY lifecycle')
    expect(internal.backends.size).toBe(0)
    expect(internal.ownerCleanups.size).toBe(0)
  })
})

describe('TerminalSessionService idle reclamation pin', () => {
  it.each(['pending', 'resident', 'closing'] as const)(
    'refuses reclamation while a %s spawn/session is live and leaves backend cancellation to explicit kill',
    async (stage) => {
      const ctx = await harness()
      const owner = stubAgent(ctx, `owner-${stage}`)
      await ctx.agents.register(owner)
      const session = new StubSession()
      let backendSignal: AbortSignal | undefined
      const gate = Promise.withResolvers<TerminalBackendSession>()
      const spawn = vi.fn((spec: { signal?: AbortSignal }) => {
        backendSignal = spec.signal
        return stage === 'pending' ? gate.promise : Promise.resolve(session)
      })
      ctx.terminals.registerBackend({ type: 'gated', spawn })

      const created = ctx.terminals.spawn(owner, { type: 'gated' })
      let id: TerminalSessionIdType | undefined
      if (stage === 'pending') {
        await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce() })
        expect(backendSignal?.aborted).toBe(false)
      } else {
        id = (await created).sessionId
      }
      expect(ctx.agents.retention(owner)?.leases).toBe(1)
      expect(ctx.agents.sealReclaim(owner)).toBeUndefined()
      expect(backendSignal?.aborted).toBe(false)

      if (stage === 'pending') {
        gate.resolve(session)
        id = (await created).sessionId
        expect(await ctx.terminals.kill(owner, id, 'model request')).toBe(true)
      } else if (stage === 'closing') {
        session.closeGate = Promise.withResolvers<undefined>()
        const closing = ctx.terminals.kill(owner, id!, 'model request')
        await vi.waitFor(() => { expect(session.closed).toEqual(['model request']) })
        expect(() => ctx.terminals.startSend(owner, id!, { text: '', submit: false })).toThrow('closing')
        expect(ctx.agents.retention(owner)?.leases).toBe(1)
        expect(ctx.agents.sealReclaim(owner)).toBeUndefined()
        expect(session.closed).toEqual(['model request'])
        session.closeGate.resolve(undefined)
        await closing
      } else {
        expect(session.closed).toEqual([])
        expect(await ctx.terminals.kill(owner, id!, 'model request')).toBe(true)
      }

      // The real resource close is the only release point; a sealed owner then admits reclaim.
      expect(session.closed).toEqual(['model request'])
      expect(ctx.agents.retention(owner)?.leases).toBe(0)
      const ticket = ctx.agents.sealReclaim(owner)
      expect(ticket).toBeDefined()
      ticket?.abort()
      await disposeTerminalSessionService(ctx)
    },
  )

  it.each(['confirmed rollback', 'unknown owner cleanup', 'unknown service cleanup'] as const)(
    'resolves a failed startup after %s without releasing an unconfirmed owner pin',
    async (outcome) => {
      const ctx = await harness()
      const owner = stubAgent(ctx, `startup-${outcome}`)
      await ctx.agents.register(owner)
      const cleanupFailure = new Error('backend cleanup failed')
      const rollback = new StubSession()
      const gate = Promise.withResolvers<TerminalBackendSession>()
      const controller = new AbortController()
      ctx.terminals.registerBackend({
        type: 'failing',
        spawn: async ({ signal }) => {
          if (outcome !== 'confirmed rollback') {
            throw new TerminalBackendCleanupError(new Error('startup failed'), cleanupFailure)
          }
          gate.resolve(rollback)
          if (signal === undefined) throw new Error('missing spawn signal')
          await new Promise<undefined>((resolve) => {
            signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
          })
          controller.abort(new Error('cancelled during startup'))
          return rollback
        },
      })

      const pending = ctx.terminals.spawn(owner, { type: 'failing' }, controller.signal)
      if (outcome === 'confirmed rollback') {
        await vi.waitFor(() => { expect(ctx.agents.retention(owner)?.leases).toBe(1) })
        controller.abort(new Error('cancelled during startup'))
        await expect(pending).rejects.toThrow('cancelled during startup')
        expect(rollback.closed).toEqual(['PTY spawn rolled back'])
        expect(ctx.terminals.hasOwnerActivity(owner)).toBe(false)
        expect(ctx.agents.retention(owner)?.leases).toBe(0)
        const reclaimable = ctx.agents.sealReclaim(owner)
        expect(reclaimable).toBeDefined()
        reclaimable?.abort()
        await disposeTerminalSessionService(ctx)
        return
      }

      await expect(pending).rejects.toBeInstanceOf(TerminalBackendCleanupError)
      const service = ctx.terminals
      expect(service.hasOwnerActivity(owner)).toBe(true)
      expect(ctx.agents.retention(owner)?.leases).toBe(1)
      expect(ctx.agents.sealReclaim(owner)).toBeUndefined()
      if (outcome === 'unknown owner cleanup') {
        const internal = service as unknown as { disposeOwned(owner: Agent): Promise<void> }
        await expect(internal.disposeOwned(owner)).rejects.toThrow('failed to clean up PTY lifecycle')
      }
      // Service teardown reports the unknown cleanup but cannot prove the child
      // exited, so the exact owner pin must survive both teardown scopes.
      await disposeTerminalSessionService(ctx)
      expect(ctx.agents.get(owner.id)).toBe(owner)
      expect(service.hasOwnerActivity(owner)).toBe(true)
      expect(ctx.agents.retention(owner)?.leases).toBe(1)
      expect(ctx.agents.sealReclaim(owner)).toBeUndefined()
    },
  )

  it('keeps the owner pin while a failed close leaves the backend session alive', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'close-failure')
    await ctx.agents.register(owner)
    const b = backend('close-failure')
    ctx.terminals.registerBackend(b.provider)
    const created = await ctx.terminals.spawn(owner, { type: 'close-failure' })
    const session = b.sessions[0]!
    session.rejectClose = true

    await expect(ctx.terminals.kill(owner, created.sessionId, 'model request')).rejects.toThrow('close failed')
    expect(ctx.terminals.list(owner)).toHaveLength(1)
    expect(session.childAlive).toBe(true)
    expect(ctx.agents.retention(owner)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(owner)).toBeUndefined()

    session.rejectClose = false
    expect(await ctx.terminals.kill(owner, created.sessionId, 'model request retry')).toBe(true)
    expect(session.childAlive).toBe(false)
    expect(session.closed).toEqual(['model request', 'model request retry'])
    expect(ctx.agents.retention(owner)?.leases).toBe(0)
    const reclaimable = ctx.agents.sealReclaim(owner)
    expect(reclaimable).toBeDefined()
    reclaimable?.abort()
    await disposeTerminalSessionService(ctx)
  })

  it.each(['owner', 'service'] as const)('keeps the exact-owner pin after %s teardown hits an unknown close failure', async (scope) => {
    const ctx = await harness()
    const service = ctx.terminals
    const owner = stubAgent(ctx, `teardown-${scope}`)
    await ctx.agents.register(owner)
    const b = backend('teardown-failure')
    ctx.terminals.registerBackend(b.provider)
    const created = await ctx.terminals.spawn(owner, { type: 'teardown-failure' })
    const session = b.sessions[0]!
    session.rejectClose = true
    const internal = service as unknown as { disposeOwned(owner: Agent): Promise<void> }

    if (scope === 'owner') {
      await expect(internal.disposeOwned(owner)).rejects.toThrow('failed to clean up PTY lifecycle')
    } else {
      // Cordis logs and swallows a service-fiber disposer failure; retaining
      // the lease is the only guard when the plugin unload cannot close the child.
      await disposeTerminalSessionService(ctx)
    }
    expect(ctx.agents.get(owner.id)).toBe(owner)
    expect(service.list(owner)).toHaveLength(1)
    expect(session.childAlive).toBe(true)
    expect(session.status()).toEqual({ kind: 'running' })
    expect(ctx.agents.retention(owner)?.leases).toBe(1)
    expect(ctx.agents.sealReclaim(owner)).toBeUndefined()

    // A confirmed close is the only release point.
    session.rejectClose = false
    expect(await service.kill(owner, created.sessionId, 'teardown retry')).toBe(true)
    expect(session.childAlive).toBe(false)
    expect(ctx.agents.retention(owner)?.leases).toBe(0)
    const reclaimable = ctx.agents.sealReclaim(owner)
    expect(reclaimable).toBeDefined()
    reclaimable?.abort()
    await disposeTerminalSessionService(ctx)
  })

  it('rejects sealed acquisition before backend spawn', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'sealed')
    await ctx.agents.register(owner)
    const spawn = vi.fn(async () => new StubSession())
    ctx.terminals.registerBackend({ type: 'sealed', spawn })

    const ticket = ctx.agents.sealReclaim(owner)
    expect(ticket).toBeDefined()
    await expect(ctx.terminals.spawn(owner, { type: 'sealed' })).rejects.toBeInstanceOf(AgentReclaimingError)
    expect(spawn).not.toHaveBeenCalled()
    expect(ctx.terminals.hasOwnerActivity(owner)).toBe(false)
    expect(ctx.agents.retention(owner)?.leases).toBe(0)
    ticket?.abort()
    await disposeTerminalSessionService(ctx)
  })
})
