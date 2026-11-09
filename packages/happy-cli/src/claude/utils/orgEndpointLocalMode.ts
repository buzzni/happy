/**
 * An organization LLM endpoint session runs in remote (SDK) mode only (aplus specs/org-llm-endpoints r3).
 *
 * The terminal's Claude is the machine's global install: the daemon can neither pin its address, token and models
 * above the settings files nor verify what it applied, so a session that must not reach another backend cannot be
 * handed to it. Refusing is the only way to keep the contract; every way into the terminal asks this module.
 */
import { hasOrgEndpointConversation, isOrgEndpointConversation, isOrgEndpointConversationAnywhere } from './orgEndpointConversation'

export const ORG_ENDPOINT_LOCAL_MODE_REFUSAL = '사내 LLM 엔드포인트로 시작한 대화는 터미널(로컬) 모드로 전환할 수 없습니다. 원격 모드에서 계속하세요.'

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The sentence to show when this session may not use the terminal; undefined when it may. */
export function orgEndpointLocalModeRefusal(env: Record<string, string | undefined>): string | undefined {
    return env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint' ? ORG_ENDPOINT_LOCAL_MODE_REFUSAL : undefined
}

/** Throws the refusal when an endpoint session is about to run in local mode (or reaches the terminal's Claude at all). */
export function assertRemoteOnlyForOrgEndpoint(env: Record<string, string | undefined>, mode: 'local' | 'remote'): void {
    const refusal = mode === 'local' ? orgEndpointLocalModeRefusal(env) : undefined
    if (refusal) throw new Error(refusal)
}

/**
 * The refusal when a launch that is not the endpoint session itself would continue a conversation that ran on one:
 * `happy claude --resume <id>` (what `happy resume` runs), Claude's own picker (a bare `--resume`) where such a
 * conversation is listed, or `--continue` that picks one as this directory's last. Such a launch carries no endpoint
 * env, so `orgEndpointLocalModeRefusal` cannot see it, and the conversation would go on under this machine's own Claude
 * login in either mode. The conversations are known by their mark (orgEndpointConversation). The machine's own `claude`
 * — and its in-session `/resume` — is out of reach: this closes Happy's ways in, not the user's.
 */
export function orgEndpointContinuationRefusal(input: {
    env: Record<string, string | undefined>
    claudeArgs: string[] | undefined
    projectDir: string
    lastConversation: () => string | null
}): string | undefined {
    if (input.env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint') return undefined
    const args = input.claudeArgs ?? []
    // `--resume <value>`, `--resume=<value>`, `-r <value>`; a value that is not an id is the picker's search term.
    const operands = args.flatMap((arg, i) => {
        const joined = /^(?:--resume|-r)=(.*)$/.exec(arg)
        if (joined) return [joined[1]]
        if (arg !== '--resume' && arg !== '-r') return []
        return [args[i + 1] === undefined || args[i + 1].startsWith('-') ? '' : args[i + 1]]
    })
    const named = operands.filter((value) => CLAUDE_SESSION_ID.test(value)).map((id) => id.toLowerCase())
    const picker = operands.some((value) => !CLAUDE_SESSION_ID.test(value))
    const last = args.includes('--continue') || args.includes('-c') ? input.lastConversation() : null
    const bound = named.some((id) => isOrgEndpointConversationAnywhere(input.projectDir, id))
        || (picker && hasOrgEndpointConversation(input.projectDir))
        || (last !== null && isOrgEndpointConversation(input.projectDir, last))
    return bound ? ORG_ENDPOINT_LOCAL_MODE_REFUSAL : undefined
}
