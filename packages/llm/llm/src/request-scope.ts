/** Process-local route pinned to a host-admitted request and its in-process delegates. */
export interface ModelRequestContext {
  readonly requestId: string
  readonly signingKey: string
  readonly maxOutputTokens: number
  readonly contextWindowTokens: number
}

export interface ModelRequestScope extends ModelRequestContext {
  readonly provider: string
  readonly model: string
}

const scopes = new Map<string, ModelRequestScope>()

export function modelRequestScope(sessionId: string | undefined): ModelRequestScope | undefined {
  return sessionId === undefined ? undefined : scopes.get(sessionId)
}

export function setModelRequestScope(sessionId: string, scope: ModelRequestScope): void {
  scopes.set(sessionId, Object.freeze({ ...scope }))
}

export function clearModelRequestScope(sessionId: string): void {
  scopes.delete(sessionId)
}
