import { randomUUID } from 'node:crypto'
/**
 * aplus-dev-studio specs/org-agent-plan §6.3-4 — which Codex threads belong to organization agent plan sessions.
 *
 * A plan thread resumed without the plan provider would run on the machine's own Codex login (and the
 * multi-auth proxy). The daemon cannot see thread ids — Codex starts a thread on the first turn, long after
 * the session reported itself — so the runner leaves a secret-free marker per thread in the daemon's home, and
 * every launcher that can resume a thread checks it: the daemon for a spawn without a grant envelope, the
 * runner for `happy codex --resume`, and anything else (Desktop's local `codex resume`) can read the same file.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_PLAN_DESCRIPTOR_VERSION } from './agentPlanLaunch'

/** Spawn seed: where the runner records markers (the daemon's home, not a staged per-user home). */
export const AGENT_PLAN_THREADS_DIR_ENV = 'HAPPY_INITIAL_AGENT_PLAN_THREADS_DIR'

export const AGENT_PLAN_THREADS_DIR_NAME = 'agent-plan-threads'

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/

export function agentPlanThreadsDir(happyHomeDir: string): string {
    return join(happyHomeDir, AGENT_PLAN_THREADS_DIR_NAME)
}

function markerPath(dir: string, threadId: string): string | null {
    return THREAD_ID.test(threadId) ? join(dir, `${threadId}.json`) : null
}

/** True when `threadId` was run by a plan session. An id that is not a Codex thread id is never one. */
export function isAgentPlanThread(dir: string, threadId: string): boolean {
    const path = markerPath(dir, threadId)
    return path !== null && existsSync(path)
}

/** Owner-only, no secret: which session and grant ran the thread. Idempotent. */
export function recordAgentPlanThreadSync(
    dir: string,
    threadId: string,
    record: { sessionId: string; grantId: string; agent?: 'claude' | 'codex' },
): void {
    const path = markerPath(dir, threadId)
    if (!path) throw new Error('not a Codex thread id')
    if (existsSync(path) && record.agent !== 'claude') return
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
    writeFileSync(temp, JSON.stringify({
        version: 1,
        source: 'platform-plan',
        agent: record.agent ?? 'codex',
        sessionId: record.sessionId,
        grantId: record.grantId,
        descriptorVersion: AGENT_PLAN_DESCRIPTOR_VERSION,
        recordedAt: Date.now(),
    }), { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
    } finally { rmSync(temp, { force: true }) }
}

/** Read the authority marker; unreadable existing markers refuse a resume. */
export function readAgentPlanThread(dir: string, threadId: string): { grantId: string; sessionId: string; agent?: string } | null {
    const path = markerPath(dir, threadId)
    if (!path || !existsSync(path)) return null
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.source !== 'platform-plan' || typeof value.grantId !== 'string' || typeof value.sessionId !== 'string') throw new Error('agent_plan_marker_invalid')
    return value
}
export function hasClaudeAgentPlanThread(dir: string): boolean {
    if (!existsSync(dir)) return false
    return readdirSync(dir).some(name => {
        if (!name.endsWith('.json')) return false
        try { return readAgentPlanThread(dir, name.slice(0, -5))?.agent === 'claude' }
        catch { return true } // A picker is guarded; fresh launches never scan this directory.
    })
}

export async function recordAgentPlanThread(dir: string, threadId: string, record: { sessionId: string; grantId: string; agent?: 'claude' | 'codex' }): Promise<void> {
    recordAgentPlanThreadSync(dir, threadId, record)
}
