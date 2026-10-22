/** Loader-mounted fixture that owns the API agent controller for the durability spec. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'

/** The fixture instance created by the most recent Loader boot. */
export const apiIdleLoaderRef: { current?: ApiIdleLoaderFixture; error?: unknown } = {}

/** Test service exposing one controller configured with a tiny reclaim window. */
export default class ApiIdleLoaderFixture extends Service {
  static inject = ['agents', 'llm', 'sessionProjections', 'sessionQuery', 'sessions', 'typert']

  readonly controller: ApiSessionAgentController
  readonly commands: SessionCommandController

  constructor(ctx: Context) {
    super(ctx, 'apiIdleLoaderFixture')
    apiIdleLoaderRef.current = this
    try {
      installModelSelectionProjection(ctx)
      ctx.provide('agentDefaultModel', {
        currentSelection: (): AgentOptions => ({ provider: 'mock', model: 'mock' }),
        saveSelection: () => Promise.resolve(),
      } as never)
      // Fork resolves workspace placement through this registry; this fixture
      // tests durability, not workspace membership.
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.llm.registerAdapter(['mock'], new MockAdapter([
        textResponse('first mock answer'),
        textResponse('second mock answer'),
        textResponse('fork mock answer'),
        textResponse('resumed mock answer'),
      ]))
      this.controller = new ApiSessionAgentController(ctx, {
        enabled: true,
        idleTtlMs: 1,
        sweepPeriodMs: 600_000,
        maxPerSweep: 8,
        reclaimTimeoutMs: 5_000,
      })
      this.commands = new SessionCommandController(ctx, this.controller, process.cwd())
    } catch (error: unknown) {
      apiIdleLoaderRef.error = error
      throw error
    }
  }
}
