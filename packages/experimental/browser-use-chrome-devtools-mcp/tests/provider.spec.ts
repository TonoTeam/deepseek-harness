import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => vi.clearAllMocks())

it('resolves the installed DevTools CLI and explicitly selects isolated headed or headless launch', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chrome', toolCallTimeoutMs: 456 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'chrome-devtools-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 456, startup: 'eager' })
  expect(options.metadata).toBeUndefined()
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=true', '--executable-path', '/custom/chrome'])
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=false'])
  expect('default' in Provider).toBe(false)
})

it('forwards opt-in on-demand launch with metadata-only arguments and rejects attachment use', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', startup: 'on-demand', executablePath: '/custom/chrome' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.startup).toBe('on-demand')
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', '--isolated', '--headless=true', '--executable-path', '/custom/chrome'])
  expect(options.metadata?.args.slice(1)).toEqual(['--no-usage-statistics'])
  expect(() => {
    Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222', startup: 'on-demand' }))
  }).toThrow('on-demand startup is available only for launch mode')
  expect(mountSessionMcp).toHaveBeenCalledTimes(1)
})

it.each([
  ['http://127.0.0.1:9222', '--browser-url'],
  ['wss://browser.example/devtools/browser/id', '--ws-endpoint'],
])('attaches to %s without passing launch flags', (endpoint, flag) => {
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--no-usage-statistics', flag, endpoint])
})

it('rejects trailing endpoint garbage before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost trailing-junk' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})
