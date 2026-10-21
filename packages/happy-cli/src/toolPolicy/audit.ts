/**
 * Tool policy audit (aplus-dev-studio specs/agent-tool-policy R9, R16).
 *
 * Every `ask`/`blocked`, and `allow` only where it matters (cua-driver actions other than
 * observing, and write tools), is appended to `<HAPPY_HOME_DIR>/logs/tool-policy.jsonl` — owner-only,
 * rotated at 5 MB, three files kept. `ask`/`blocked` are also kept as the 50 most recent records
 * for agentState `toolPolicy.recent`, which Desktop reads loosely (no new session event type: the
 * happy-wire session protocol is a strict union old clients cannot parse).
 *
 * Never recorded: window titles, typed text, coordinates or any argument value.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolPolicyDecision } from './rules';

export type ToolPolicyOutcome = 'approved' | 'denied' | 'timeout' | 'aborted' | 'unattended';

export interface ToolPolicyAuditRecord {
    at: number;
    tool: string;
    server: 'cua-driver' | 'user';
    action?: string;
    targetCategory?: string;
    targetId?: string;
    decision: ToolPolicyDecision;
    reasonCode: string;
    ruleId: string;
    policyVersion: string;
    outcome?: ToolPolicyOutcome;
}

export const RECENT_LIMIT = 50;
export const AUDIT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const KEPT_FILES = 3;

export interface ToolPolicyAuditLog {
    record(entry: ToolPolicyAuditRecord): void;
    recent(): ToolPolicyAuditRecord[];
}

export function createToolPolicyAuditLog(options: {
    path: string;
    sessionId: () => string | null;
    publishRecent?: (recent: ToolPolicyAuditRecord[]) => void;
    maxBytes?: number;
}): ToolPolicyAuditLog {
    const maxBytes = options.maxBytes ?? AUDIT_FILE_MAX_BYTES;
    const recent: ToolPolicyAuditRecord[] = [];

    const write = (line: string) => {
        try {
            mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
            if (existsSync(options.path) && statSync(options.path).size + line.length > maxBytes) rotate(options.path);
            const created = !existsSync(options.path);
            appendFileSync(options.path, line, { mode: 0o600 });
            if (created) chmodSync(options.path, 0o600);
        } catch {
            // An audit write failure must never change the decision that was made.
        }
    };

    return {
        record: (entry) => {
            write(JSON.stringify({ ...entry, sessionId: options.sessionId() }) + '\n');
            if (entry.decision === 'allow') return;
            recent.push(entry);
            if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
            options.publishRecent?.([...recent]);
        },
        recent: () => [...recent],
    };
}

function rotate(path: string): void {
    for (let i = KEPT_FILES - 1; i >= 1; i--) {
        const from = i === 1 ? path : `${path}.${i - 1}`;
        if (existsSync(from)) renameSync(from, `${path}.${i}`);
    }
}
