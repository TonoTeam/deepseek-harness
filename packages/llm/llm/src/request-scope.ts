/** Process-local route pinned to a host-admitted request and its in-process delegates. */
export interface ModelRequestContext {
  readonly requestId: string
  readonly signingKey: string
  readonly maxOutputTokens: number
  readonly contextWindowTokens: number
}

/** Resolved provider and model paired with the admitted request. */
export interface ModelRequestScope extends ModelRequestContext {
  readonly provider: string
  readonly model: string
}

const scopes = new Map<string, ModelRequestScope>()

/**
 * Read the process-local model binding.
 * @param sessionId - Session whose current binding is requested.
 * @returns the binding when that Session has one.
 */
export function modelRequestScope(sessionId: string | undefined): ModelRequestScope | undefined {
  return sessionId === undefined ? undefined : scopes.get(sessionId)
}

/**
 * Install an immutable copy of the request binding for a Session.
 * @param sessionId - Session that owns the binding.
 * @param scope - Admitted request and resolved model.
 */
export function setModelRequestScope(sessionId: string, scope: ModelRequestScope): void {
  scopes.set(sessionId, Object.freeze({ ...scope }))
}

/**
 * Remove a Session's process-local model binding.
 * @param sessionId - Session whose binding has ended.
 */
export function clearModelRequestScope(sessionId: string): void {
  scopes.delete(sessionId)
}
