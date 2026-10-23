/**
 * Child probe for the open-time bootstrap snapshot lifetime. Run with
 * `--expose-gc`; it opens a real {@link DomainFacility} over a synthetic
 * backend and reports whether the raw `loadAll` snapshot became collectable
 * while the returned domain stayed open. The backend's `loadAll` builds the
 * snapshot locally, so only the WeakRefs below survive that call.
 * @module
 */

import { setImmediate as nextTurn } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Storage, { type KvUnit, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { z } from 'zod'
import { DomainFacility, defineDomain, domainTable } from '../../src/index.ts'

const probes: { name: 'snapshot' | 'raw record'; ref: WeakRef<object> }[] = []

const backend: StorageBackend = {
  kv: {
    open: async (): Promise<KvUnit> => ({
      loadAll: async () => {
        // Constructed inside this call: the backend keeps no field or module
        // binding to it, so only the opened domain can retain it.
        const rawRecord = { label: 'bootstrap', count: 1 }
        const snapshot = { tables: { rows: { seed: rawRecord } }, global: null }
        probes.push({ name: 'snapshot', ref: new WeakRef(snapshot) })
        probes.push({ name: 'raw record', ref: new WeakRef(rawRecord) })
        return snapshot
      },
      putRecord: async () => {},
      deleteRecord: async () => {},
      setGlobal: async () => {},
      close: async () => {},
    }),
  },
  close: async () => {},
}

const recordSchema = z.object({ label: z.string(), count: z.number() })
const spec = defineDomain({
  name: 'bootstrap_probe',
  version: 1,
  tables: { rows: domainTable<string, z.infer<typeof recordSchema>>(recordSchema) },
})

const collectGarbage = globalThis.gc
if (collectGarbage === undefined) throw new Error('bootstrap retention probe requires --expose-gc')

const ctx = new Context()
await ctx.plugin(Storage)
ctx.storage.backend.register('probe', backend)
const facility = new DomainFacility(ctx, { backend: 'probe' })

const domain = await facility.open(spec)
try {
  if (probes.length !== 2) throw new Error('open did not register the loadAll probes')
  const live = domain.table('rows')
  await live.put('seed', { label: 'replacement', count: 2 })
  if (live.get('seed')?.label !== 'replacement') throw new Error('live table did not take the replacement')

  // Observe collection after a fresh event-loop turn, then a bounded number
  // of full collections, so earlier jobs holding the open activation finish.
  await nextTurn()
  for (let turn = 0; turn < 4; turn++) {
    collectGarbage()
    await nextTurn()
  }

  const retained = probes.filter(probe => probe.ref.deref() !== undefined).map(probe => probe.name)
  const result = {
    collected: retained.length === 0,
    retained,
    open: live.size === 1 && live.get('seed')?.label === 'replacement',
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await domain.close()
  await ctx.fiber.dispose()
}
