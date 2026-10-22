/** Generic invocation-owned values returned by synchronous Client Context resolvers. */

/** Shared identity across independently bundled Context providers and Gateway. */
export const TYPERT_OWNED_VALUE = Symbol.for('dsh.typert.owned-value')

/** A borrowed payload paired with the invocation owner's idempotent cleanup. */
export interface TypertOwnedValue<Value> extends Disposable {
  readonly [TYPERT_OWNED_VALUE]: true
  readonly value: Value
}

/**
 * Transfer cleanup ownership without adding another resource reference count.
 * @param value - resolved payload passed to the invocation.
 * @param release - non-throwing synchronous release, called at most once.
 * @returns an owned payload disposed after invocation and reply settlement.
 */
export function typertOwnedValue<Value>(value: Value, release: () => void): TypertOwnedValue<Value> {
  let active = true
  return {
    [TYPERT_OWNED_VALUE]: true,
    value,
    [Symbol.dispose]() {
      if (!active) return
      active = false
      release()
    },
  }
}

/**
 * Identify invocation-owned values using the shared marker.
 * @param value - borrowed or owned resolver result.
 * @returns whether the result carries invocation cleanup.
 */
export function isTypertOwnedValue(value: unknown): value is TypertOwnedValue<unknown> {
  return typeof value === 'object' && value !== null
    && TYPERT_OWNED_VALUE in value && value[TYPERT_OWNED_VALUE] === true
}

/** A Host value borrowed for one invocation, with synchronous idempotent cleanup. */
export interface TypertBorrowedValue<Value> {
  readonly value: Value
  /** Release the underlying usage claim; synchronous, idempotent, and non-throwing. */
  release(): void
}

/**
 * Host-only optional acquisition used instead of plain resolution when a
 * provider can hold the exact object for the invocation lifetime.
 * @param id - validated wire identity.
 * @returns the borrowed value and its release capability.
 */
export type TypertBorrower<Value, Wire> = (
  id: Wire,
) => TypertBorrowedValue<Value> | Promise<TypertBorrowedValue<Value>>
