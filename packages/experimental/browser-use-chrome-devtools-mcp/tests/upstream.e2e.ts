import { it } from 'vitest'
import { verifyMcpBrowser } from '../../browser-use-runtime/tests/mcp-upstream.ts'
import * as Provider from '../src/index.ts'

it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined).each([
  ['launch', 'eager'],
  ['launch', 'on-demand'],
  ['attach', 'eager'],
] as const)(
  'uses the pinned Chrome DevTools MCP server to %s Chromium with %s startup and visit a loopback page',
  async (mode, startup) => verifyMcpBrowser(Provider, 'chrome-devtools-mcp', { name: 'new_page', arguments: url => ({ url }) }, mode, startup),
)
