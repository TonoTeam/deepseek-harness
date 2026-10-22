/** Session-owned MCP browser processes and provider catalog activation. @module */

import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { Client, type Tool } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { SessionResources } from './index.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

/**
 * When a provider starts the MCP server that owns a Session's browser.
 * `eager` starts it during Agent creation; `on-demand` discovers the catalogue
 * once and starts one server on that Agent's first browser tool or resource call.
 */
export type BrowserMcpStartup = 'eager' | 'on-demand'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
  /** Start the serving server eagerly or on the Session's first browser call; omission means eager. */
  startup?: BrowserMcpStartup
}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
  /** Attachment requires eager startup; `on-demand` is rejected. Omission means eager. */
  startup?: BrowserMcpStartup
}

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
    startup: Schema.union([Schema.const('eager'), Schema.const('on-demand')]),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
    startup: Schema.union([Schema.const('eager'), Schema.const('on-demand')]),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  if (config.startup === 'on-demand') {
    throw new Error('browser attach mode requires eager startup; on-demand startup is available only for launch mode')
  }
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
  /** Start during Agent creation (`eager`) or on the first browser call (`on-demand`); omission means eager. */
  startup?: BrowserMcpStartup
  /**
   * Arguments for the metadata-only probe. Required for on-demand startup;
   * omitted for eager startup. The probe runs `command` with these arguments
   * and `env`, in a neutral temporary directory, and never invokes a browser tool.
   */
  metadata?: { args: string[] }
}

interface ClientState {
  status: 'ready' | 'blocked'
  mask?: Scope
}

/**
 * Register browser tools for each future Agent and own the serving process per Session.
 * Eager startup connects during Agent creation; on-demand startup discovers one
 * metadata catalogue, then opens a serving process on that Agent's first call.
 * A busy attachment leaves that activation without browser tools; its other turns continue.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, prompt assembly, and working directories.
 * @param options - provider identity, attachment exclusivity, startup mode, and executable configuration.
 * @throws when the working-directory provider is absent, before browser resources are registered.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) throw new Error(`${options.name}: browser MCP requires a working-directory provider`)
  if (options.startup === 'on-demand') {
    mountOnDemandSessionMcp(ctx, options, workingDirectory)
    return
  }
  let resources!: SessionResources<Scope>
  const clients = new Map<Agent, ClientState>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status !== 'blocked') continue
        const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: await workingDirectory.ensure(agent, signal),
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            close() {
              clients.delete(agent)
              return scope.dispose()
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const state: ClientState = { status: resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'blocked') {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    await resources.get(agent, signal)
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    return resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      try {
        return await next()
      } finally {
        exec.signal = original
      }
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
}

/** Catalogue and attributed instructions discovered by the provider-owned metadata probe. */
interface BrowserMcpCatalog {
  tools: readonly Tool[]
  instructions: string
}

/** Canonical resource request accepted by the shared MCP server-context registration. */
type BrowserMcpResourceRequest = Parameters<McpClient.ServerContext['resources']['request']>[0]

/** Canonical resource result produced for the shared MCP resource tools. */
type BrowserMcpResourceResult = Awaited<ReturnType<McpClient.ServerContext['resources']['request']>>

/** One live serving process with its verified catalogue and quiescent close. */
interface LiveBrowserMcpConnection {
  /** Run one call after comparing the live raw tool with the metadata catalogue. */
  call(tool: Tool, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** Run one resource operation through this exact process. */
  request(request: BrowserMcpResourceRequest, signal: AbortSignal): Promise<BrowserMcpResourceResult>
  /** Close the transport and await its termination escalation plus the child close event. */
  close(): Promise<void>
}

/** Process options shared by the metadata probe and a serving connection. */
interface BrowserMcpProcessOptions {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd: string
}

interface SdkConnection {
  client: Client
  transport: StdioClientTransport
  /**
   * Close the client or its unattached transport once, awaiting SDK kill escalation
   * and the child close event; reject when termination cannot be confirmed.
   */
  close(): Promise<void>
}

// The MCP SDK's stdio transport owns two two-second termination grace periods
// (stdin EOF, then SIGTERM), then sends SIGKILL and returns without awaiting
// the child's close event. Keep one additional second for that event, which
// proves the old child is gone; timing out fails closed instead of allowing a
// replacement process while the old child may still be alive.
const CHILD_CLOSE_CONFIRMATION_TIMEOUT_MS = 5_000

/** Wait for the transport's close notification without letting a broken transport wedge teardown forever. */
function waitForChildClose(closed: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { resolve(false) }, CHILD_CLOSE_CONFIRMATION_TIMEOUT_MS)
    timeout.unref()
    void closed.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

/**
 * Build one SDK client and stdio transport with the shared scrubbed environment.
 * @param options - executable, arguments, environment overrides, and working directory.
 * @param onUnconfirmedClose - records a close that could not prove child termination so no replacement may start.
 * @returns the unattached client, transport, and idempotent close operation.
 */
function createSdkConnection(
  options: BrowserMcpProcessOptions,
  onUnconfirmedClose: (error: Error) => void,
): SdkConnection {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    env: { ...scrubbedParentEnv(), ...options.env },
    cwd: options.cwd,
  })
  const client = new Client({ name: 'dsh-browser-mcp', version: '0.0.1' }, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  })
  const closed: PromiseWithResolvers<void> = Promise.withResolvers()
  client.onclose = () => { closed.resolve() }
  let closing: Promise<void> | undefined
  return {
    client,
    transport,
    close: () => closing ??= (async () => {
      const attached = client.transport !== undefined
      const failures: unknown[] = []
      if (attached) {
        try {
          await client.close()
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        // The SDK's stdio close escalates to SIGKILL when attached; an
        // unattached transport must still release any spawned process.
        await transport.close()
      } catch (error) {
        failures.push(error)
      }
      // An attached client has, or had, a session child; only the transport's
      // close event proves that child is physically gone. A close before
      // connect or after the transport already closed has no child to await.
      if (attached && !await waitForChildClose(closed.promise)) {
        const unconfirmed = new Error('browser MCP transport close did not emit the child close event')
        const failure = failures.length === 0
          ? unconfirmed
          : new AggregateError([...failures, unconfirmed], 'browser MCP connection close did not confirm child termination')
        onUnconfirmedClose(failure)
        throw failure
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'browser MCP connection close failed')
    })(),
  }
}

/**
 * Discover the provider catalogue once through a metadata-only connection.
 * The neutral temporary directory keeps any Agent's workspace out of the probe;
 * instructions retain their canonical attribution and the MCP client's default
 * byte bound; the connection is closed on success, failure, and cancellation.
 * @param serverName - provider namespace used in the attributed instruction header.
 * @param options - metadata probe command, arguments, environment, and neutral directory.
 * @param signal - aborts discovery and terminates the probe.
 * @param onUnconfirmedClose - records a close that could not prove child termination so no replacement may start.
 * @param assertStartable - rejects when an earlier unconfirmed close already fenced startup.
 * @returns immutable tools and attributed server instructions.
 */
async function discoverBrowserMcpCatalog(
  serverName: string,
  options: BrowserMcpProcessOptions,
  signal: AbortSignal,
  onUnconfirmedClose: (error: Error) => void,
  assertStartable: () => void,
): Promise<BrowserMcpCatalog> {
  assertStartable()
  const connection = createSdkConnection(options, onUnconfirmedClose)
  const abort = (): void => { void connection.close().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  let failed = false
  try {
    await connection.client.connect(connection.transport)
    signal.throwIfAborted()
    const capabilities = connection.client.getServerCapabilities()
    const listed = capabilities?.tools === undefined
      ? { tools: [] as Tool[] }
      : await connection.client.listTools(undefined, { cacheMode: 'refresh' })
    signal.throwIfAborted()
    return {
      tools: listed.tools,
      instructions: McpClient.formatServerInstructions(serverName, connection.client.getInstructions()),
    }
  } catch (error) {
    failed = true
    let closeFailure: unknown
    try {
      await connection.close()
    } catch (failure) {
      closeFailure = failure
    }
    const failures: unknown[] = [error]
    if (closeFailure !== undefined) failures.push(closeFailure)
    if (failures.length > 1) {
      throw new AggregateError(failures, `${serverName}: browser metadata discovery failed and its child close was not confirmed`)
    }
    signal.throwIfAborted()
    throw error instanceof Error ? error : new Error(String(error), { cause: error })
  } finally {
    signal.removeEventListener('abort', abort)
    if (!failed) await connection.close()
  }
}

/**
 * Open one serving connection after a Session's catalogue has been registered.
 * @param options - serving command, arguments, environment overrides, and Session directory.
 * @param toolCallTimeoutMs - per-call timeout; omission retains the SDK default.
 * @param signal - aborts startup and closes the partial connection.
 * @param onUnconfirmedClose - records a close that could not prove child termination so no replacement may start.
 * @param assertStartable - rejects when an earlier unconfirmed close already fenced startup.
 * @returns the live connection with the catalogue the serving process reported.
 */
async function openLiveBrowserMcpConnection(
  options: BrowserMcpProcessOptions,
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal,
  onUnconfirmedClose: (error: Error) => void,
  assertStartable: () => void,
): Promise<LiveBrowserMcpConnection> {
  assertStartable()
  const connection = createSdkConnection(options, onUnconfirmedClose)
  const abort = (): void => { void connection.close().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await connection.client.connect(connection.transport)
    signal.throwIfAborted()
    const capabilities = connection.client.getServerCapabilities()
    const listed = capabilities?.tools === undefined
      ? { tools: [] as Tool[] }
      : await connection.client.listTools(undefined, { cacheMode: 'refresh' })
    signal.throwIfAborted()
    const tools = new Map(listed.tools.map(tool => [tool.name, tool] as const))
    const connectionOptions = toolCallTimeoutMs === undefined ? {} : { timeout: toolCallTimeoutMs }
    return {
      async call(tool, args, callSignal) {
        const live = tools.get(tool.name)
        if (live === undefined || !isDeepStrictEqual(live.inputSchema, tool.inputSchema)) {
          throw new Error(`browser MCP catalogue changed after metadata discovery for tool "${tool.name}"; refusing the call`)
        }
        return await connection.client.callTool(
          { name: tool.name, arguments: args },
          { ...connectionOptions, signal: callSignal, toolDefinition: live },
        )
      },
      async request(request, requestSignal) {
        const requestOptions = { ...connectionOptions, signal: requestSignal }
        switch (request.method) {
          case 'resources/list': {
            const cursor = request.cursor === undefined ? undefined : { cursor: request.cursor }
            return await connection.client.listResources(cursor, requestOptions) as BrowserMcpResourceResult
          }
          case 'resources/templates/list': {
            const cursor = request.cursor === undefined ? undefined : { cursor: request.cursor }
            return await connection.client.listResourceTemplates(cursor, requestOptions) as BrowserMcpResourceResult
          }
          case 'resources/read':
            return await connection.client.readResource({ uri: request.uri }, requestOptions) as BrowserMcpResourceResult
          default: {
            const unexpected: never = request
            throw new Error(`browser MCP resource request is not supported: ${JSON.stringify(unexpected)}`)
          }
        }
      },
      close: connection.close,
    }
  } catch (error) {
    let closeFailure: unknown
    try {
      await connection.close()
    } catch (failure) {
      closeFailure = failure
    }
    const failures: unknown[] = [error]
    if (closeFailure !== undefined) failures.push(closeFailure)
    if (failures.length > 1) {
      throw new AggregateError(failures, `${options.command}: browser serving startup failed and its child close was not confirmed`)
    }
    signal.throwIfAborted()
    throw error instanceof Error ? error : new Error(String(error), { cause: error })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Normalize one caller's abort reason for catalogue waits. */
function catalogAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('browser catalog wait canceled', { cause: signal.reason })
}

/**
 * Stop one caller's catalogue wait without cancelling the provider-owned discovery.
 * @param catalog - provider-owned discovery promise shared across callers.
 * @param signal - caller cancellation; absent means wait for the provider-owned discovery.
 * @returns the catalogue, or a rejection when the caller aborts first.
 */
function awaitCatalog(catalog: Promise<BrowserMcpCatalog>, signal?: AbortSignal): Promise<BrowserMcpCatalog> {
  if (signal === undefined) return catalog
  if (signal.aborted) return Promise.reject(catalogAbortReason(signal))
  return new Promise<BrowserMcpCatalog>((resolve, reject) => {
    const aborted = (): void => { reject(catalogAbortReason(signal)) }
    signal.addEventListener('abort', aborted, { once: true })
    void catalog.then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    })
  })
}

/**
 * Register one metadata catalogue for every future Agent, opening serving
 * processes only when a Session calls a browser tool or resource.
 * @param ctx - provider context supplying browser use, Agents, tools, prompt assembly, and working directories.
 * @param options - provider identity, serving configuration, and metadata probe arguments.
 * @param workingDirectory - service that resolves each Agent's serving directory on first use.
 * @throws when metadata arguments are absent, the mode is exclusive, or registration fails.
 */
function mountOnDemandSessionMcp(ctx: Context, options: SessionMcpOptions, workingDirectory: WorkingDirectoryService): void {
  const metadata = options.metadata
  if (metadata === undefined) throw new Error(`${options.name}: on-demand browser startup requires metadata arguments`)
  if (options.exclusive) throw new Error(`${options.name}: on-demand browser startup supports only an independently launched browser`)
  const scopes = new Map<Agent, Scope>()
  const probeAbort = new AbortController()
  let stopping = false
  let catalog: Promise<BrowserMcpCatalog> | undefined
  let unconfirmedClose: Error | undefined
  const recordUnconfirmedClose = (error: Error): void => { unconfirmedClose ??= error }
  const assertStartable = (): void => {
    if (unconfirmedClose !== undefined) {
      throw new Error(`${options.name}: browser startup is fenced because an earlier MCP child close was not confirmed`, { cause: unconfirmedClose })
    }
  }

  const discover = (): Promise<BrowserMcpCatalog> => {
    assertStartable()
    if (catalog !== undefined) return catalog
    const pending = discoverBrowserMcpCatalog(options.name, {
      command: options.command,
      args: metadata.args,
      cwd: tmpdir(),
      ...options.env === undefined ? {} : { env: options.env },
    }, probeAbort.signal, recordUnconfirmedClose, assertStartable)
    catalog = pending
    // A failed probe drops only its own cache entry, so a later explicit Agent
    // activation discovers again; no browser action or tool call is replayed.
    // Discovery may have no waiter after a cancelled Agent creation; keep its
    // rejection observable without reporting it as unhandled.
    void pending.catch(() => {
      if (catalog === pending) catalog = undefined
    })
    return pending
  }

  const resources = new SessionResources<LiveBrowserMcpConnection>(ctx, {
    label: options.name,
    exclusive: false,
    async open(agent, signal) {
      assertStartable()
      const cwd = await workingDirectory.ensure(agent, signal)
      signal.throwIfAborted()
      assertStartable()
      const connection = await openLiveBrowserMcpConnection({
        command: options.command,
        args: options.args,
        cwd,
        ...options.env === undefined ? {} : { env: options.env },
      }, options.toolCallTimeoutMs, signal, recordUnconfirmedClose, assertStartable)
      return { value: connection, close: () => connection.close() }
    },
  })

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    yield async () => {
      stopping = true
      probeAbort.abort(new Error(`${options.name}: browser provider is stopping`))
      let failure: unknown
      try {
        await resources.dispose()
      } catch (error) {
        failure = error
      }
      await catalog?.catch(() => {})
      const owned = [...scopes.values()]
      scopes.clear()
      const settled = await Promise.allSettled(owned.map(scope => scope.dispose()))
      for (const result of settled) {
        if (result.status === 'rejected') failure ??= result.reason
      }
      failure ??= unconfirmedClose
      if (failure !== undefined) throw failure
    }
  }, `${options.name}.sessions`)

  ctx.on('agent/created', async ({ agent, signal }) => {
    if (stopping) throw new Error(`${options.name}: browser provider is stopping`)
    const discovered = await awaitCatalog(discover(), signal)
    signal?.throwIfAborted()
    if (stopping) throw new Error(`${options.name}: browser provider is stopping`)
    const scope = createScope(ctx, agent)
    scopes.set(agent, scope)
    agent.ctx.effect(() => async () => {
      scopes.delete(agent)
      await scope.dispose()
    }, `${options.name}.catalog`)
    try {
      McpClient.registerServerContext(scope.ctx, options.name, {
        instructions: () => discovered.instructions,
        resources: {
          request: (request, exec) => {
            if (exec.agent !== agent) {
              throw new Error(`${options.name}: browser resource belongs to another Session`)
            }
            return resources.run(agent, exec.signal, (connection, combined) => connection.request(request, combined))
          },
        },
      })
      for (const tool of discovered.tools) {
        scope.ctx.tools.register(McpClient.createMcpToolDefinition(scope.ctx, {
          name: McpClient.publicToolName(options.name, tool.name),
          rawName: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
          ...tool.execution?.taskSupport === 'required' ? { taskRequired: true } : {},
          call: (args, exec) => {
            if (exec.agent !== agent) throw new Error(`${options.name}: browser tool belongs to another Session`)
            return resources.run(agent, exec.signal, (connection, combined) => connection.call(tool, args, combined))
          },
        }))
      }
    } catch (error) {
      scopes.delete(agent)
      await scope.dispose()
      throw error
    }
  }, { prepend: true })
}
