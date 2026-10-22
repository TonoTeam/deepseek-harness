/**
 * Agent service: live registry, factory delegation, and process-local
 * initiator scope. Concrete creation and driving belong to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, FiberState, getTraceable, Service, symbols } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isPromise } from 'node:util/types'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { installTurnArchiveAdmission } from './archive-admission.ts'
import type { Agent } from './types.ts'
import type { AgentOptions, SessionStartSource } from './runtime-types.ts'

export * from './runtime-types.ts'
export * from './types.ts'
export type * from './projection.ts'
export * from './consumed-work.ts'
export * from './model-selection.ts'
export { agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from './dispatch.ts'
export type { AgentEventDispatch, AgentSubjectEvent } from './dispatch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

/**
 * Synchronous finalizer returned by unpublished Agent setup when its
 * contributions need validation at the exact publication commit point.
 */
export interface AgentSetupCommit {
  /**
   * Validate and commit the prepared setup immediately before publication.
   * @throws when publication must roll the unpublished Agent back.
   */
  commit(): void
}

/**
 * Compose an unpublished Agent scope and optionally return its publication commit.
 * @param agentCtx - unpublished Agent scope.
 * @param agent - unpublished Agent being composed.
 * @returns an optional synchronous commit invoked after setup awaits settle and immediately before publication.
 */
export type AgentSetup = (
  agentCtx: Context,
  agent: Agent,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

/**
 * Options for programmatically creating an agent through the registry factory
 * ({@link AgentRegistry.create}). The caller supplies the single live
 * `sessionId` shared by the agent registry and session log (e.g. an
 * ACP-generated id), plus optional session metadata (the validated `cwd`, fork
 * lineage); the factory creates the session and agent under that identity.
 */
export interface CreateAgentOptions {
  /** The live agent/session identity. */
  readonly sessionId: SessionId
  /** Live parent Agent for runtime ownership; omit for a root Agent. */
  readonly parentAgent?: Agent
  /**
   * Session creation metadata: validated absolute `cwd`, `parentSession`
   * fork lineage, the `isSeeded` fork marker, the coarse `origin`
   * classification, and the `delegationDepth` recursion budget. Mirrors the
   * `cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it). This is durable session data,
   * so the session boundary validates and snapshots it before asynchronous
   * setup begins.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  /** Exact fork-inherited prefix length when the session metadata sets `isSeeded`. */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Initial replay/fork history, contiguous from seq 0 with lossless-JSON data.
   * A fork supplies an exact parent prefix, its inherited marker, and closers
   * for the open tail. Previously closed steps and turns remain unchanged.
   * The factory validates and snapshots the seed before publication.
   */
  readonly seed?: readonly SessionEvent[]
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal; detached before the returned handle becomes visible. */
  readonly signal?: AbortSignal
  /**
   * Creation-time composition of the agent's scoped world. The factory awaits
   * setup after minting `agentCtx` but BEFORE inserting or announcing either
   * the session or agent, so observers can never see a partially configured
   * world. Setup may return an {@link AgentSetupCommit}; the factory invokes its
   * synchronous `commit()` after every setup await settles and immediately
   * before registry publication. This lets mutable provisioning revalidate at
   * the exact publication boundary. Everything registered through `agentCtx`
   * (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited
   * child plugins) exists before `session/created`, `agent/created`,
   * and the first prompt assembly. A setup
   * throw/rejection, commit throw, or owner disposal rolls the scope back
   * without publishing either id.
   *
   * **Setup composes, it never drives**: the callback is trusted same-process
   * code and receives the full scoped context, so this is a contract rather
   * than a runtime restriction. Drive the agent only after creation resolves.
   */
  readonly setup?: AgentSetup
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
export interface ResumeAgentOptions {
  /** The persisted session id to load and use as the live agent/session identity. */
  readonly resumeSessionId: SessionId
  /** Live parent Agent for runtime ownership; omit for a root Agent. */
  readonly parentAgent?: Agent
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal for persistence load/setup; detached before return. */
  readonly signal?: AbortSignal
  /**
   * Resume-time composition of the agent's fresh scoped world. Persistence is
   * loaded first; the factory then mints `agentCtx` and awaits setup while the
   * reconstructed session and agent remain unpublished. The callback has the
   * same trusted composition-only contract and optional synchronous
   * publication commit as {@link CreateAgentOptions.setup}: all registrations
   * exist before either creation announcement, and rejection, commit failure,
   * or owner disposal rolls the transaction back without publishing either id.
   */
  readonly setup?: AgentSetup
}

/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. The registered factory provider is
 * also a structural owner because the scoped agent depends on that provider's
 * service API; provider unload stops and drains every live handle it made.
 * `dispose()` stops the loop, awaits its exit, unregisters the agent, removes
 * its session from the store, and finally unwinds its scoped world.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; the structural provider
 * reaches the same teardown internally. Config-created agents (the loop's own
 * startup) are owned by the loop fiber and never need a handle.
 */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
  /**
   * Owner-only idle reclamation capability. Supplied only by the native loop
   * factory; absent for providers that cannot prove phase quiescence, in
   * which case callers skip reclamation rather than guess.
   */
  readonly reclaim?: AgentReclaimCapability
}

/**
 * Exact-Agent admission state owned by the registry. `sealed` rejects new
 * work and leases; `quarantined` additionally records an unknown teardown
 * outcome, so owners must not automatically resume or replace the identity.
 */
export type AgentRetentionState = 'open' | 'sealed' | 'quarantined'

/** One authoritative exact-Agent activity snapshot. */
export interface AgentRetention {
  /** Unreleased usage leases. */
  readonly leases: number
  /** Conservative timestamp of the most recent lease release. */
  readonly lastLeaseReleaseAt: number
  /** Admission state for this exact lifecycle. */
  readonly state: AgentRetentionState
  /** Time this snapshot was taken. */
  readonly observedAt: number
}

/** Synchronous exact-Agent usage lease; {@link AgentActivityLease.release} is idempotent. */
export interface AgentActivityLease {
  /**
   * Release this lease exactly once. Further calls are no-ops, including
   * after the owning Agent has left the registry.
   */
  release(): void
}

/**
 * Owner capability that seals one exact lifecycle, evaluates background
 * admission under the seal, flushes persistence, and then runs the ordinary
 * owner teardown. A refused check or failed flush unseals the same live Agent.
 */
export interface AgentReclaimCapability {
  /**
   * True quiescence start: the latest real phase transition to idle, inbox
   * mutation, or usage-lease release. Undefined while any work, pending inbox
   * input, maintenance, publication, or active lease remains.
   * @returns epoch milliseconds of the idle start, or undefined when not idle.
   */
  idleSince(): number | undefined
  /**
   * Atomically seal admission, then evaluate `check` under the seal. A false
   * check or failed flush restores the same live Agent; only an accepted
   * check and a participating durable flush proceed to irreversible teardown.
   * The check receives the seal signal, which aborts when the owner tears the
   * lifecycle down or the caller-supplied {@link AgentReclaimOptions.signal}
   * or timeout fires, so a hung proof or flush cannot hold admission sealed forever.
   * @param check - background-activity proof awaited while admission is sealed.
   * @param options - optional owner abort and timeout bounds for the proof and durable flush.
   * @returns the discriminated outcome; `busy` never tears the Agent down.
   */
  tryReclaim(
    check: (signal: AbortSignal) => Promise<boolean>,
    options?: AgentReclaimOptions,
  ): Promise<AgentReclaimOutcome>
}

/** Optional bounds for the background-activity proof of {@link AgentReclaimCapability.tryReclaim}. */
export interface AgentReclaimOptions {
  /** Owner cancellation; aborting restores the same live Agent's admission. */
  readonly signal?: AbortSignal
  /** Maximum time to await the proof and durable flush; expiry restores admission with a `background` refusal. */
  readonly timeoutMs?: number
}

/**
 * Discriminated owner reclamation result. `persistence` means no durability
 * listener participated, so the session has no claimed recovery point; the
 * same live Agent stays admitted. Teardown errors are thrown instead, as
 * {@link AgentReclaimTeardownError}.
 */
export type AgentReclaimOutcome =
  | { readonly kind: 'reclaimed' }
  | { readonly kind: 'busy'; readonly reason: 'active' | 'leases' | 'background' | 'persistence' }

/** Raised when work or a lease reaches an exact Agent after its admission sealed. */
export class AgentReclaimingError extends Error {
  /** @param id - the sealed Agent identity. */
  constructor(readonly id: SessionId) {
    super(`agent "${id}" is being reclaimed and does not accept new work`)
    this.name = 'AgentReclaimingError'
  }
}

/**
 * Raised after irreversible reclamation teardown fails. The identity is
 * quarantined: its old instance and same-id replacement are unsafe to resume
 * or replace automatically, and an owner must surface the unknown outcome
 * instead of retrying. The original teardown failure is retained as `cause`.
 */
export class AgentReclaimTeardownError extends Error {
  /** Discriminant for owners distinguishing an unknown teardown from a guard refusal. */
  readonly kind = 'unknown-teardown' as const
  /**
   * @param id - the Agent identity whose teardown outcome is unknown.
   * @param cause - the collected teardown failure.
   */
  constructor(readonly id: SessionId, override readonly cause: unknown) {
    super(`agent "${id}" teardown outcome is unknown after reclaim; do not resume or replace automatically`, { cause })
    this.name = 'AgentReclaimTeardownError'
  }
}

/** Registry-owned seal token. `abort` restores admission; `commit` is irreversible. */
export interface AgentReclaimTicket {
  /** Aborted when the owner must stop waiting for the background check. */
  readonly signal: AbortSignal
  /** Restore open admission; a no-op after {@link AgentReclaimTicket.commit} or a second abort. */
  abort(): void
  /** Make the seal irreversible; idempotent. */
  commit(): void
}

/**
 * The agent-creation factory the loop implementation provides to the registry
 * via {@link AgentRegistry.setFactory}. Kept on the `dsh-agent` interface so
 * consumers (e.g. the ACP bridge) program against `ctx.agents` without
 * depending on the concrete `dsh-agent-loop` package.
 */
export interface AgentFactory {
  /**
   * Create a new agent on a caller-supplied session id. Async because creation
   * awaits unpublished setup, invokes its optional synchronous commit, inserts
   * both session and agent, announces session creation, and awaits serial
   * `agent/created` listeners before releasing queued work. The sequence is
   * rollback-covered, but notifications delivered before a later listener
   * failure remain observable; every agent or session creation announcement
   * that began is paired by `agent/disposed` or `session/disposed` during
   * rollback. The owner disposes the resolved handle to stop/drain,
   * unregister, remove the session, and unwind the scope.
   * The registry passes a context carrying the `create()` caller's fiber and
   * scope as `ownerCtx`. The implementation attaches the unpublished
   * transaction and resulting lifecycle to that owner; it must not infer
   * ownership from the factory object's registration context.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, optional live parent, and setup.
   * @returns the owned handle after setup and both creation announcements complete.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Resume an agent on a persisted session. Async because it opens the
   * persisted session for write, reads and repairs the log, publishes it, and
   * awaits the optional unpublished setup transaction; must be called after
   * `ctx.sessionPersistence` exists (consumers inject `sessionPersistence`).
   * Publication follows the same setup-commit and ordered boundary as
   * {@link createAgent}.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, optional live parent, and setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'
const NO_INITIATOR_MESSAGE = 'no initiating agent is active'
const DISPOSED_INITIATOR_MESSAGE = 'agent initiator scope is disposed'

/**
 * Exact-instance admission ledger. The live entry is one referent and a weak
 * registry map is the other, so a detached instance still rejects work without
 * retaining retired lifecycles. It holds no long-lived Agent reference; the
 * in-flight seal is cleared on commit, abort, or detach.
 */
interface AgentAdmission {
  leases: number
  state: AgentRetentionState
  lastLeaseReleaseAt: number
  /** Set when the registry no longer owns this exact lifecycle. */
  closed: boolean
  /** Aborts the in-flight seal when the owner tears this lifecycle down. */
  activeSeal: { abort(): void } | undefined
}

/** All mutable lifecycle state for one exact registry entry. */
interface AgentEntry {
  readonly id: SessionId
  readonly agent: Agent
  /** Runtime creator-agent ownership; independent of durable session lineage. */
  readonly owner: Agent | undefined
  readonly carrier: Scoped<Agent>
  announced: boolean
  announcing: boolean
  detachRequested: boolean
  /** Exact-lifecycle admission ledger, shared only with the weak retired-instance lookup. */
  readonly admission: AgentAdmission
}

/** One tracked boundary plus its inherited nesting chain. */
interface InitiatorRun {
  active: boolean
  readonly parent: InitiatorRun | undefined
}

/** Plain holder prevents Cordis from tracing the factory field before the caller context is known. */
interface FactorySlot {
  readonly target: AgentFactory
}

/**
 * Agent service (`ctx.agents`): tracks live agents and carries the initiating
 * Agent through one process-local asynchronous driver chain. Agent *creation*
 * is provided by whichever plugin implements the {@link AgentFactory}
 * (`@deepseek-ai/dsh-agent-loop`), registered via {@link setFactory}.
 *
 * Initiator methods provide same-process causal attribution only. Ambient
 * presence is neither liveness proof nor authorization; subjects and owners
 * remain explicit, as does identity at worker, process, persistence, and wire
 * boundaries. Returned Promise boundaries drain during teardown, except a
 * nested lineage that starts an owning-fiber unload is excluded from its own drain.
 */
export class AgentRegistry extends Service {
  private store = new Map<SessionId, AgentEntry>()
  /** Weak exact-instance record: detached and same-id-replaced Agents stay rejected without a retired map. */
  private readonly admissions = new WeakMap<Agent, AgentAdmission>()
  private factory: FactorySlot | undefined
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  private activeInitiatorRuns = 0
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  private initiatorDisposal: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'agents')
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('agent', {
        parameter: 'agent',
        wire: 'agentId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
      typeCtx.typert.contexts.registerHost('agent', {
        wire: 'agentId',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resource: 'session',
        resolve: sessionId => this.get(sessionId)?.ctx,
      })
    })
    ctx.on('internal/status', (fiber) => {
      if (fiber.state === FiberState.UNLOADING && this.hasLifecycleAncestor(fiber)) {
        this.closeInitiators()
      }
    })
    ctx.effect(function* (this: AgentRegistry) {
      yield () => this.disposeInitiators()
      yield () => { this.closeInitiators() }
    }.bind(this), 'agents.initiatorLifecycle()')
    // Archive admission: the Workspace registry asks what still runs for a
    // Session before hiding it; a running turn answers here, for every Agent.
    installTurnArchiveAdmission(ctx, sessionId => this.get(sessionId))
  }

  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * Use this optional form for logging, tracing, metrics, or host attribution
   * that also supports agentless calls. When a parent creates a child, setup
   * reports the causal parent while the setup callback's Agent parameter
   * identifies the child.
   * @returns the inherited Agent, or `undefined` outside an initiator boundary
   *   and inside an explicit clearing boundary.
   * @throws when this service instance has been disposed.
   */
  currentInitiator(): Agent | undefined {
    this.assertInitiatorsReadable()
    return this.initiators.getStore()
  }

  /**
   * Read the initiating Agent and fail when no initiator boundary is active.
   * Use this for private helpers contractually below a driver, or for a
   * deployment-owned outbound request whose contract forbids agentless calls.
   * Generic or direct-call paths use optional lookup or explicit request fields.
   * @returns the inherited Agent.
   * @throws when no initiator is active or this service instance has been disposed.
   */
  requireInitiator(): Agent {
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error(NO_INITIATOR_MESSAGE)
    return agent
  }

  /**
   * Run an operation with one exact Agent as its process-local initiator. The
   * exact synchronous value or Promise returned by the operation is preserved.
   * Custom drivers and test harnesses wrap their complete returned foreground
   * lifetime.
   * A queue or wire receiver may establish this boundary only after validating
   * explicit identity and resolving the exact live Agent; this method does neither.
   * Detached work remains owned by the subsystem that starts it.
   * @param agent - initiating Agent to inherit; presence is neither liveness proof nor authorization.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)
  }

  /**
   * Run an operation inside a boundary that hides any inherited initiating
   * Agent. The exact synchronous value or Promise is preserved.
   * Use this while creating lazy shared timers, queue pumps, pool maintenance,
   * watchers, or exporters so they do not inherit the first Agent that happens
   * to initialize them. It clears only initiator attribution, not explicit
   * fields, and does not own or drain detached resources.
   * @param operation - synchronous or asynchronous operation to invoke without an initiator.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withoutInitiator<T>(operation: () => T): T {
    return this.runWithInitiator(undefined, operation)
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). A traced Cordis service is canonicalized to its concrete
   * target; each create/resume call is then traced through that caller's
   * context so ownership follows the caller without stacking proxy layers.
   * Throws if a factory is already registered. Returns the disposer; on
   * dispose the factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      // Avoid stacking two Cordis shadow layers when a caller passes a Service
      // already read through a context. Calls are re-traced through their
      // actual owner context below.
      const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
      this.factory = { target }
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // The exact cordis effect disposer (the agents.register() convention): a
    // caller's composite effect can yield it for in-order teardown; the
    // loop's constructor effect returns it directly, identity-nesting the
    // registration under that effect.
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /** Return the active creation factory. */
  private requireFactory(): FactorySlot {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory
  }

  /**
   * Create and publish a new agent through the registered factory.
   * Distinct from {@link register} (which records an already-constructed
   * agent): this constructs the agent and its session. Rejects if no factory is
   * registered or creation/setup fails. The resolved {@link AgentHandle} lets
   * the owner tear down exactly this agent.
   * @param options - shared identity, optional live parent, session seed/metadata, and agent options.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    // Re-trace a Service-backed factory through the accessing context
    // explicitly. This preserves AgentLoop's dependency origin while binding
    // its effects to ownerCtx; plain factories receive ownerCtx as an explicit
    // capability and need no Cordis tracker magic.
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, optional live parent, configuration, and setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.resume, receiver, [ownerCtx, options])
  }

  /**
   * Register a live agent with source `startup`. Rejects if the id is already registered or a
   * serial `agent/created` listener fails. Emits `agent/disposed`
   * when the calling fiber is disposed — both with the agent's scope carrier
   * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
   * emits are scope-filtered regardless of which context invoked `register`
   * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
   * requires passing the carrier). The entry is a runtime root; factory-backed
   * creation uses `options.parentAgent` for child ownership. Await the registration before using the agent.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the awaitable Cordis effect disposer (single-shot; a repeat call
   *   returns undefined without awaiting an in-flight teardown). Exact
   *   identity is load-bearing: a composite (generator) effect that owns a
   *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
   *   function so Cordis nests the unregistration at that yield position;
   *   yielding a wrapper would leave it disposing as a concurrent sibling on
   *   owner unload, unregistering the agent (and emitting `agent/disposed`)
   *   while its final turn is still draining.
   */
  register(agent: Agent): ReturnType<Context['effect']> {
    return this.ctx.effect(async function* (this: AgentRegistry) {
      yield this.enter(agent, undefined)
      await this.announce(agent, 'startup')
    }.bind(this), 'agents.register()')
  }

  /**
   * Insert an already-constructed agent without announcing it. This is the
   * advanced ordered-lifecycle primitive used by the async agent factory: it
   * first completes setup while the agent is unpublished, then assigns the
   * returned detach closure into its pre-installed composite teardown before
   * calling {@link announce}. Ordinary callers use {@link register}.
   * @param agent - the prepared, unpublished agent.
   * @param owner - explicitly supplied live runtime owner, or
   *   undefined for a top-level runtime root. This is runtime ownership, not
   *   the resumed session's durable parent lineage.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained. When called from a
   *   `agent/created` listener, removal and disposal wait until the serial
   *   creation dispatch settles.
   */
  enter(agent: Agent, owner: Agent | undefined): () => void {
    const id = agent.id
    if (id !== agent.session.id) {
      throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
    }
    const carrier = scopeTarget(agent, agent)
    // This is the authoritative collision boundary. Concurrent create/resume
    // operations may both prepare, but only one exact entry can publish.
    if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    const admission: AgentAdmission = {
      leases: 0,
      state: 'open',
      lastLeaseReleaseAt: 0,
      closed: false,
      activeSeal: undefined,
    }
    const entry: AgentEntry = {
      id,
      agent,
      owner,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
      admission,
    }
    this.store.set(id, entry)
    this.admissions.set(agent, admission)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // Every callback reached by this creation dispatch must observe the same
      // live entry, and disposal must follow creation. A listener may own
      // the advanced detach capability, so make that ordering structural:
      // visibility and the paired disposal are deferred until announce()'s
      // serial dispatch has settled.
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      this.detachEntered(entry)
    }
    return detach
  }

  /** Remove one exact entered agent and emit its paired disposal when announced. */
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    // A stale capability can never delete a later same-id lifecycle. The
    // captured entry identity is the final boundary.
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    entry.admission.closed = true
    entry.admission.activeSeal?.abort()
    entry.admission.activeSeal = undefined
    // An insertion rolled back before announce was never externally created,
    // so emitting disposed would invent an impossible lifecycle edge. Marking
    // happens before the created emit: if a later created listener throws,
    // earlier listeners may already have observed it and must see disposal.
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** Emit the paired disposal edge through the entry's stable carrier. */
  private emitDisposed(entry: AgentEntry): void {
    const args: unknown[] = [entry.carrier, 'agent/disposed', { agent: entry.agent }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @param source - fresh creation, resume, clear, or compaction source.
   * @param signal - optional factory initialization cancellation signal passed to listeners.
   * @returns completion of the serial creation listeners; a listener failure rejects.
   * @throws if `agent` is not the exact live registry entry for its id, or its
   *   creation announcement already began (including a reentrant call from a
   *   creation listener).
   */
  async announce(agent: Agent, source: SessionStartSource, signal?: AbortSignal): Promise<void> {
    const entry = this.store.get(agent.id)
    if (entry === undefined || entry.agent !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    // Mark before dispatch so a listener cannot recursively create a second
    // lifecycle edge; detach still pairs a partially delivered first edge.
    entry.announcing = true
    entry.announced = true
    try {
      await this.ctx.serial(entry.carrier, 'agent/created', {
        agent: entry.agent,
        source,
        ...signal === undefined ? {} : { signal },
      })
    } finally {
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /**
   * Look up a live agent.
   * @param id - the shared agent/session id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: SessionId): Agent | undefined {
    return this.store.get(id)?.agent
  }

  /** Resolve one exact live entry; a same-id replacement never satisfies an old reference. */
  private exactEntry(agent: Agent): AgentEntry | undefined {
    const entry = this.store.get(agent.id)
    return entry?.agent === agent ? entry : undefined
  }

  /**
   * Read the exact-Agent retention accounting. Unknown or replaced instances
   * are not live and therefore report no lifecycle.
   * @param agent - the exact live Agent instance.
   * @returns the authoritative lease/state snapshot, or undefined when not live.
   */
  retention(agent: Agent): AgentRetention | undefined {
    const entry = this.exactEntry(agent)
    if (entry === undefined) return undefined
    const { leases, lastLeaseReleaseAt, state } = entry.admission
    return { leases, lastLeaseReleaseAt, state, observedAt: Date.now() }
  }

  /**
   * Acquire one synchronous exact-Agent usage lease. The lease pins reclamation
   * until it is released; sealed or quarantined identities reject before any
   * caller side effect. Callers that hold no live Agent skip this and skip
   * reclamation eligibility themselves.
   * @param agent - the exact live Agent instance to pin.
   * @returns the idempotent release capability.
   * @throws {@link AgentReclaimingError} when admission is sealed/quarantined,
   *   or when `agent` is not the exact registered instance.
   */
  retain(agent: Agent): AgentActivityLease {
    const entry = this.exactEntry(agent)
    if (entry === undefined) throw new Error(`agent "${agent.id}" is not live in this registry`)
    if (entry.admission.closed || entry.admission.state !== 'open') throw new AgentReclaimingError(entry.id)
    entry.admission.leases += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        // A detached lifecycle discards its accounting with the entry.
        if (this.store.get(entry.id) !== entry) return
        entry.admission.leases -= 1
        entry.admission.lastLeaseReleaseAt = Date.now()
      },
    }
  }

  /**
   * Reject new work reaching a sealed, quarantined, detached, or same-id
   * replaced exact Agent. An Agent with no admission record was never entered
   * by this registry, so unpublished setup keeps its legal pre-publication
   * writes. Detached instances stay rejected through the weak record without a
   * strong retired-reference map.
   * @param agent - the Agent whose admission to check.
   * @throws {@link AgentReclaimingError} when this exact lifecycle does not accept work.
   */
  assertAcceptsWork(agent: Agent): void {
    const admission = this.admissions.get(agent)
    if (admission === undefined) return
    if (admission.closed || admission.state !== 'open') throw new AgentReclaimingError(agent.id)
  }

  /**
   * Atomically seal admission when the exact entry is open and has no usage
   * leases. This is synchronous, so it cannot interleave with retain/work
   * admission inside one event-loop turn.
   * @param agent - the exact live Agent to seal.
   * @returns the seal ticket, or undefined when work/lease accounting forbids it.
   */
  sealReclaim(agent: Agent): AgentReclaimTicket | undefined {
    const entry = this.exactEntry(agent)
    const admission = entry?.admission
    if (entry === undefined || admission === undefined
      || admission.closed || admission.state !== 'open' || admission.leases !== 0) return undefined
    const abort = new AbortController()
    let settled = false
    const seal: AgentReclaimTicket = {
      signal: abort.signal,
      abort: () => {
        if (settled) return
        settled = true
        abort.abort()
        if (admission.activeSeal === seal) admission.activeSeal = undefined
        if (this.store.get(entry.id) === entry && admission.state === 'sealed') {
          admission.state = 'open'
        }
      },
      commit: () => {
        if (settled) return
        settled = true
        if (admission.activeSeal === seal) admission.activeSeal = undefined
      },
    }
    admission.state = 'sealed'
    admission.activeSeal = seal
    return seal
  }

  /**
   * Mark one exact Agent quarantined after an unknown teardown outcome, even
   * when its registry entry is already detached. New work and leases from the
   * old instance reject; the caller must not automatically resume or replace
   * the identity. The weak admission record keeps this state without retaining
   * the Agent.
   * @param agent - the exact Agent whose teardown outcome is unknown.
   */
  quarantine(agent: Agent): void {
    const admission = this.admissions.get(agent)
    if (admission === undefined) return
    admission.state = 'quarantined'
    admission.closed = true
    admission.activeSeal?.abort()
    admission.activeSeal = undefined
  }

  /**
   * Test whether a live agent was created through one exact parent agent's
   * scoped context. Runtime ownership is independent of durable session
   * lineage and remains unambiguous when unrelated providers reuse an id.
   * @param id - the candidate child agent's shared agent/session id.
   * @param owner - the expected runtime creator agent.
   * @returns true only while the exact child entry is live under that owner.
   */
  isOwnedBy(id: SessionId, owner: Agent): boolean {
    return this.store.get(id)?.owner === owner
  }

  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[] {
    return [...this.store.values()].map(entry => entry.agent)
  }

  /**
   * All live top-level agents in registration order. A top-level agent was
   * created without an owning agent context; durable session lineage does not
   * affect this runtime relation, so a resumed fork may still be a root.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  roots(): Agent[] {
    return [...this.store.values()]
      .filter(entry => entry.owner === undefined)
      .map(entry => entry.agent)
  }

  /** Reject new initiator boundaries while inherited continuations drain. */
  private closeInitiators(): void {
    if (this.initiatorState === 'active') this.initiatorState = 'closing'
  }

  /** Wait for returned-Promise boundaries, then invalidate retained references. */
  private disposeInitiators(): Promise<void> {
    return (this.initiatorDisposal ??= (async () => {
      this.closeInitiators()
      this.releaseReentrantInitiatorRuns()
      if (this.activeInitiatorRuns !== 0) {
        this.initiatorDrain ??= Promise.withResolvers<void>()
        await this.initiatorDrain.promise
      }
      this.initiatorState = 'disposed'
      this.initiators.disable()
      this.initiatorRuns.disable()
    })())
  }

  /** Establish one tracked initiator or clearing boundary. */
  private runWithInitiator<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.initiatorState !== 'active') throw new Error(DISPOSED_INITIATOR_MESSAGE)
    const run: InitiatorRun = {
      active: true,
      parent: this.initiatorRuns.getStore(),
    }
    this.activeInitiatorRuns += 1
    let result: T
    try {
      result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      this.releaseInitiatorRun(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        void Promise.prototype.then.call(
          result,
          () => { this.releaseInitiatorRun(run) },
          () => { this.releaseInitiatorRun(run) },
        )
      } catch {
        // A branded Promise may expose a failing @@species. Observer setup did
        // not attach, so preserve the exact return without leaking the run.
        this.releaseInitiatorRun(run)
      }
    } else {
      this.releaseInitiatorRun(run)
    }
    return result
  }

  /** Whether one unloading fiber owns this service's lifecycle. */
  private hasLifecycleAncestor(candidate: Fiber): boolean {
    let fiber = this.ctx.fiber
    while (true) {
      if (fiber === candidate) return true
      const parent = fiber.parent.fiber
      if (parent === fiber) return false
      fiber = parent
    }
  }

  private assertInitiatorsReadable(): void {
    if (this.initiatorState === 'disposed') throw new Error(DISPOSED_INITIATOR_MESSAGE)
  }

  /** Exclude the boundary chain that initiated this teardown from its own drain. */
  private releaseReentrantInitiatorRuns(): void {
    let run = this.initiatorRuns.getStore()
    while (run !== undefined) {
      this.releaseInitiatorRun(run)
      run = run.parent
    }
  }

  private releaseInitiatorRun(run: InitiatorRun): void {
    if (!run.active) return
    run.active = false
    this.activeInitiatorRuns -= 1
    if (this.activeInitiatorRuns !== 0) return
    this.initiatorDrain?.resolve()
    this.initiatorDrain = undefined
  }
}

export default AgentRegistry
