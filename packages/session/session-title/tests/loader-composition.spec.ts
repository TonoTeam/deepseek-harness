import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as cleanupPlugin from '@deepseek-ai/dsh-session-title/projection-cache-cleanup'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

/**
 * Create a promise whose settlement the test controls.
 * @returns the pending promise and its resolve callback.
 */
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

/**
 * Boot the title service, projection cache, and cleanup entry through the Loader.
 * @param entries - the cache and cleanup `cordis.yml` entries, in mount order.
 * @returns the composed context before readiness is awaited.
 */
async function beginComposition(entries: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-title-cleanup-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 5',
    '    fallbackMaxBytes: 40',
    '    maxTitleBytes: 80',
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${join(root, 'storage')}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    ...entries,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-projection-cache', SessionProjectionCache],
    ['@deepseek-ai/dsh-session-title/projection-cache-cleanup', cleanupPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  return ctx
}

describe('title-input projection-cache cleanup Loader composition', () => {
  const cacheEntries = [
    "- name: '@deepseek-ai/dsh-session-projection-cache'",
    '  config:',
    '    writeEveryEvents: 100',
    '    writeIntervalMs: 60000',
  ]
  const cleanupEntries = ["- name: '@deepseek-ai/dsh-session-title/projection-cache-cleanup'"]
  const orders: readonly (readonly [string, boolean])[] = [
    ['cleanup registered before the cache', true],
    ['cleanup registered after the cache', false],
  ]

  it.each(orders)('holds Loader readiness until the cleanup write settles (%s)', async (_name, cleanupFirst) => {
    const started = deferred()
    const gate = deferred()
    const discard = vi.spyOn(SessionProjectionCache.prototype, 'discardObsoleteProjectionRows')
      .mockImplementation(async () => {
        started.resolve()
        await gate.promise
      })
    let ready: Promise<void> | undefined
    try {
      const ctx = await beginComposition(
        cleanupFirst ? [...cleanupEntries, ...cacheEntries] : [...cacheEntries, ...cleanupEntries],
      )
      let settled = false
      ready = ctx.loader.await().finally(() => { settled = true })
      await Promise.race([started.promise, ready])
      expect(settled).toBe(false)
      expect(discard).toHaveBeenCalledWith('titleInput', 4, expect.any(AbortSignal))

      gate.resolve()
      await ready
      expect(settled).toBe(true)
    } finally {
      gate.resolve()
      await ready?.catch(() => {})
      discard.mockRestore()
    }
  })
})
