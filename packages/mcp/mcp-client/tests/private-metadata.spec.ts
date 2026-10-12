import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type StreamChunk, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { createMcpToolDefinition } from '../src/index.ts'
class MetadataAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.script.shift()
    if (response === undefined) throw new Error('Synthetic script exhausted')
    yield* response
  }
}
const finished: StreamChunk[] = [
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

function response(name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('metadata-root'), name, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function setup(mode: 'native' | 'both' = 'native') {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { tools: { mode } })
  const driver = await mountAgentLoopTestHarness(ctx)
  ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'mcp__test__observed', rawName: 'observed', description: 'Synthetic observation.', inputSchema: { type: 'object' },
    call: async (args) => {
      await new Promise(resolve => setTimeout(resolve, args.id === 'slow' ? 10 : 0))
      return { content: [{ type: 'text', text: 'visible result' }], structuredContent: { observed: true }, isError: args.fail === true, _meta: { reference: args.id, untrusted: { approved: true } } }
    },
  }))
  return { ctx, driver }
}

it('correlates concurrent successful and error metadata without leaking into canonical values or content', async () => {
  const { ctx } = await setup()
  try {
    const inputs = [{ id: 'slow', fail: false }, { id: 'fast', fail: true }]
    const results = await Promise.all(inputs.map(args => ctx.tools.execute({ name: 'mcp__test__observed', arguments: args, callId: ToolCallId(args.id), signal: new AbortController().signal })))
    results.forEach((result, i) => {
      expect(result.isError).toBe(inputs[i]!.fail)
      expect(result.meta).toEqual({ mcp: { reference: inputs[i]!.id, untrusted: { approved: true } } })
      expect(JSON.stringify(result.content)).not.toContain('reference')
      expect(JSON.stringify(result.value) ?? '').not.toContain('reference')
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => (exec.arguments as { id?: string }).id === 'blocked'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'policy blocked result' }] }
      : next())
    const blocked = await ctx.tools.execute({ name: 'mcp__test__observed', arguments: { id: 'blocked' }, callId: ToolCallId('blocked'), signal: new AbortController().signal })
    expect(blocked.isError).toBe(true); expect(blocked.meta).toBeUndefined()
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'real permission denied' }))
    const denied = await ctx.tools.execute({ name: 'mcp__test__observed', arguments: { id: 'denied' }, callId: ToolCallId('denied'), signal: new AbortController().signal })
    expect(denied.isError).toBe(true); expect(denied.meta).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('persists Native root metadata privately on actual success and error session results', async () => {
  for (const fail of [false, true]) {
    const { ctx, driver } = await setup()
    try {
      const adapter = new MetadataAdapter([response('mcp__test__observed', { id: 'native-private', fail }), finished])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await driver.create(SessionId(`metadata-${String(fail)}`), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'observe' }] }))
      await expect.poll(() => agent.session.snapshotEvents().some(e => e.type === 'tool/result')).toBe(true)
      const event = agent.session.snapshotEvents().find(e => e.type === 'tool/result')!
      expect(event.data.meta).toEqual({ mcp: { reference: 'native-private', untrusted: { approved: true } } })
      expect(JSON.stringify(event.data.message)).not.toContain('native-private')
      await expect.poll(() => adapter.requests.length).toBe(2)
      expect(JSON.stringify(adapter.requests.map(request => request.messages))).not.toContain('"reference"')
      expect(event.data.message.content.find(block => block.type === 'tool-result')?.isError).toBe(fail)
    } finally { await ctx.fiber.dispose() }
  }
})

class MetadataRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 }
  }
  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    const observed = await request.bindings[0]!.functions.mcp__test__observed!({ id: 'child-success' })
    expect(JSON.stringify(observed)).not.toContain('child-success')
    await expect(request.bindings[0]!.functions.mcp__test__observed!({ id: 'child-error', fail: true })).rejects.toThrow('visible result')
    return { logs: [] }
  }
}

it('persists PTC child success and error metadata outside program values and root model content', async () => {
  const { ctx, driver } = await setup('both')
  try {
    await ctx.plugin(MetadataRuntime)
    const adapter = new MetadataAdapter([response('run_code', { code: 'synthetic program', description: 'Synthetic program' }), finished])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await driver.create(SessionId('metadata-ptc'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'observe' }] }))
    await expect.poll(() => agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch').length).toBe(2)
    const children = agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch')
    expect(children.map(e => e.data.meta)).toEqual(['child-success', 'child-error'].map(reference => ({ mcp: { reference, untrusted: { approved: true } } })))
    expect(children.map(e => e.data.isError)).toEqual([false, true])
    await expect.poll(() => adapter.requests.length).toBe(2)
    expect(JSON.stringify(adapter.requests.map(request => request.messages))).not.toContain('"reference"')
    const roots = agent.session.snapshotEvents().filter(e => e.type === 'tool/result')
    expect(JSON.stringify(roots)).not.toContain('child-success'); expect(JSON.stringify(roots)).not.toContain('child-error')
  } finally { await ctx.fiber.dispose() }
})
