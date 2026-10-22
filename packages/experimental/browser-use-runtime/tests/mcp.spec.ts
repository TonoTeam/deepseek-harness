import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Projections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '../src/mcp.ts'

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []
const TOOL = 'mcp__browser-fixture__visit'

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.tools?.some(tool => tool.name === TOOL) && options.messages.at(-1)?.role === 'user') {
      const call = { type: 'tool-call' as const, id: ToolCallId('visit'), name: TOOL, arguments: '{"label":"fixture"}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Visited.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Visited.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

class PresentationRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(): never { throw new Error('Unexpected PTC execution in a presentation test') }
  run(): Promise<never> { return Promise.reject(new Error('Unexpected PTC execution in a presentation test')) }
}

async function load(exclusive = false, mode?: string, toolCallTimeoutMs?: number, toolOrder?: string[], startup?: 'on-demand', metadataMode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-'))
  roots.push(root)
  const model = new FixtureModel()
  const metadata = startup === 'on-demand'
    ? { startup, metadata: { args: [fixture, root, 'metadata', ...metadataMode === undefined ? [] : [metadataMode]] } }
    : {}
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
    ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    ['browser', { inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'], apply(ctx: Context) {
      mountSessionMcp(ctx, { name: 'browser-fixture', exclusive, command: process.execPath, args: [fixture, root, ...mode === undefined ? [] : [mode]], ...metadata, ...toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs, env: {} } })
    } }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ id: name, name, config: name === 'loop' ? { agents: [] } : name === 'prompt' && toolOrder !== undefined ? { toolOrder } : {} }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const browser = [...ctx.loader.entries()].find(entry => entry.options.id === 'browser')!.fiber!
  return { ctx, root, model, browser }
}

async function warm(ctx: Context, agent: Agent, signal = new AbortController().signal) {
  await agent.whenIdle()
  return ctx.systemPrompt.assemble({ agent, scope: agent, signal })
}

function execute(ctx: Context, agent: Agent, name = TOOL) {
  return ctx.tools.execute({ agent, name, arguments: name === TOOL ? { label: 'direct' } : {}, callId: ToolCallId('direct'), signal: new AbortController().signal })
}

function resource(ctx: Context, agent: Agent | undefined, name = 'read_mcp_resource', server = 'browser-fixture', callId = name) {
  return ctx.tools.execute({
    ...agent === undefined ? {} : { agent }, name,
    arguments: { server, ...name === 'read_mcp_resource' ? { uri: 'browser-fixture://state' } : {} },
    callId: ToolCallId(callId), signal: new AbortController().signal,
  })
}

function browserState(result: Awaited<ReturnType<typeof resource>>): { counter: number; pid: number } {
  expect(result.isError).toBe(false)
  const value = result.value as { contents: { text: string }[] }
  return JSON.parse(value.contents[0]!.text) as { counter: number; pid: number }
}

function registerIndependentTool(ctx: Context) {
  ctx.tools.register({
    name: 'unrelated', description: 'An independent capability.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Independent.' }] },
    execute: async () => true,
  })
}

async function events(root: string) {
  return (await readFile(join(root, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number; name?: string; cwd?: string; argv?: string[] })
}

/** Wait for the fixture's own exit records, then confirm the kernel no longer holds each pid. */
async function observeExits(root: string, pids: number[]) {
  await vi.waitFor(async () => {
    const exited = new Set((await events(root)).filter(event => event.event === 'exit').map(event => event.pid))
    for (const pid of pids) expect(exited.has(pid)).toBe(true)
  }, { timeout: 5000 })
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }
}

it('requires a browser mode and validates launch and attachment settings', () => {
  expect(BrowserMcpConfig({ mode: 'launch' })).toEqual({ mode: 'launch', headless: true })
  expect(BrowserMcpConfig({ mode: 'launch', headless: false, executablePath: '/chromium', toolCallTimeoutMs: 12 })).toMatchObject({ headless: false, toolCallTimeoutMs: 12 })
  expect(BrowserMcpConfig({ mode: 'launch', startup: 'on-demand' })).toMatchObject({ mode: 'launch', startup: 'on-demand' })
  expect(BrowserMcpConfig({ mode: 'attach', endpoint: 'wss://browser.example/devtools/browser/id' })).toMatchObject({ mode: 'attach' })
  for (const invalid of [{}, { mode: 'attach' }, { mode: 'attach', endpoint: 'file:///tmp/browser' }, { mode: 'launch', toolCallTimeoutMs: 0 }, { mode: 'launch', executablePath: '' }, { mode: 'launch', startup: 'sometimes' }]) {
    expect(() => BrowserMcpConfig(invalid as never)).toThrow()
  }
  for (const endpoint of ['http://localhost:bad/path', 'http://localhost trailing-junk', 'file:///tmp/browser', 'http://localhost/ ']) {
    expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint }) }).toThrow('browser endpoint')
  }
  expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint: 'http://127.0.0.1:9222', startup: 'on-demand' }) }).toThrow('on-demand startup is available only for launch mode')
})

it('waits for SystemPrompt and ToolRuntime before reserving the provider', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(BrowserUse)
  await ctx.plugin(Agents)
  provideWorkingDirectoryFixture(ctx)
  const tools = ctx.plugin(Tools)
  const browser = ctx.plugin({
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'],
    apply(provider: Context) {
      mountSessionMcp(provider, { name: 'browser-fixture', exclusive: true, command: process.execPath, args: [fixture] })
    },
  })
  await Promise.all([tools, browser])
  expect(ctx.get('tools')).toBeUndefined()
  expect(ctx.browserUse.providerName).toBeUndefined()
  await ctx.plugin(SystemPrompt)
  await Promise.all([tools, browser])
  expect(ctx.browserUse.providerName).toBe('browser-fixture')
})

describe('Session MCP Loader composition', () => {
  it('discovers schemas before the first model request and retains distinct state across turns', async () => {
    const { ctx, root, model, browser } = await load(false, undefined, 5000, [TOOL, '<unlisted-tools>'])
    const first = await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const second = await ctx.agents.create({ sessionId: SessionId('second') })
    expect(ctx.tools.schemas()).toEqual([])
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.find(tool => tool.name === TOOL)).toMatchObject({ description: 'Visit the fixture page.', parameters: { required: ['label'], additionalProperties: false } })
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 1: fixture')
    expect((await execute(ctx, first.agent)).content).toEqual([{ type: 'text', text: 'Visit 2: direct' }])
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit once more.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(4)
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 3: fixture')
    await warm(ctx, second.agent)
    expect((await execute(ctx, second.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.schemas(first.agent)).toHaveLength(2)
    const initial = await events(root)
    expect(initial.filter(event => event.event === 'start')).toHaveLength(4)
    expect(initial.filter(event => event.event === 'probe')).toHaveLength(2)
    expect(initial.filter(event => event.event === 'initialize')).toHaveLength(2)
    await first.dispose()
    expect(ctx.tools.schemas(first.agent)).toEqual([])
    const resumed = await ctx.agents.create({ sessionId: SessionId('first') })
    await warm(ctx, resumed.agent)
    expect((await execute(ctx, resumed.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await browser.dispose()
    expect(ctx.browserUse.providerName).toBeUndefined()
    const closed = await events(root)
    for (const { pid } of closed.filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('keeps unrelated and child Sessions running without a busy attachment and admits a later owner', async () => {
    const { ctx, root, model } = await load(true)
    registerIndependentTool(ctx)
    const first = await ctx.agents.create({ sessionId: SessionId('first') })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: first.agent, agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (_inner, agent) => { bindScopeParent(agent, first.agent) },
    })
    await warm(ctx, first.agent)
    expect(ctx.tools.schemas(child.agent).some(tool => tool.name === TOOL)).toBe(false)
    for (const { agent } of [second, child]) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    }
    await Promise.all([second.agent.whenIdle(), child.agent.whenIdle()])
    expect(model.requests).toHaveLength(2)
    expect(model.requests.map(request => request.tools?.map(tool => tool.name))).toEqual([['unrelated'], ['unrelated']])
    for (const { agent } of [second, child]) {
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['unrelated'])
      expect((await execute(ctx, agent)).isError).toBe(true)
      expect((await execute(ctx, agent, 'unrelated')).isError).toBe(false)
      expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    }
    first.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__late', description: 'A newly discovered browser operation.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Late browser result.' }] },
      execute: async () => true,
    })
    expect(ctx.tools.schemas(child.agent).filter(tool => tool.name.startsWith('mcp__browser-fixture__'))).toEqual([])
    expect((await warm(ctx, child.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__late')).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await events(root)).filter(event => event.event === 'call')).toEqual([])
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    await first.dispose()
    expect((await warm(ctx, child.agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect((await execute(ctx, child.agent)).isError).toBe(true)
    expect((await warm(ctx, second.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    const successor = await ctx.agents.create({ sessionId: SessionId('successor') })
    expect((await warm(ctx, successor.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
    await successor.dispose()
    await second.dispose()
    const resumed = await ctx.agents.create({ sessionId: SessionId('second') })
    expect((await warm(ctx, resumed.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
  })

  it('allows another Session to answer while attached-browser discovery is pending', async () => {
    const { ctx, root, model, browser } = await load(true, 'hold')
    const first = ctx.agents.create({ sessionId: SessionId('first') })
    const rejected = expect(first).rejects.toThrow()
    await vi.waitFor(async () => { expect((await events(root)).some(event => event.event === 'probe')).toBe(true) })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    await second.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools ?? []).toEqual([])
    expect((await events(root)).filter(event => event.event === 'start')).toHaveLength(1)
    await browser.dispose()
    await rejected
    expect(ctx.agents.get(SessionId('first'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('first'))).toBeUndefined()
  })

  it('rolls back failed discovery and stops a child when unload interrupts discovery', async () => {
    const failed = await load(false, 'fail', undefined, [TOOL, '<unlisted-tools>'])
    let failedAgent!: Agent
    const laterListener = vi.fn()
    await expect(failed.ctx.agents.create({
      sessionId: SessionId('failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        failedAgent = agent
        inner.on('agent/created', () => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } })) }, { prepend: true })
        inner.on('agent/created', laterListener)
      },
    })).rejects.toThrow('initial connection')
    expect(failed.model.requests).toEqual([])
    expect(laterListener).not.toHaveBeenCalled()
    expect(failed.ctx.agents.get(failedAgent.id)).toBeUndefined()
    expect(failed.ctx.sessions.get(failedAgent.id)).toBeUndefined()
    expect(failed.ctx.tools.schemas(failedAgent)).toEqual([])
    const failedEvents = await events(failed.root)
    expect(failedEvents.filter(event => event.event === 'initialize')).toHaveLength(1)
    for (const { pid } of failedEvents.filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    const held = await load(false, 'hold')
    const pendingOwner = held.ctx.agents.create({ sessionId: SessionId('pending') })
    const interrupted = expect(pendingOwner).rejects.toThrow()
    await vi.waitFor(async () => { expect((await events(held.root)).some(event => event.event === 'probe')).toBe(true) })
    await held.browser.dispose()
    await interrupted
    expect(held.ctx.agents.get(SessionId('pending'))).toBeUndefined()
    for (const { pid } of (await events(held.root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('does not reconnect and silently replace browser state after a process exits', async () => {
    const { ctx, root } = await load()
    const owner = await ctx.agents.create({ sessionId: SessionId('disconnect') })
    await warm(ctx, owner.agent)
    const servingPid = (await events(root)).find(event => event.event === 'initialize')!.pid
    await execute(ctx, owner.agent, 'mcp__browser-fixture__disconnect')
    await vi.waitFor(() => { expect(() => process.kill(servingPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })) })
    await warm(ctx, owner.agent)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await execute(ctx, owner.agent)).isError).toBe(true)
  })

  it('keeps browser ownership exact when scopes inherit tools and leaves unrelated tools usable', async () => {
    const { ctx } = await load()
    await ctx.systemPrompt.assemble()
    const owner = await ctx.agents.create({ sessionId: SessionId('parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: owner.agent,
      setup: (_inner, agent) => { bindScopeParent(agent, owner.agent) },
    })
    await warm(ctx, owner.agent)
    registerIndependentTool(ctx)
    expect((await execute(ctx, owner.agent, 'unrelated')).content).toEqual([{ type: 'text', text: 'Independent.' }])
    await warm(ctx, child.agent)
    expect((await execute(ctx, child.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
  })

  it('denies inherited browser resources and instructions while keeping unrelated MCP servers usable', async () => {
    const { ctx, root } = await load(true)
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('docs', { request: async () => ({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] }) })
    const parent = await ctx.agents.create({ sessionId: SessionId('resource-parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('resource-child'), parentAgent: parent.agent,
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    expect(renderPrompt(await warm(ctx, parent.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    const blocked = await warm(ctx, child.agent)
    expect(blocked.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(renderPrompt(blocked)).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(renderPrompt(blocked)).toContain('browser-fixture')
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect((await resource(ctx, child.agent, name)).isError).toBe(true)
    }
    expect((await resource(ctx, undefined)).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'resource')).toEqual([])
    expect((await resource(ctx, child.agent, 'read_mcp_resource', 'docs')).value)
      .toEqual({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] })
    for (const args of [null, 'invalid arguments']) {
      expect((await ctx.tools.execute({ agent: child.agent, name: 'read_mcp_resource', arguments: args, callId: ToolCallId('invalid-resource'), signal: new AbortController().signal })).isError).toBe(true)
    }
    expect(browserState(await resource(ctx, parent.agent)).counter).toBe(0)
    await parent.dispose()
    expect(renderPrompt(await warm(ctx, child.agent))).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect((await resource(ctx, child.agent)).isError).toBe(true)
    const successor = await ctx.agents.create({ sessionId: SessionId('resource-successor') })
    expect(renderPrompt(await warm(ctx, successor.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(browserState(await resource(ctx, successor.agent)).counter).toBe(0)
  })

  it('uses the child connection for resources and serializes them with browser tools exactly once', async () => {
    const { ctx } = await load()
    await ctx.plugin(McpResources)
    const parent = await ctx.agents.create({ sessionId: SessionId('parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: parent.agent,
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    await warm(ctx, parent.agent)
    await execute(ctx, parent.agent)
    await warm(ctx, child.agent)
    const parentOnly = vi.fn(async () => true)
    parent.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__parent_only', description: 'A browser operation available only in the parent.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [] }, execute: parentOnly,
    })
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__parent_only')).isError).toBe(true)
    expect(parentOnly).not.toHaveBeenCalled()
    const parentState = browserState(await resource(ctx, parent.agent))
    const childState = browserState(await resource(ctx, child.agent))
    expect(parentState.counter).toBe(1)
    expect(childState.counter).toBe(0)
    expect(childState.pid).not.toBe(parentState.pid)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const started: string[] = []
    const stop = ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === child.agent) {
        started.push(exec.name)
        if (exec.callId === ToolCallId('held-resource')) {
          entered.resolve(undefined)
          await release.promise
        }
      }
      return next()
    })
    try {
      const reading = resource(ctx, child.agent, 'read_mcp_resource', 'browser-fixture', 'held-resource')
      await entered.promise
      const visiting = execute(ctx, child.agent)
      expect((await execute(ctx, parent.agent)).isError).toBe(false)
      expect(started).toEqual(['read_mcp_resource'])
      release.resolve(undefined)
      expect(browserState(await reading).counter).toBe(0)
      expect((await visiting).isError).toBe(false)
      expect(started).toEqual(['read_mcp_resource', TOOL])
      expect(browserState(await resource(ctx, child.agent)).counter).toBe(1)
    } finally {
      release.resolve(undefined)
      stop()
    }
  })

  it('holds an immediate PTC turn until the first SDK includes browser tools', async () => {
    const { ctx, root, model } = await load(false, 'gate', undefined, ['run_code', '<unlisted-tools>'])
    await ctx.plugin(PresentationRuntime)
    let created = false
    let initializing!: Agent
    const creation = ctx.agents.create({
      sessionId: SessionId('ptc-first-request'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.tools.presentAs('ptc')
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Describe the available browser tools.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }).then((handle) => {
      created = true
      return handle
    })
    await vi.waitFor(async () => { expect((await events(root)).some(event => event.event === 'probe')).toBe(true) })
    expect(created).toBe(false)
    expect(model.requests).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    await writeFile(join(root, 'release'), '')
    const owner = await creation
    await owner.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    expect(JSON.stringify(model.requests[0]?.messages)).toContain(TOOL)
  })

  it('cancels creation during discovery, closes its process, and keeps the attachment pinned', async () => {
    const { ctx, root, model } = await load(true, 'gate')
    const controller = new AbortController()
    let initializing!: Agent
    const creation = ctx.agents.create({
      sessionId: SessionId('canceled-startup'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    })
    const rejected = expect(creation).rejects.toThrow('cancel browser startup')
    await vi.waitFor(async () => { expect((await events(root)).some(event => event.event === 'probe')).toBe(true) })
    controller.abort(new Error('cancel browser startup'))
    await rejected
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.schemas(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    await writeFile(join(root, 'release'), '')
    // The canceled startup's rejected acquisition keeps its entry and pin: the
    // provider cannot prove the child exit, so the attachment needs operator
    // teardown instead of automatic reattachment.
    const successor = await ctx.agents.create({ sessionId: initializing.id })
    expect(ctx.tools.schemas(successor.agent).some(tool => tool.name === TOOL)).toBe(false)
    expect((await execute(ctx, successor.agent)).isError).toBe(true)
  })

  it('closes the discovered client when a later creation listener rejects', async () => {
    const { ctx, root, model } = await load(false, undefined, undefined, [TOOL, '<unlisted-tools>'])
    let initializing!: Agent
    await expect(ctx.agents.create({
      sessionId: SessionId('later-listener-failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          expect(ctx.tools.schemas(agent).some(tool => tool.name === TOOL)).toBe(true)
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
          throw new Error('later initialization failed')
        })
      },
    })).rejects.toThrow('later initialization failed')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.schemas(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('cancels before browser discovery without starting a process', async () => {
    const { ctx, root, model } = await load(false, 'gate')
    const controller = new AbortController()
    await expect(ctx.agents.create({
      sessionId: SessionId('canceled-at-creation'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner) => {
        inner.on('agent/created', () => { controller.abort(new Error('cancel before discovery')) }, { prepend: true })
      },
    })).rejects.toThrow('cancel before discovery')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(SessionId('canceled-at-creation'))).toBeUndefined()
    await expect(readFile(join(root, 'events.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a live server directory and starts the resumed server in the current Session directory', async () => {
    const { ctx, root } = await load()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await mkdir(join(root, 'original'))
    await mkdir(join(root, 'selected'))
    const original = await realpath(join(root, 'original'))
    const selected = await realpath(join(root, 'selected'))
    const sessionId = SessionId('browser-directory')
    const first = await ctx.agents.create({ sessionId, meta: { cwd: original } })
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    const initial = await events(root)
    const firstCall = initial.findLast(event => event.event === 'call')
    expect(firstCall).toMatchObject({ cwd: original })
    const starts = initial.filter(event => event.event === 'start').length

    await ctx.workingDirectory.set(first.agent, selected)
    expect(first.agent.session.header.cwd).toBe(original)
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    const changed = await events(root)
    expect(changed.findLast(event => event.event === 'call')).toMatchObject({ cwd: original, pid: firstCall?.pid })
    expect(changed.filter(event => event.event === 'start')).toHaveLength(starts)
    await first.dispose()

    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
    expect(resumed.agent.session.header.cwd).toBe(original)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
    const reopened = await events(root)
    expect(reopened.findLast(event => event.event === 'call')).toMatchObject({ cwd: selected })
    expect(reopened.filter(event => event.event === 'start').length).toBeGreaterThan(starts)
    await resumed.dispose()
  })

  it('awaits discovery on persisted resume and keeps a canceled resume pinned after failure', async () => {
    const { ctx, root, model } = await load(true, 'gate')
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await writeFile(join(root, 'release'), '')
    const sessionId = SessionId('persisted-browser')
    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    await first.dispose()
    await rm(join(root, 'release'))

    const controller = new AbortController()
    const canceledResume = ctx.agents.resume({
      resumeSessionId: sessionId, signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit again.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    })
    const rejected = expect(canceledResume).rejects.toThrow('cancel browser resume')
    await vi.waitFor(async () => { expect((await events(root)).filter(event => event.event === 'probe')).toHaveLength(2) })
    expect(model.requests).toHaveLength(2)
    controller.abort(new Error('cancel browser resume'))
    await rejected
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }

    // The canceled resume's rejected acquisition keeps its entry and pin, so a
    // retry is admitted without browser tools rather than reconnecting.
    const owner = await ctx.agents.resume({ resumeSessionId: sessionId })
    expect((await events(root)).filter(event => event.event === 'probe')).toHaveLength(2)
    expect(model.requests).toHaveLength(2)
    expect(ctx.tools.schemas(owner.agent).some(tool => tool.name === TOOL)).toBe(false)
    expect((await execute(ctx, owner.agent)).isError).toBe(true)
    await owner.dispose()
  })

  it('initializes only future activations after provider reload', async () => {
    const { ctx, root, browser } = await load()
    await browser.dispose()
    const existing = await ctx.agents.create({ sessionId: SessionId('existing') })
    await ctx.plugin({
      inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'],
      apply(inner: Context) {
        mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root] })
      },
    })
    expect((await warm(ctx, existing.agent)).tools).toEqual([])
    const future = await ctx.agents.create({ sessionId: SessionId('future') })
    expect((await warm(ctx, future.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, existing.agent)).isError).toBe(true)
    expect((await execute(ctx, future.agent)).isError).toBe(false)
  })
})

describe('on-demand Session MCP startup', () => {
  it('registers one metadata catalogue for every Agent and starts a server only for the calling Agent', async () => {
    const { ctx, root, model, browser } = await load(false, undefined, 5000, [TOOL, '<unlisted-tools>'], 'on-demand')
    const secondDirectory = join(root, 'second-agent')
    await mkdir(secondDirectory)
    const first = await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: secondDirectory } })
    expect(ctx.tools.schemas()).toEqual([])
    for (const { agent } of [first, second]) {
      expect(ctx.tools.schemas(agent).map(schema => schema.name)).toContain(TOOL)
      expect(renderPrompt(await warm(ctx, agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    }
    const discovered = await events(root)
    const metadataStarts = discovered.filter(event => event.event === 'start')
    expect(metadataStarts).toHaveLength(2)
    expect(discovered.filter(event => event.event === 'probe')).toHaveLength(1)
    expect(discovered.filter(event => event.event === 'initialize')).toHaveLength(1)
    expect(discovered.filter(event => event.event === 'call')).toEqual([])
    for (const start of metadataStarts) {
      expect(start.argv).toEqual([root, 'metadata'])
      expect(start.cwd).toBe(await realpath(tmpdir()))
    }
    await observeExits(root, metadataStarts.map(event => event.pid))
    expect(ctx.tools.schemas(second.agent).map(schema => schema.name)).toContain(TOOL)

    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.find(tool => tool.name === TOOL)).toMatchObject({ description: 'Visit the fixture page.' })
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 1: fixture')
    const served = await events(root)
    const firstInitialization = served.filter(event => event.event === 'initialize')
    expect(firstInitialization).toHaveLength(2)
    const servingStart = served.find(event => event.event === 'start' && event.pid === firstInitialization.at(-1)?.pid)
    expect(servingStart?.cwd).toBe(await realpath(root))
    expect(served.filter(event => event.event === 'call')).toHaveLength(1)

    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit once more.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(4)
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 2: fixture')
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(2)
    expect((await execute(ctx, first.agent)).content).toEqual([{ type: 'text', text: 'Visit 3: direct' }])
    const retained = await events(root)
    expect(retained.filter(event => event.event === 'start')).toHaveLength(4)
    expect(retained.filter(event => event.event === 'initialize')).toHaveLength(2)
    expect(new Set(retained.filter(event => event.event === 'call').map(event => event.pid)).size).toBe(1)
    expect(ctx.tools.schemas(second.agent).map(schema => schema.name)).toContain(TOOL)

    const servingPid = retained.find(event => event.event === 'call')!.pid
    await execute(ctx, first.agent, 'mcp__browser-fixture__disconnect')
    await vi.waitFor(() => { expect(() => process.kill(servingPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })) })
    expect((await execute(ctx, first.agent)).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(2)
    await browser.dispose()
    await observeExits(root, (await events(root)).filter(event => event.event === 'start').map(event => event.pid))
  })

  it('starts a serving process on the owning Agent\'s first resource call without an earlier tool call', async () => {
    const { ctx, root } = await load(false, undefined, 5000, undefined, 'on-demand')
    await ctx.plugin(McpResources)
    const owner = await ctx.agents.create({ sessionId: SessionId('resource-owner'), meta: { cwd: root } })
    const other = await ctx.agents.create({ sessionId: SessionId('resource-other') })
    expect((await events(root)).filter(event => event.event === 'start')).toHaveLength(2)
    const ownerState = browserState(await resource(ctx, owner.agent))
    expect(ownerState.counter).toBe(0)
    let recorded = await events(root)
    expect(recorded.filter(event => event.event === 'start')).toHaveLength(4)
    const otherState = browserState(await resource(ctx, other.agent))
    expect(otherState.counter).toBe(0)
    expect(otherState.pid).not.toBe(ownerState.pid)
    recorded = await events(root)
    expect(recorded.filter(event => event.event === 'start')).toHaveLength(6)
    expect(recorded.filter(event => event.event === 'call')).toEqual([])
    expect(recorded.filter(event => event.event === 'resource')).toHaveLength(2)
    await owner.dispose()
    await other.dispose()
    await observeExits(root, recorded.filter(event => event.event === 'start').map(event => event.pid))
  })

  it('confirms a stubborn child exited before provider teardown returns', async () => {
    const { ctx, root, browser } = await load(false, 'stubborn', 5000, undefined, 'on-demand')
    const owner = await ctx.agents.create({ sessionId: SessionId('stubborn-child'), meta: { cwd: root } })
    expect((await execute(ctx, owner.agent)).isError).toBe(false)
    const servingPid = (await events(root)).find(event => event.event === 'call')!.pid
    await browser.dispose()
    expect(() => process.kill(servingPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect((await events(root)).some(event => event.event === 'signal')).toBe(true)
  }, 15_000)

  it('single-flights concurrent first calls and retains browser state across calls', async () => {
    const { ctx, root } = await load(false, undefined, 5000, undefined, 'on-demand')
    const owner = await ctx.agents.create({ sessionId: SessionId('singleflight'), meta: { cwd: root } })
    const call = (label: string) => ctx.tools.execute({
      agent: owner.agent, name: TOOL, arguments: { label }, callId: ToolCallId(label), signal: new AbortController().signal,
    })
    const results = await Promise.all([call('first'), call('second')])
    expect(results.map(result => result.isError)).toEqual([false, false])
    expect(results.map(result => result.content)).toEqual([
      [{ type: 'text', text: 'Visit 1: first' }],
      [{ type: 'text', text: 'Visit 2: second' }],
    ])
    const recorded = await events(root)
    expect(recorded.filter(event => event.event === 'initialize')).toHaveLength(2)
    const calls = recorded.filter(event => event.event === 'call')
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(event => event.pid)).size).toBe(1)
    await owner.dispose()
    await observeExits(root, recorded.filter(event => event.event === 'start').map(event => event.pid))
  })

  it('fails closed when the serving catalogue differs from metadata', async () => {
    const { ctx, root } = await load(false, 'drift', 5000, undefined, 'on-demand')
    const owner = await ctx.agents.create({ sessionId: SessionId('drift'), meta: { cwd: root } })
    const result = await execute(ctx, owner.agent)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('catalogue changed after metadata discovery')
    const recorded = await events(root)
    expect(recorded.filter(event => event.event === 'call')).toEqual([])
    expect(recorded.filter(event => event.event === 'initialize')).toHaveLength(2)
    await owner.dispose()
    await observeExits(root, recorded.filter(event => event.event === 'start').map(event => event.pid))
  })

  it('reaps metadata discovery and failed serving startup children', async () => {
    const held = await load(false, undefined, undefined, undefined, 'on-demand', 'hold')
    const heldRejected = expect(held.ctx.agents.create({ sessionId: SessionId('held-metadata') })).rejects.toThrow()
    await vi.waitFor(async () => { expect((await events(held.root)).some(event => event.event === 'probe')).toBe(true) }, { timeout: 5000 })
    const heldStarts = (await events(held.root)).filter(event => event.event === 'start')
    expect(heldStarts.length).toBeGreaterThan(0)
    await held.browser.dispose()
    await heldRejected
    await observeExits(held.root, heldStarts.map(event => event.pid))
    expect(held.ctx.agents.get(SessionId('held-metadata'))).toBeUndefined()

    const broken = await load(false, undefined, undefined, undefined, 'on-demand', 'fail')
    await expect(broken.ctx.agents.create({ sessionId: SessionId('failed-metadata') })).rejects.toThrow()
    await observeExits(broken.root, (await events(broken.root)).filter(event => event.event === 'start').map(event => event.pid))
    expect(broken.ctx.agents.get(SessionId('failed-metadata'))).toBeUndefined()

    // A failed probe clears only its own cache entry, so a later explicit
    // activation retries discovery instead of reusing the rejection.
    const failedStarts = (await events(broken.root)).filter(event => event.event === 'start').length
    await expect(broken.ctx.agents.create({ sessionId: SessionId('failed-metadata-retry') })).rejects.toThrow()
    expect((await events(broken.root)).filter(event => event.event === 'start').length).toBeGreaterThan(failedStarts)
    await observeExits(broken.root, (await events(broken.root)).filter(event => event.event === 'start').map(event => event.pid))
    expect(broken.ctx.agents.get(SessionId('failed-metadata-retry'))).toBeUndefined()

    const oversized = await load(false, undefined, undefined, undefined, 'on-demand', 'oversized-instructions')
    await expect(oversized.ctx.agents.create({ sessionId: SessionId('oversized-metadata') }))
      .rejects.toThrow('server instructions exceed maxInstructionBytes (32768)')
    await observeExits(oversized.root, (await events(oversized.root)).filter(event => event.event === 'start').map(event => event.pid))
    expect(oversized.ctx.agents.get(SessionId('oversized-metadata'))).toBeUndefined()

    const failed = await load(false, 'fail', 5000, undefined, 'on-demand')
    const owner = await failed.ctx.agents.create({ sessionId: SessionId('failed-serving'), meta: { cwd: failed.root } })
    expect((await execute(failed.ctx, owner.agent)).isError).toBe(true)
    const recorded = await events(failed.root)
    expect(recorded.filter(event => event.event === 'call')).toEqual([])
    await observeExits(failed.root, recorded.filter(event => event.event === 'start').map(event => event.pid))
  })

  it('closes in-flight serving startup and a live browser on provider teardown', async () => {
    const gated = await load(false, 'gate', 5000, undefined, 'on-demand')
    const gatedOwner = await gated.ctx.agents.create({ sessionId: SessionId('gated-serving'), meta: { cwd: gated.root } })
    const executing = execute(gated.ctx, gatedOwner.agent)
    await vi.waitFor(async () => {
      expect((await events(gated.root)).filter(event => event.event === 'start')).toHaveLength(3)
    }, { timeout: 5000 })
    const gatedStarts = (await events(gated.root)).filter(event => event.event === 'start')
    await gated.browser.dispose()
    expect((await executing).isError).toBe(true)
    await observeExits(gated.root, gatedStarts.map(event => event.pid))

    const live = await load(false, undefined, 5000, undefined, 'on-demand')
    const liveOwner = await live.ctx.agents.create({ sessionId: SessionId('live-serving'), meta: { cwd: live.root } })
    expect((await execute(live.ctx, liveOwner.agent)).isError).toBe(false)
    const liveStarts = (await events(live.root)).filter(event => event.event === 'start')
    expect(liveStarts).toHaveLength(4)
    await live.browser.dispose()
    await observeExits(live.root, liveStarts.map(event => event.pid))
  })
})
