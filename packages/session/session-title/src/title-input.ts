/**
 * Internal definition of the reference-only `titleInput` projection and the
 * exact eligible-message extraction shared by its fold and fallback. Keeping
 * the key and state version here lets the projection-cache cleanup entry use
 * them without importing the whole service.
 * @module @deepseek-ai/dsh-session-title/src/title-input
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { normalizeSessionTitle } from './normalize.ts'
import type { SessionTitleUserMessage, TitleInputState } from './types.ts'

/** Projection key owned by the title service. */
export const TITLE_INPUT_KEY = 'titleInput' as const

/** Current version of the seq-only title-input checkpoint state. */
export const TITLE_INPUT_STATE_VERSION = 4

/** State before any eligible human message. */
const EMPTY_TITLE_INPUT: TitleInputState = { firstSeq: null, count: 0, lastSeq: null }

const titleInputSeq = zod.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .transform(SessionSeq)

const titleInputStateSchema: ZodType<TitleInputState> = zod.object({
  firstSeq: titleInputSeq.nullable(),
  count: zod.number().int().nonnegative(),
  lastSeq: titleInputSeq.nullable(),
}).strict().superRefine((state, context) => {
  const empty = state.firstSeq === null && state.lastSeq === null && state.count === 0
  const populated = state.firstSeq !== null
    && state.lastSeq !== null
    && state.count > 0
    && state.firstSeq <= state.lastSeq
  if (!empty && !populated) {
    context.addIssue({
      code: 'custom',
      message: 'title input state must pair its count with first and last message seqs',
    })
  }
})

/**
 * Extract one eligible human text message from a session event with the exact
 * fallback and provider-input rules: direct `user` source, text blocks joined
 * by one newline, and a non-empty normalized title.
 * @param event - any session event.
 * @returns the eligible message, or undefined for any other event.
 */
export function sessionTitleUserMessageOf(event: SessionEvent): SessionTitleUserMessage | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const content = event.data.content
  const text = content
    .filter((block): block is Extract<(typeof content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) return undefined
  return { seq: event.seq, text }
}

/** Reference-only title-input unit: first and latest eligible seqs plus their count. */
export const titleInputProjectionDefinition = {
  key: TITLE_INPUT_KEY,
  stateVersion: TITLE_INPUT_STATE_VERSION,
  stateSchema: titleInputStateSchema,
  init: () => EMPTY_TITLE_INPUT,
  apply: (state, event) => {
    const message = sessionTitleUserMessageOf(event)
    if (message === undefined) return state
    return {
      firstSeq: state.firstSeq ?? message.seq,
      count: state.count + 1,
      lastSeq: message.seq,
    }
  },
} satisfies ProjectionDefinition<typeof TITLE_INPUT_KEY, TitleInputState>
