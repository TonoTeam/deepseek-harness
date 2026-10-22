/** Real Loader composition: JSONL prefix, attachments, and same-identity cold continuation. */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import ApiIdleLoaderFixture, { apiIdleLoaderRef } from './idle-loader-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function jsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(entry.parentPath, entry.name))
}

describe('idle eviction through Loader composition', () => {
  it('preserves the JSONL byte prefix and attachments across same-session cold continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-api-idle-loader-'))
    roots.push(root)
    await mkdir(join(root, 'workspace'))
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    const configPath = join(root, 'cordis.yml')
    const rows = [
      { name: '@deepseek-ai/dsh-llm' },
      { name: '@deepseek-ai/dsh-session' },
      { name: '@deepseek-ai/dsh-session-projection' },
      { name: '@deepseek-ai/dsh-system-prompt' },
      { name: '@deepseek-ai/dsh-tools' },
      { name: '@deepseek-ai/dsh-agent' },
      { name: '@deepseek-ai/dsh-typert-registry' },
      { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'logs'), compression: 'none' } },
      { name: '@deepseek-ai/dsh-session-query' },
      { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: join(root, 'home') } },
      { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
      { name: '@fixture/api-idle-loader' },
    ]
    await writeFile(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      '@deepseek-ai/dsh-llm': LlmRuntime,
      '@deepseek-ai/dsh-session': SessionStore,
      '@deepseek-ai/dsh-session-projection': SessionProjectionRegistry,
      '@deepseek-ai/dsh-system-prompt': SystemPrompt,
      '@deepseek-ai/dsh-tools': ToolRuntime,
      '@deepseek-ai/dsh-agent': AgentRegistry,
      '@deepseek-ai/dsh-typert-registry': TypertRegistry,
      '@deepseek-ai/dsh-session-persistence-jsonl': JsonlSessionPersistence,
      '@deepseek-ai/dsh-session-query': SessionQueryEngine,
      '@deepseek-ai/dsh-attachment-local': AttachmentLocal.default,
      '@deepseek-ai/dsh-agent-loop': AgentLoop,
      '@fixture/api-idle-loader': ApiIdleLoaderFixture,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const fixture = apiIdleLoaderRef.current
    if (apiIdleLoaderRef.error !== undefined) throw apiIdleLoaderRef.error
    if (fixture === undefined) throw new Error('Loader did not construct the API idle fixture')
    const controller = fixture.controller
    const { agent } = await controller.createSession({ cwd: join(root, 'workspace'), reusable: () => true })
    const sessionId = agent.id
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    const attachment = await ctx.attachments.saveFile({ data: new TextEncoder().encode('durable attachment'), name: 'note.txt' })
    const files = await jsonlFiles(join(root, 'logs'))
    expect(files.length).toBeGreaterThan(0)
    const path = files[0] as string
    const prefix = await readFile(path)

    await new Promise(resolve => setTimeout(resolve, 5))
    await controller.sweepIdleAgents()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const same = await controller.resolveAgent(sessionId)
    if ('error' in same) throw new Error('cold resume failed')
    expect(same.agent.id).toBe(sessionId)
    same.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second task' }], source: { kind: 'user' } }))
    await same.agent.whenIdle()
    await ctx.sessions.flush(same.agent.session)
    const grown = await readFile(path)
    expect(grown.subarray(0, prefix.length).equals(prefix)).toBe(true)
    expect(grown.length).toBeGreaterThan(prefix.length)
    const chunks: Uint8Array[] = []
    for await (const chunk of ctx.attachments.readFileStream(attachment)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('durable attachment')
  }, 20_000)
})
