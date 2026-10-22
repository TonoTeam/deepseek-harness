/** Registry composition forwards Host borrow capabilities through register and configure. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    borrowRegistryAgent: TypertLookup<{ readonly id: string }, string>
  }
  interface TypertContextMap {
    borrowRegistryScope: TypertContext<string>
  }
}

describe('Typert registry Host borrowing', () => {
  it('keeps a provider borrow until a resolver overrides it and replaces it only with an explicit borrower', async () => {
    const ctx = new Context()
    const registry = new TypertRegistry(ctx)
    try {
      const release = () => {}
      registry.lookups.register('borrowRegistryAgent', {
        parameter: 'agent',
        wire: 'agentId',
        hostTypeSymbol: '#Agent',
        wireTypeSymbol: '#AgentId',
        resolve: () => ({ id: 'provider' }),
        borrow: id => ({ value: { id }, release }),
      })
      expect(registry.lookups.get('borrowRegistryAgent')?.borrow?.('a')).toEqual({ value: { id: 'a' }, release })
      // A resolver override owns acquisition. The provider's borrower would
      // return a different value than this resolver and must not leak through.
      const disposeConfigured = registry.lookups.configure(
        'borrowRegistryAgent',
        id => ({ id: `configured:${id}` }),
      )
      const withoutBorrow = registry.lookups.get('borrowRegistryAgent')
      await expect(withoutBorrow?.resolve('a')).resolves.toEqual({ id: 'configured:a' })
      expect(withoutBorrow).not.toHaveProperty('borrow')
      await disposeConfigured()

      const configuredRelease = () => {}
      const disposeBorrow = registry.lookups.configure(
        'borrowRegistryAgent',
        id => ({ id: `configured:${id}` }),
        id => ({ value: { id: `borrowed:${id}` }, release: configuredRelease }),
      )
      const withBorrow = registry.lookups.get('borrowRegistryAgent')
      await expect(withBorrow?.resolve('a')).resolves.toEqual({ id: 'configured:a' })
      expect(await withBorrow?.borrow?.('a')).toEqual({ value: { id: 'borrowed:a' }, release: configuredRelease })

      registry.contexts.registerHost('borrowRegistryScope', {
        wire: 'agentId',
        wireTypeSymbol: '#AgentId',
        resolve: () => ctx,
        borrow: _id => ({ value: ctx, release }),
      })
      expect(registry.contexts.getHost('borrowRegistryScope')?.borrow?.('a')).toEqual({ value: ctx, release })
      const disposeHost = registry.contexts.configureHost('borrowRegistryScope', () => ctx)
      expect(registry.contexts.getHost('borrowRegistryScope')).not.toHaveProperty('borrow')
      await disposeHost()
      registry.contexts.configureHost('borrowRegistryScope', () => ctx, _id => ({ value: ctx, release }))
      await expect(registry.contexts.getHost('borrowRegistryScope')?.borrow?.('b')).resolves.toEqual({ value: ctx, release })
      await disposeBorrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
