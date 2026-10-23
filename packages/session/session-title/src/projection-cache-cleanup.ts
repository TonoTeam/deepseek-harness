/**
 * Startup maintenance for the reference-only title-input projection: remove
 * obsolete title-input rows left by earlier checkpoint state versions before
 * the cold session list is served. The cache owns the durable rewrite; this
 * plugin owns the boot barrier and cancellation lifetime.
 * @module @deepseek-ai/dsh-session-title/projection-cache-cleanup
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { TITLE_INPUT_KEY, TITLE_INPUT_STATE_VERSION } from './title-input.ts'

/** Cordis function-plugin name. */
export const name = 'session-title-projection-cache-cleanup'

/** Title and projection-cache services required before obsolete rows can be removed. */
export const inject = ['sessionTitle', 'sessionProjectionCache']

/**
 * Await one pass that discards title-input checkpoint rows older than the
 * current reference-only state version. The Loader holds boot readiness on the
 * entry fiber until this settles; a fiber disposal aborts the pass through the
 * cache's cancellation checks.
 * @param ctx - context providing the title service and the projection cache.
 * @returns after the cache has updated every matching cold record.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(
    () => () => { lifetime.abort(new Error('session-title projection-cache cleanup disposed')) },
    'sessionTitle.projectionCacheCleanup',
  )
  await ctx.sessionProjectionCache.discardObsoleteProjectionRows(
    TITLE_INPUT_KEY,
    TITLE_INPUT_STATE_VERSION,
    lifetime.signal,
  )
}
