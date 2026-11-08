/**
 * An organization LLM endpoint session runs in remote (SDK) mode only (aplus specs/org-llm-endpoints r3).
 *
 * The terminal's Claude is the machine's global install: the daemon can neither pin its address, token and models
 * above the settings files nor verify what it applied, so a session that must not reach another backend cannot be
 * handed to it. Refusing is the only way to keep the contract; every way into the terminal asks this one function.
 */
const REFUSAL = '사내 LLM 엔드포인트로 시작한 대화는 터미널(로컬) 모드로 전환할 수 없습니다. 원격 모드에서 계속하세요.'

/** The sentence to show when this session may not use the terminal; undefined when it may. */
export function orgEndpointLocalModeRefusal(env: Record<string, string | undefined>): string | undefined {
    return env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint' ? REFUSAL : undefined
}

/** Throws the refusal when an endpoint session is about to run in local mode. */
export function assertRemoteOnlyForOrgEndpoint(env: Record<string, string | undefined>, mode: 'local' | 'remote'): void {
    const refusal = mode === 'local' ? orgEndpointLocalModeRefusal(env) : undefined
    if (refusal) throw new Error(refusal)
}
