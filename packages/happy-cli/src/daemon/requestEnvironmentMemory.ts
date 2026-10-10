/**
 * The environment a client sent with a session's spawn, resume or recovery, kept in daemon
 * memory only (never on disk: it can hold organization secrets).
 *
 * The daemon does not persist request env (`captureSaycodeAgentEnvironment` keeps only its own
 * capability keys), so a resume the daemon starts by itself — e.g. a held browser attention — would
 * start the fresh child without it. A Chat session's organization env exists only in these
 * requests, so such resumes re-send the last one. A daemon restart forgets it.
 */
type Started = { type: string; sessionId?: string }
type WithEnvironment = { environmentVariables?: Record<string, string> }

export function createRequestEnvironmentMemory(limit = 500) {
  const bySession = new Map<string, Record<string, string>>()

  const remember = (sessionId: string | undefined, environment: Record<string, string> | undefined): void => {
    if (!sessionId || !environment || Object.keys(environment).length === 0) return
    bySession.delete(sessionId)
    bySession.set(sessionId, { ...environment })
    if (bySession.size > limit) bySession.delete(bySession.keys().next().value!)
  }
  const startedId = (result: Started): string | undefined =>
    result.type === 'success' ? result.sessionId : undefined

  return {
    recall: (sessionId: string): Record<string, string> | undefined => bySession.get(sessionId),
    rememberSpawn<O extends WithEnvironment, R extends Started>(spawn: (options: O) => Promise<R>) {
      return async (options: O): Promise<R> => {
        const result = await spawn(options)
        remember(startedId(result), options.environmentVariables)
        return result
      }
    },
    /** Resume and recovery: a new-session recovery answers with the id the conversation continues under. */
    rememberResume<O extends WithEnvironment | undefined, R extends Started>(
      resume: (sessionId: string, options: O) => Promise<R>,
      shouldRemember: (sessionId: string, options: O) => boolean = () => true,
    ) {
      return async (sessionId: string, options: O): Promise<R> => {
        const rememberThis = shouldRemember(sessionId, options)
        const result = await resume(sessionId, options)
        if (rememberThis) remember(startedId(result) ?? undefined, options?.environmentVariables)
        return result
      }
    },
  }
}
