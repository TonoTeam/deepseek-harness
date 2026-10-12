import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '../src/index.ts'

it('polls a stateless catalog without restarting calls; failed discovery retains tools and disposal stops polls', async () => {
  let connected = false
  let fail = false
  let lists = 0
  let activeLists = 0
  let maxActiveLists = 0
  const pending = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''; for await (const chunk of req) body += String(chunk)
    const rpc = JSON.parse(body) as { id?: number; method: string; params: { protocolVersion: string; name?: string } }
    if (rpc.id === undefined) { res.writeHead(202).end(); return }
    let result: unknown = {}
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'poll-fixture', version: '1' } }
    if (rpc.method === 'tools/list') {
      lists += 1; activeLists += 1; maxActiveLists = Math.max(maxActiveLists, activeLists)
      await new Promise(resolve => setTimeout(resolve, 10))
      activeLists -= 1
      if (fail) { res.writeHead(503).end(); return }
      result = { tools: (connected ? ['computer_status', 'coding_sessions_list'] : ['computer_status']).map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }
    }
    if (rpc.method === 'tools/call') { started.resolve(undefined); await pending.promise; result = !connected && rpc.params.name === 'coding_sessions_list'
      ? { isError: true, content: [{ type: 'text', text: 'authorization revoked' }] }
      : { content: [{ type: 'text', text: 'completed' }] } }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  }
  const http = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => { res.writeHead(500).end(String(error)) })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address(); if (!address || typeof address === 'string') throw Error('missing port')
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const names = () => ctx.tools.schemas().map(tool => tool.name).sort()
  try {
    const fiber = ctx.plugin(McpClient, { transport: 'streamable-http', serverName: 'tono', url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, toolCallTimeoutMs: 2000, toolListRefreshMs: 15, failOnStartupError: true })
    await fiber
    expect(names()).toEqual(['mcp__tono__computer_status'])
    const call = ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('poll-inflight'), name: 'mcp__tono__computer_status', arguments: {} })
    await started.promise; connected = true
    await expect.poll(names).toContain('mcp__tono__coding_sessions_list')
    pending.resolve(undefined); expect((await call).content).toEqual([{ type: 'text', text: 'completed' }])
    fail = true; const before = lists
    await expect.poll(() => lists).toBeGreaterThan(before + 1)
    expect(names()).toHaveLength(2); expect(maxActiveLists).toBe(1)
    connected = false
    const denied = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('poll-revoked'), name: 'mcp__tono__coding_sessions_list', arguments: {} })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('authorization revoked')
    fail = false
    await expect.poll(names).toEqual(['mcp__tono__computer_status'])
    await fiber.dispose(); const stopped = lists
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(lists).toBe(stopped); expect(names()).toEqual([])
  } finally {
    pending.resolve(undefined); await ctx.fiber.dispose(); http.closeAllConnections()
    await new Promise<void>(resolve => http.close(() =>{  resolve() }))
  }
}, 10000)

it('rejects invalid polling intervals before acquiring a connection', async () => {
  for (const toolListRefreshMs of [-1, 0.5, Infinity, 2147483648]) {
    const ctx = new Context()
    await expect(McpClient.apply(ctx, { transport: 'streamable-http', serverName: 'bad', url: 'http://127.0.0.1:1', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: false, toolListRefreshMs })).rejects.toThrow('toolListRefreshMs')
    await ctx.fiber.dispose()
  }
})

it('recovers an optional endpoint after startup failure and then polls its catalog', async () => {
  let unavailable = true
  let connected = false
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (unavailable) { res.writeHead(503).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''; for await (const chunk of req) body += String(chunk)
    const rpc = JSON.parse(body) as { id?: number; method: string; params: { protocolVersion: string; name?: string } }
    if (rpc.id === undefined) { res.writeHead(202).end(); return }
    const result = rpc.method === 'initialize'
      ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'recovery-fixture', version: '1' } }
      : rpc.method === 'tools/list'
        ? { tools: (connected ? ['computer_status', 'coding_sessions_list'] : ['computer_status']).map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }
        : {}
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  }
  const http = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => { res.writeHead(500).end(String(error)) })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address(); if (!address || typeof address === 'string') throw Error('missing port')
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const names = () => ctx.tools.schemas().map(tool => tool.name).sort()
  try {
    await ctx.plugin(McpClient, { transport: 'streamable-http', serverName: 'tono', url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, toolCallTimeoutMs: 1000, toolListRefreshMs: 15, failOnStartupError: false, reconnect: { initialDelayMs: 20, maxDelayMs: 20, maxAttempts: 10 } })
    expect(names()).toEqual([])
    unavailable = false
    await expect.poll(names).toEqual(['mcp__tono__computer_status'])
    connected = true
    await expect.poll(names).toContain('mcp__tono__coding_sessions_list')
  } finally {
    await ctx.fiber.dispose(); http.closeAllConnections()
    await new Promise<void>(resolve => http.close(() =>{  resolve() }))
  }
}, 10000)
