/**
 * Organization requirements audit (aplus-dev-studio-desktop specs/codexcli-org-requirements R10.6, R17).
 *
 * Every clip and refusal the daemon gate makes, and the snapshot's own state changes (stale, unknown,
 * a rejected or partly dropped document), are appended to `<HAPPY_HOME_DIR>/logs/org-requirements.jsonl`
 * — owner-only, rotated at 5 MB, three files kept, as `tool-policy.jsonl` is. A clip that repeats with
 * the same (item, requested, applied) is recorded once per session: an older Desktop sends
 * `bypassPermissions` with every turn and would otherwise write a line per turn.
 *
 * Never recorded: prompts, tool arguments or any other conversation content.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrgRequirementReason } from '@slopus/happy-wire';

/** Snapshot events that are not enforcements. */
export type OrgRequirementsAuditEvent = 'state' | 'document_rejected' | 'document_issue' | 'lkg_too_large' | 'tool_rule_ask';

export interface OrgRequirementsAuditRecord {
    at: number;
    item: string;
    requested: string | null;
    applied: string | null;
    reason: OrgRequirementReason | OrgRequirementsAuditEvent;
    revision: number | null;
    companyId: string | null;
}

export const ORG_AUDIT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const KEPT_FILES = 3;

export interface OrgRequirementsAuditLog {
    /** `once`: skip a record this session already made for the same (item, requested, applied, reason). Returns whether it was written. */
    record(entry: OrgRequirementsAuditRecord, options?: { once?: boolean }): boolean;
}

export function createOrgRequirementsAuditLog(options: {
    path: string;
    sessionId: () => string | null;
    maxBytes?: number;
}): OrgRequirementsAuditLog {
    const maxBytes = options.maxBytes ?? ORG_AUDIT_FILE_MAX_BYTES;
    const seen = new Set<string>();

    const write = (line: string) => {
        try {
            mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
            if (existsSync(options.path) && statSync(options.path).size + line.length > maxBytes) rotate(options.path);
            const created = !existsSync(options.path);
            appendFileSync(options.path, line, { mode: 0o600 });
            if (created) chmodSync(options.path, 0o600);
        } catch {
            // An audit write failure must never change what the gate decided.
        }
    };

    return {
        record: (entry, recordOptions) => {
            if (recordOptions?.once) {
                const key = JSON.stringify([entry.item, entry.requested, entry.applied, entry.reason]);
                if (seen.has(key)) return false;
                seen.add(key);
            }
            write(JSON.stringify({ ...entry, sessionId: options.sessionId() }) + '\n');
            return true;
        },
    };
}

function rotate(path: string): void {
    for (let i = KEPT_FILES - 1; i >= 1; i--) {
        const from = i === 1 ? path : `${path}.${i - 1}`;
        if (existsSync(from)) renameSync(from, `${path}.${i}`);
    }
}
