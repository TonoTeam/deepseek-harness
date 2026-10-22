/** Agent activation, composition, and model-selection policy owned by API Session. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import {
  AgentReclaimTeardownError,
  AgentReclaimingError,
} from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentActivityLease, AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions,
  ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError, remoteErrorOf, type TypertBorrowedValue } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { ModelSelection } from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Reuse of a Session named an Agent preset while the deployment composes no preset roster. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
  ) {
    super(`the deployment composes no agent preset roster, so session "${sessionId}" cannot run preset "${requestedPreset}"`)
  }
}

/** A blank Session chosen for reuse started a turn before this Host acquired its writer. */
class ApiSessionStartedSinceObserved extends Error {}

/** Placement and Agent preset for one Session created for a new conversation. */
export interface ApiSessionCreateRequest {
  /** Blank Session to reuse, or the identity of a new Session when none is stored under it. */
  readonly sessionId?: SessionId
  /** Directory the Session owns. */
  readonly cwd: string
  /** Preset the Session runs; the configured default when omitted. */
  readonly agentPreset?: string
  /**
   * Placement rule the caller owns, such as Workspace membership and archive state.
   * @param sessionId - existing Session named by the request.
   * @returns whether that Session may be reused.
   */
  readonly reusable: (sessionId: SessionId) => boolean
}

/** The Session one creation request created or reused. */
export interface ApiSessionCreated {
  /** Live Agent of the Session. */
  readonly agent: Agent
  /** Preset the Session ran when the request finished, before a later request for the same identity; absent without a roster. */
  readonly agentPreset: string | undefined
}

/** Published forked Agent plus the creator-held lease for its post-create lifetime. */
export interface ApiForkedAgent {
  /** Published child Agent. */
  readonly agent: Agent
  /** Release the creator-held usage lease; idempotent, and the tracked handle stays reclaimable afterwards. */
  readonly release: () => void
}

/** Resolved preset and pre-publication Agent setup for one create or resume. */
interface ApiSessionComposition {
  readonly agentPreset?: string
  readonly setup: AgentSetup
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

/**
 * Opt-in idle reclamation policy for creator-owned ordinary API Agents.
 * Upstream stays disabled; a deployment enables it with explicit bounds.
 */
export interface ApiIdleEvictionConfig {
  /** Whether the bounded sweep runs at all; disabled by default. */
  readonly enabled: boolean
  /** Real quiescence time before an idle Agent becomes a reclaim candidate. */
  readonly idleTtlMs: number
  /** Delay between bounded, non-overlapping sweeps. */
  readonly sweepPeriodMs: number
  /** Maximum candidates examined by one sweep. */
  readonly maxPerSweep: number
  /** Maximum time the read-only activity proof may keep admission sealed. */
  readonly reclaimTimeoutMs: number
}

/** Default idle policy bounds: ten minutes idle, one-minute sweeps, eight candidates. */
export const DEFAULT_API_IDLE_EVICTION: ApiIdleEvictionConfig = Object.freeze({
  enabled: false,
  idleTtlMs: 600_000,
  sweepPeriodMs: 60_000,
  maxPerSweep: 8,
  reclaimTimeoutMs: 5_000,
})

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly claims = new Map<SessionId, Promise<void>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()
  /** Full creator-owned handles, never only their Agent, so reclamation keeps the capability. */
  private readonly handles = new Map<SessionId, AgentHandle>()
  /** Identities currently sealed for reclamation; new acquisitions wait here. */
  private readonly retiring = new Map<SessionId, Promise<void>>()
  /** Unknown teardown outcomes block automatic resume/replacement until an operator acts. */
  private readonly quarantined = new Map<SessionId, AgentReclaimTeardownError>()
  private policy: ApiIdleEvictionConfig | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private sweeping = false
  private disposed = false
  /** Rotating start position so blocked candidates cannot starve later ones. */
  private sweepCursor = 0
  /** Owner shutdown signal handed to every in-flight reclamation check. */
  private readonly shutdown = new AbortController()

  /**
   * @param ctx - Host context carrying Agent, model, persistence, and Typert services.
   * @param idleEviction - opt-in idle policy; omitted keeps reclamation disabled.
   */
  constructor(private readonly ctx: Context, idleEviction?: ApiIdleEvictionConfig) {
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    }, this.borrower(agent => agent))
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    }, this.borrower(agent => agent.session))
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    }, this.borrower(agent => agent.ctx))
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.handles.get(agent.id)?.agent === agent) this.handles.delete(agent.id)
    })
    if (idleEviction !== undefined) this.startIdleEviction(idleEviction)
    ctx.effect(() => () => { this.disposeIdleEviction() }, 'session-controller.idle-eviction')
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const quarantine = this.quarantined.get(sessionId)
    if (quarantine !== undefined) return { error: this.quarantineError(sessionId) }
    await this.waitRetiring(sessionId)
    if (this.quarantined.has(sessionId)) return { error: this.quarantineError(sessionId) }
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Create a Session for a new conversation, reusing the named blank Session
   * while it is still reusable. A reused Session runs the requested preset, or
   * the configured default when the request names none; the preset it recorded
   * is not resolved, and a change is logged as `agent-preset/selected` before
   * the Agent is published. A named Session that has started a turn, fails the
   * caller's placement rule, or is written by another owner stays unchanged,
   * and a new Session is created instead. Requests naming one identity run in
   * arrival order, including their preset resolution, and check the named
   * Session's directory and ownership before resolving the preset.
   * @param request - optional Session to reuse, directory, preset, and placement rule.
   * @returns the reused or created Session and the preset it ran when this request finished.
   * @throws ApiSessionCwdConflict when the named Session belongs to another directory.
   * @throws ApiSessionSubagentOwnership when subagent routing owns the named Session.
   * @throws RemoteError `agent-preset/not-found` or `agent-preset/invalid` for the requested or default preset.
   * @throws ApiSessionPresetConflict when no roster is composed and the request names a preset for a reused Session.
   */
  async createSession(request: ApiSessionCreateRequest): Promise<ApiSessionCreated> {
    const named = request.sessionId
    if (named === undefined) return this.created(await this.createMinted(request.cwd, await this.composeAgent(request.agentPreset)))
    this.assertNotQuarantined(named)
    return this.inOrder(named, async () => this.created(await this.claim(named, request)))
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort the adapter defaulted is not a conversation choice: restoring
          // it as one would make an unchanged default read as a request change.
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<ApiSessionComposition> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })
    this.track(handle)
    return handle.agent
  }

  private async inOrder<Value>(sessionId: SessionId, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.claims.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.claims.set(sessionId, settled)
    try {
      return await result
    } finally {
      if (this.claims.get(sessionId) === settled) this.claims.delete(sessionId)
    }
  }

  /** @returns the reused Session, a new Session under `sessionId` when none is stored, or a new Session under a minted identity. */
  private async claim(sessionId: SessionId, request: ApiSessionCreateRequest): Promise<Agent> {
    this.assertNotQuarantined(sessionId)
    await this.waitRetiring(sessionId)
    this.assertNotQuarantined(sessionId)
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) {
      if (live.session.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(live.id, request.cwd, live.session.header.cwd)
      }
      const composition = await this.composeAgent(request.agentPreset)
      return await this.reuseLive(live, request, composition) ?? this.createMinted(request.cwd, composition)
    }
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error: unknown) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      return this.createAgent(sessionId, request.cwd, await this.composeAgent(request.agentPreset))
    }
    let reusable: boolean
    {
      using observed = observation
      if (hasApiSessionSubagentOwner(this.ctx, { header: observed.header }, undefined)) {
        throw new ApiSessionSubagentOwnership(sessionId)
      }
      if (observed.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(sessionId, request.cwd, observed.header.cwd)
      }
      reusable = request.reusable(sessionId) && !observed.events.some(event => event.type === 'turn/start')
    }
    const composition = await this.composeAgent(request.agentPreset)
    if (!reusable) return this.createMinted(request.cwd, composition)
    this.assertPresetApplicable(sessionId, request.agentPreset)
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: this.reuseSetup(composition),
      })
      this.track(handle)
      return handle.agent
    } catch (error: unknown) {
      if (error instanceof ApiSessionStartedSinceObserved) return this.createMinted(request.cwd, composition)
      if (!(error instanceof Error) || error.name !== 'SessionAlreadyOwnedError') throw error
      // Another resume in this process may hold the writer for the Agent it published.
      return this.ctx.agents.get(sessionId) === undefined
        ? this.createMinted(request.cwd, composition)
        : this.claim(sessionId, request)
    }
  }

  /** @returns the live blank Session under the requested preset, or undefined when it cannot be reused. */
  private async reuseLive(
    live: Agent,
    request: ApiSessionCreateRequest,
    composition: ApiSessionComposition,
  ): Promise<Agent | undefined> {
    if (!request.reusable(live.id) || !this.isBlank(live.session)) return undefined
    this.assertPresetApplicable(live.id, request.agentPreset)
    const current = this.presetForSession(live.session)
    const presets = this.ctx.get('agentPresets')
    const target = composition.agentPreset
    if (presets === undefined || target === undefined || target === current) return live
    try {
      await presets.select(live, target)
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code !== 'agent-preset/locked') throw error
      return undefined
    }
    return live
  }

  /** Setup that re-checks blankness under the acquired writer, then records a preset change before publication. */
  private reuseSetup(composition: ApiSessionComposition): AgentSetup {
    return async (agentCtx, agent) => {
      if (!this.isBlank(agent.session)) throw new ApiSessionStartedSinceObserved()
      const commit = await composition.setup(agentCtx, agent)
      const target = composition.agentPreset
      if (target !== undefined && this.presetForSession(agent.session) !== target) {
        agent.session.append('agent-preset/selected', { agentPreset: target })
      }
      return commit
    }
  }

  /** Whether no turn has started, by the predicate the preset registry's `select` enforces. */
  private isBlank(session: Session): boolean {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
  }

  /**
   * Whether the Session has at least one closed turn whose latest step also
   * closed. A blank Session, an open turn, or a step still in progress has no
   * complete persisted turn to recover, so reclamation defers.
   */
  private hasCompletedTurn(session: Session): boolean {
    if (this.isBlank(session)) return false
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    return boundary !== undefined
      && boundary.openTurnStartSeq === null
      && boundary.lastTurn > 0
      && boundary.lastStepBoundary?.kind === 'end'
  }

  /** Without a roster, reuse cannot apply a named preset. */
  private assertPresetApplicable(sessionId: SessionId, requested: string | undefined): void {
    if (requested === undefined || this.ctx.get('agentPresets') !== undefined) return
    throw new ApiSessionPresetConflict(sessionId, requested)
  }

  private created(agent: Agent): ApiSessionCreated {
    return { agent, agentPreset: this.presetForSession(agent.session) }
  }

  private createMinted(cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    return this.createAgent(brandString<SessionId>(`session-${randomUUID()}`), cwd, composition)
  }

  /**
   * Create one forked child and retain its full creator-owned handle.
   * Fork composes its seeded child directly instead of using the ordinary
   * create/resume claim path; this method adds the returned handle to the same
   * idle policy without a second create or resume. The exact child keeps one
   * creator usage lease from publication through the caller's post-create
   * work, so quiescence cannot reclaim it while that work is pending.
   * @param options - complete seeded creation options for the child.
   * @returns the published forked Agent and its creator-held lease.
   */
  async createForkedAgent(options: CreateAgentOptions): Promise<ApiForkedAgent> {
    const handle = await this.ctx.agents.create(options)
    this.track(handle)
    // Acquire immediately after publication; a failure here keeps the handle
    // tracked so a later sweep can reclaim it.
    const lease = this.ctx.agents.retain(handle.agent)
    return { agent: handle.agent, release: () => { lease.release() } }
  }

  private async createAgent(sessionId: SessionId, cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })
    this.track(handle)
    return handle.agent
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  private track(handle: AgentHandle): void {
    this.handles.set(handle.agent.id, handle)
  }

  private quarantineError(sessionId: SessionId): ApiSessionAgentError {
    return new RemoteError(
      'gateway/internal',
      `session "${sessionId}" is quarantined after an unknown reclamation teardown; operator action is required`,
      { sessionId, reason: 'unknown-teardown' },
    )
  }

  private assertNotQuarantined(sessionId: SessionId): void {
    if (this.quarantined.has(sessionId)) throw this.quarantineError(sessionId)
  }

  private async waitRetiring(sessionId: SessionId): Promise<void> {
    for (;;) {
      const retiring = this.retiring.get(sessionId)
      if (retiring === undefined) return
      await retiring.catch(() => undefined)
    }
  }

  private borrower<Value>(read: (agent: Agent) => Value) {
    return async (sessionId: SessionId): Promise<TypertBorrowedValue<Value>> => {
      const acquired = await this.acquireRetained(sessionId)
      return {
        value: read(acquired.agent),
        release: () => { acquired.lease.release() },
      }
    }
  }

  /**
   * Resolve one ordinary Session and acquire its exact usage lease. A seal
   * race only retries this acquisition; the caller has run no side effect yet.
   * @param sessionId - ordinary Session identity.
   * @returns the exact Agent and its idempotent lease.
   */
  async acquireRetained(sessionId: SessionId): Promise<{ readonly agent: Agent; readonly lease: AgentActivityLease }> {
    for (;;) {
      await this.waitRetiring(sessionId)
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      try {
        return { agent: found.agent, lease: this.ctx.agents.retain(found.agent) }
      } catch (error: unknown) {
        if (!(error instanceof AgentReclaimingError)) throw error
        await this.waitRetiring(sessionId)
      }
    }
  }

  /**
   * Run one internal asynchronous operation under an exact usage lease.
   * @param sessionId - ordinary Session identity.
   * @param operation - work that must finish before the Agent can be reclaimed.
   * @returns the operation result.
   */
  async withRetainedAgent<Value>(
    sessionId: SessionId,
    operation: (agent: Agent) => Promise<Value>,
  ): Promise<Value> {
    const acquired = await this.acquireRetained(sessionId)
    try {
      return await operation(acquired.agent)
    } finally {
      acquired.lease.release()
    }
  }

  /**
   * Pin an already live Agent for an external lifetime such as an active
   * follow stream. Cold Sessions acquire nothing; creation/resume publication
   * already withholds idle eligibility until it settles.
   * @param sessionId - Session whose live Agent must stay resident.
   * @returns the lease, or undefined when no Agent is live or it is sealing.
   */
  retainLive(sessionId: SessionId): AgentActivityLease | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    try {
      return this.ctx.agents.retain(agent)
    } catch (error: unknown) {
      if (error instanceof AgentReclaimingError) return undefined
      throw error
    }
  }

  /**
   * Start the bounded idle sweep. It starts from real quiescence
   * (`AgentHandle.reclaim.idleSince`) and never overlaps a running sweep.
   * @param policy - enabled policy and positive bounds.
   */
  startIdleEviction(policy: ApiIdleEvictionConfig): void {
    this.policy = policy
    if (!policy.enabled || this.disposed) return
    const schedule = (): void => {
      if (this.disposed) return
      this.idleTimer = setTimeout(() => {
        void this.sweepIdleAgents().finally(schedule)
      }, policy.sweepPeriodMs)
      this.idleTimer.unref()
    }
    schedule()
  }

  /**
   * Run one bounded, non-overlapping reclamation sweep. Each eligible
   * creator-owned handle is checked under its own atomic seal; workspace
   * activity, including schedules, is asked read-only inside that check.
   * @returns after the candidate bound or exhaustion.
   */
  async sweepIdleAgents(): Promise<void> {
    const policy = this.policy
    if (policy === undefined || !policy.enabled || this.sweeping || this.disposed) return
    this.sweeping = true
    try {
      const now = Date.now()
      let examined = 0
      const entries = [...this.handles]
      const total = entries.length
      if (total === 0) return
      // Start after the last attempted candidate and wrap once. A candidate
      // whose check keeps reporting activity must not consume the same prefix
      // of the map on every sweep.
      let index = this.sweepCursor % total
      for (let visited = 0; visited < total && !this.shutdown.signal.aborted && examined < policy.maxPerSweep; visited += 1) {
        const entry = entries[index]
        index = (index + 1) % total
        if (entry === undefined) continue
        const [sessionId, handle] = entry
        if (this.handles.get(sessionId) !== handle) continue
        const reclaim = handle.reclaim
        if (reclaim === undefined) continue
        if (!this.hasCompletedTurn(handle.agent.session)) continue
        const idleSince = reclaim.idleSince()
        if (idleSince === undefined || now - idleSince < policy.idleTtlMs) continue
        this.sweepCursor = index
        examined += 1
        await this.reclaimIdle(sessionId, handle, reclaim)
      }
    } finally {
      this.sweeping = false
    }
  }

  private async reclaimIdle(
    sessionId: SessionId,
    handle: AgentHandle,
    reclaim: NonNullable<AgentHandle['reclaim']>,
  ): Promise<void> {
    let settle!: () => void
    const retiring = new Promise<void>((resolve) => { settle = resolve })
    this.retiring.set(sessionId, retiring)
    try {
      const outcome = await reclaim.tryReclaim(async (signal) => {
        signal.throwIfAborted()
        if (!this.hasCompletedTurn(handle.agent.session)) return false
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        signal.throwIfAborted()
        return activity.length === 0
      }, {
        signal: this.shutdown.signal,
        timeoutMs: this.policy?.reclaimTimeoutMs ?? DEFAULT_API_IDLE_EVICTION.reclaimTimeoutMs,
      })
      if (outcome.kind === 'reclaimed') {
        if (this.handles.get(sessionId) === handle) this.handles.delete(sessionId)
        this.ctx.logger.info(`session-controller: reclaimed idle Session "${sessionId}"`)
      }
    } catch (error: unknown) {
      if (error instanceof AgentReclaimTeardownError) {
        this.quarantined.set(sessionId, error)
        this.ctx.logger.error(`session-controller: quarantine after unknown teardown for "${sessionId}": ${error.message}`)
      } else {
        this.ctx.logger.warn(`session-controller: idle reclamation skipped for "${sessionId}": ${String(error)}`)
      }
    } finally {
      settle()
      if (this.retiring.get(sessionId) === retiring) this.retiring.delete(sessionId)
    }
  }

  /** Stop the sweep timer, abort in-flight checks, and drop every policy record at owner shutdown. */
  disposeIdleEviction(): void {
    this.disposed = true
    this.policy = undefined
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.shutdown.abort()
    this.handles.clear()
    this.retiring.clear()
    this.quarantined.clear()
    this.sweepCursor = 0
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
