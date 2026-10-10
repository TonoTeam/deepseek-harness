import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createMcpToolDefinition } from '../src/index.ts'

describe('MCP result callback adaptation', () => {
  it.each([false, true])('persists complete MCP metadata on success and failure without putting it in model text (%s)', async (isError) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const meta = { computer_invocation: { schema_version: 'tono.computer-invocation.v1', call_id: 'gateway-call', status: isError ? 'error' : 'ok' }, provider: { nested: [1, { label: 'receipt' }] } }
      let reported: unknown
      ctx.on('tools/result', (_execution, result) => { reported = result.meta })
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'receipt', rawName: 'receipt', description: 'Metadata fixture.', inputSchema: { type: 'object' },
        call: async () => ({ content: [{ type: 'text', text: 'Fixture output' }], isError, _meta: meta }),
      }))
      const result = await ctx.tools.execute({ name: 'receipt', callId: ToolCallId('receipt-call'), arguments: {}, signal: new AbortController().signal })
      expect(result.isError).toBe(isError)
      expect(result.meta).toEqual({ mcp: meta })
      expect(reported).toEqual({ mcp: meta })
      expect(JSON.stringify(result.content)).not.toContain('gateway-call')
      meta.provider.nested.push(99)
      expect(result.meta).not.toEqual({ mcp: meta })
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the exact execution, arguments and canonical structured results', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      let execution: ToolExecution | undefined
      ctx.on('tools/execute', (exec, next) => {
        execution = exec
        return next()
      })
      const call = vi.fn(async () => ({
        content: [{ type: 'text', text: 'Observed window.' }],
        structuredContent: { window: 7 },
      }))
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'native_window', rawName: 'window', description: 'Read the selected window.',
        inputSchema: { type: 'object', properties: { window: { type: 'integer' } } },
        outputSchema: { type: 'object', properties: { window: { type: 'integer' } }, required: ['window'] },
        call,
      }))
      const signal = new AbortController().signal
      const result = await ctx.tools.execute({
        name: 'native_window', callId: ToolCallId('window-call'), arguments: { window: 7 }, signal,
      })
      expect(call).toHaveBeenCalledWith({ window: 7 }, execution)
      expect(execution?.signal).toBe(signal)
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({
        content: [{ type: 'text', text: 'Observed window.' }], structuredContent: { window: 7 },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([null, { content: [42] }, { content: [{ type: 'image' }] }])(
    'rejects invalid external results before exposing content (%j)', async (invalid) => {
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register(createMcpToolDefinition(ctx, {
          name: 'invalid_result', rawName: 'invalid', description: 'External result fixture.',
          inputSchema: { type: 'object' }, call: async () => invalid,
        }))
        const result = await ctx.tools.execute({
          name: 'invalid_result', callId: ToolCallId('invalid-call'), arguments: {},
          signal: new AbortController().signal,
        })
        expect(result.isError).toBe(true)
        expect(result.value).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})
