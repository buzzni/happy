/**
 * The plan tier of one Claude SDK query's login (aplus specs/org-member-ai-plan-usage H2).
 *
 * The run's own `accountInfo()` decides whose login it is and its subscription
 * (src/usage/aiPlanTier.ts). Only a Max login needs more: `claude auth status
 * --json` names the multiplier (Claude Code ≥ 2.1.319 reports `planTier`), and it
 * counts only when it describes that same login. That read spawns Claude Code, so
 * one answer is shared by the process for ten minutes — an account switch shows
 * up within that window.
 *
 * Usage is never held for this: until the observation answers, `current()` is null
 * and the event leaves without a plan.
 */
import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { claudePlanTier, type AiPlanTierSource } from '@/usage/aiPlanTier';

const STATUS_TTL_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The same executable the SDK query runs when `HAPPY_CLAUDE_PATH` names one; otherwise `claude` on PATH. */
function runClaudeAuthStatus(env: NodeJS.ProcessEnv): Promise<string> {
    const configured = env.HAPPY_CLAUDE_PATH;
    const args = ['auth', 'status', '--json'];
    const [command, commandArgs] = configured && isAbsolute(configured)
        ? (/\.[cm]?js$/.test(configured) ? [process.execPath, [configured, ...args]] : [configured, args])
        : ['claude', args];
    return new Promise((resolve, reject) => {
        execFile(command, commandArgs, { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, env }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

export function createClaudeAuthStatusCache(deps: { run: () => Promise<string>; now?: () => number; ttlMs?: number }) {
    let cached: { at: number; status: Promise<unknown> } | null = null;
    return {
        /** The parsed status, or null when the read or the JSON failed. */
        read(): Promise<unknown> {
            const now = (deps.now ?? Date.now)();
            if (!cached || now - cached.at >= (deps.ttlMs ?? STATUS_TTL_MS)) {
                cached = { at: now, status: deps.run().then((text): unknown => JSON.parse(text)).catch(() => null) };
            }
            return cached.status;
        },
    };
}

const processAuthStatus = createClaudeAuthStatusCache({ run: () => runClaudeAuthStatus(process.env) });

export function observeClaudeQueryPlanTier(
    query: { accountInfo(): Promise<AccountInfo> },
    deps: {
        /** The environment the query's child was spawned with (it got a copy of process.env). */
        env: Record<string, string | undefined>;
        readAuthStatus: () => Promise<unknown>;
        timeoutMs: number;
    } = { env: { ...process.env }, readAuthStatus: () => processAuthStatus.read(), timeoutMs: DEFAULT_TIMEOUT_MS },
): AiPlanTierSource {
    let tier: string | null = null;
    void (async () => {
        const account = await withDeadline(query.accountInfo(), deps.timeoutMs);
        tier = claudePlanTier({ account, env: deps.env });
        if (tier !== 'claude:max') return;
        const authStatus = await withDeadline(deps.readAuthStatus(), deps.timeoutMs);
        tier = claudePlanTier({ account, env: deps.env, authStatus });
    })().catch(() => {
        // Every failure reports no plan; the usage itself is unaffected.
    });
    return { current: (provider) => (provider === 'anthropic' ? tier : null) };
}
