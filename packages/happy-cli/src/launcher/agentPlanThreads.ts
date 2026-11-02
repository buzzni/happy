/**
 * aplus-dev-studio specs/org-agent-plan §6.3-4 — which Codex threads belong to organization agent plan sessions.
 *
 * A plan thread resumed without the plan provider would run on the machine's own Codex login (and the
 * multi-auth proxy). The daemon cannot see thread ids — Codex starts a thread on the first turn, long after
 * the session reported itself — so the runner leaves a secret-free marker per thread in the daemon's home, and
 * every launcher that can resume a thread checks it: the daemon for a spawn without a grant envelope, the
 * runner for `happy codex --resume`, and anything else (Desktop's local `codex resume`) can read the same file.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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
export async function recordAgentPlanThread(
    dir: string,
    threadId: string,
    record: { sessionId: string; grantId: string },
): Promise<void> {
    const path = markerPath(dir, threadId)
    if (!path) throw new Error('not a Codex thread id')
    if (existsSync(path)) return
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify({
        version: 1,
        source: 'platform-plan',
        sessionId: record.sessionId,
        grantId: record.grantId,
        descriptorVersion: AGENT_PLAN_DESCRIPTOR_VERSION,
        recordedAt: Date.now(),
    }), { mode: 0o600 })
}
