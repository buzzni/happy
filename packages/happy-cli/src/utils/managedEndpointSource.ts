/** Runtime protections shared by host-managed endpoint sessions. */
export function isManagedEndpointSource(env: Record<string, string | undefined>): boolean {
    return env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint' || env.HAPPY_AI_AUTH_SOURCE === 'personal-endpoint'
}

/** Plan sources also pin their model transport, but retain their own delegation and policy rules. */
export function isPinnedModelSource(env: Record<string, string | undefined>): boolean {
    return isManagedEndpointSource(env) || env.HAPPY_AI_AUTH_SOURCE === 'platform-plan' || env.HAPPY_AI_AUTH_SOURCE === 'platform-plan-pending'
}
