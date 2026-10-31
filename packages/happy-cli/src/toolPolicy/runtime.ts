/**
 * One session's tool policy runtime (aplus-dev-studio specs/agent-tool-policy plan "결정: 집행 위치").
 *
 * Assembles the gate every adapter calls — the Claude PreToolUse hook, the cua-driver shadow proxy
 * and the stdio bridge — with the per-process secret those out-of-process adapters present to the
 * session hook server, the machine policy loader, target resolver, grants and audit log — and the
 * session RPCs that list and revoke those grants (grantControl.ts).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createToolPolicyAuditLog, type ToolPolicyAuditRecord } from './audit';
import { toolPolicyFilePath } from './claudeHook';
import { registerToolPolicyGrantRpcs } from './grantControl';
import { createPolicyGrantStore, type PolicyGrantStore } from './grants';
import type { OrgToolRules } from './evaluate';
import { createToolPolicyGate, type PolicyApprover, type ToolPolicyGate } from './policyGate';
import { createMachinePolicyLoader } from './rules';
import { createTargetResolver } from './targetResolver';

export interface ToolPolicyRuntime {
    gate: ToolPolicyGate;
    grants: PolicyGrantStore;
    secret: string;
    secretFile: string;
    policyFile: string;
    dispose(): void;
}

export function createToolPolicyRuntime(input: {
    happyHomeDir: string;
    sessionId: () => string | null;
    publishRecent: (recent: ToolPolicyAuditRecord[]) => void;
    approver: () => PolicyApprover | null;
    /** Read on every decision: the current turn's attendance (codexcli-approval-session-binding R10a). */
    unattended: () => boolean;
    terminalPrompt: () => boolean;
    /** The session's organization tool rules (codexcli-org-requirements R10.4); absent outside any organization. */
    orgRules?: () => OrgToolRules | null;
    orgAudit?: (entry: { tool: string; reasonCode: string; ruleId: string }) => void;
    grantTtlMs: number | null;
    /** The session's RPC handlers; every adapter shares the one grant store these revoke from. */
    rpc: Parameters<typeof registerToolPolicyGrantRpcs>[0];
}): ToolPolicyRuntime {
    const secret = randomBytes(32).toString('hex');
    const hooksDir = join(input.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    const secretFile = join(hooksDir, `policy-secret-${process.pid}`);
    writeFileSync(secretFile, secret, { mode: 0o600 });
    chmodSync(secretFile, 0o600);

    const policyFile = toolPolicyFilePath(input.happyHomeDir);
    const grants = createPolicyGrantStore({ grantTtlMs: input.grantTtlMs });
    registerToolPolicyGrantRpcs(input.rpc, grants);
    const gate = createToolPolicyGate({
        loadMachinePolicy: createMachinePolicyLoader(policyFile),
        resolver: createTargetResolver(),
        grants,
        audit: createToolPolicyAuditLog({
            path: join(input.happyHomeDir, 'logs', 'tool-policy.jsonl'),
            sessionId: input.sessionId,
            publishRecent: input.publishRecent,
        }),
        approver: input.approver,
        unattended: input.unattended,
        terminalPrompt: input.terminalPrompt,
        ...(input.orgRules ? { orgRules: input.orgRules } : {}),
        ...(input.orgAudit ? { orgAudit: input.orgAudit } : {}),
        // A call without a provider id (no `_meta`) still gets a request id no other call shares.
        newRequestId: () => `policy-${randomUUID()}`,
    });

    return {
        gate,
        grants,
        secret,
        secretFile,
        policyFile,
        dispose: () => {
            grants.clear();
            try { unlinkSync(secretFile); } catch { /* already gone */ }
        },
    };
}
