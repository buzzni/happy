/**
 * An organization LLM endpoint session runs in remote (SDK) mode only (aplus specs/org-llm-endpoints r3).
 *
 * The terminal's Claude is the machine's global install: the daemon can neither pin its address, token and models
 * above the settings files nor verify what it applied, so a session that must not reach another backend cannot be
 * handed to it. Refusing is the only way to keep the contract; every way into the terminal asks this module.
 */
import { isOrgEndpointBoundRecord } from '@/daemon/orgEndpointSessionMarker'
import type { PersistedSession } from '@/persistence'

export const ORG_ENDPOINT_LOCAL_MODE_REFUSAL = '사내 LLM 엔드포인트로 시작한 대화는 터미널(로컬) 모드로 전환할 수 없습니다. 원격 모드에서 계속하세요.'

/** The flags with which Claude continues a conversation it picks itself when no id follows. */
const PICKING_FLAGS = new Set(['--continue', '-c', '--resume', '-r'])

/** The sentence to show when this session may not use the terminal; undefined when it may. */
export function orgEndpointLocalModeRefusal(env: Record<string, string | undefined>): string | undefined {
    return env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint' ? ORG_ENDPOINT_LOCAL_MODE_REFUSAL : undefined
}

/** Throws the refusal when an endpoint session is about to run in local mode. */
export function assertRemoteOnlyForOrgEndpoint(env: Record<string, string | undefined>, mode: 'local' | 'remote'): void {
    const refusal = mode === 'local' ? orgEndpointLocalModeRefusal(env) : undefined
    if (refusal) throw new Error(refusal)
}

/**
 * The refusal when a launch that is not the endpoint session itself would continue a conversation that ran on one:
 * `happy claude --resume <id>` (what `happy resume` runs), or a bare `--resume`/`--continue` that picks this directory's
 * last conversation. Such a launch carries no endpoint env, so `orgEndpointLocalModeRefusal` cannot see it, and the
 * conversation would go on under this machine's own Claude login in either mode. Only conversations this machine
 * recorded are known here (`happy resume` also reads the session's metadata marker), and the machine's own `claude`
 * is out of reach: this closes Happy's ways in, not the user's.
 */
export function orgEndpointContinuationRefusal(input: {
    env: Record<string, string | undefined>
    claudeArgs: string[] | undefined
    lastConversation: () => string | null
    records: Record<string, PersistedSession>
}): string | undefined {
    if (input.env.HAPPY_AI_AUTH_SOURCE === 'org-endpoint') return undefined
    const bound = Object.values(input.records).filter(isOrgEndpointBoundRecord)
        .map((record) => record.metadata.claudeSessionId).filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (bound.length === 0) return undefined
    const args = input.claudeArgs ?? []
    // Every spelling Claude accepts (`--resume <id>`, `--resume=<id>`, `-r <id>`) names the id within one argument.
    const named = args.some((arg) => bound.some((id) => arg.includes(id)))
    const picks = args.some((arg, i) => PICKING_FLAGS.has(arg) && (arg === '--continue' || arg === '-c' || !args[i + 1] || args[i + 1].startsWith('-')))
    const last = !named && picks ? input.lastConversation() : null
    return named || (last !== null && bound.includes(last)) ? ORG_ENDPOINT_LOCAL_MODE_REFUSAL : undefined
}
