import { it } from 'vitest'
import { verifyMcpBrowser } from '../../browser-use-runtime/tests/mcp-upstream.ts'
import * as Provider from '../src/index.ts'

it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined).each([
  ['launch', 'eager'],
  ['launch', 'on-demand'],
  ['attach', 'eager'],
] as const)(
  'uses the pinned Playwright MCP server to %s Chromium with %s startup and visit a loopback page',
  async (mode, startup) => verifyMcpBrowser(Provider, 'playwright-mcp', { name: 'browser_navigate', arguments: url => ({ url }) }, mode, startup),
)
