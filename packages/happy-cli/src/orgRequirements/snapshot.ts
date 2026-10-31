/**
 * Which organization requirements one session enforces right now (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements R14–R16, plan 결정 3·5).
 *
 * Fed by every `/api/me/mcp-config` response the session process already gets (the start fetch, the
 * per-turn MCP sync, the five-minute requirements refresh) — never a fetch of its own. Studio's four
 * answers mean different things:
 * - `ok`: the document. With items it becomes the last known good and the session's scopes are
 *   recorded as belonging to its organization; with no items the organization released everything
 *   (Studio's kill switch is this), so that organization's last known good goes too.
 * - `no-company`: this session is in no organization. Its scopes stop pointing anywhere; other
 *   organizations' documents are left alone.
 * - `unresolved`, `unavailable`, a response without the fields (older Studio) or no response: keep the
 *   document in use, else load the last known good of the organization a scope last resolved to, else
 *   run without requirements and say `unknown`. A failed lookup never releases a policy.
 *
 * The last known good never expires (Q1); after 24 hours without a successful lookup it is `stale`.
 */

import type { OrgRequirementsAgentState, OrgRequirementsStatus } from '@slopus/happy-wire';
import type { OrgRequirementsAuditLog } from './audit';
import { OrgRequirementsDocumentError, parseOrgRequirements, type OrgRequirementsDocument } from './resolve';
import type { OrgRequirementsStore, OrgScopeKey } from './store';

export const ORG_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const ORG_REFRESH_AFTER_MS = 5 * 60 * 1000;

export type OrgRequirementsFetchOutcome =
    /** No mcp-config URL: a local run with no Studio behind it, so no organization either. */
    | { kind: 'not-configured' }
    /** No usable response: network, timeout, HTTP error, a body that is not a config. */
    | { kind: 'failed' }
    /** `status` undefined: a Studio that does not serve requirements. */
    | { kind: 'response'; status: OrgRequirementsStatus | undefined; requirements: unknown };

export interface OrgRequirementsSnapshot {
    /** The document in force; null when there is nothing to enforce. */
    current(): OrgRequirementsDocument | null;
    /** agentState `orgRequirements` without `lastEnforcement`; null outside any organization. */
    publicState(): Pick<OrgRequirementsAgentState, 'state' | 'revision'> | null;
    ingest(outcome: OrgRequirementsFetchOutcome): void;
    /** A turn is starting and the snapshot is older than five minutes: refresh in the background. */
    shouldRefresh(): boolean;
    onChange(listener: () => void): () => void;
}

export function createOrgRequirementsSnapshot(options: {
    store: OrgRequirementsStore;
    audit: OrgRequirementsAuditLog;
    /** Read at every ingest: the server session id exists only after the session is created. */
    scopes: () => OrgScopeKey[];
    now?: () => number;
}): OrgRequirementsSnapshot {
    const now = options.now ?? Date.now;
    let document: OrgRequirementsDocument | null = null;
    /** When `document` was last received from Studio (by this process or the one that stored it). */
    let receivedAt = 0;
    let unknown = false;
    let lastLookupAt: number | null = null;
    let reportedStale = false;
    const listeners = new Set<() => void>();

    const audit = (item: string, applied: string | null, reason: Parameters<OrgRequirementsAuditLog['record']>[0]['reason'], companyId: string | null, revision: number | null, once = false) =>
        options.audit.record({ at: now(), item, requested: null, applied, reason, revision, companyId }, { once });

    const fingerprint = (value: OrgRequirementsDocument | null) => value ? JSON.stringify([value.companyId, value.revision, value.items]) : null;
    const replace = (next: OrgRequirementsDocument | null, nextReceivedAt: number) => {
        const effective = next && Object.keys(next.items).length > 0 ? next : null;
        const changed = fingerprint(effective) !== fingerprint(document);
        document = effective;
        receivedAt = nextReceivedAt;
        reportedStale = false;
        if (changed) for (const listener of [...listeners]) {
            try { listener(); } catch { /* a listener must not stop the others */ }
        }
    };

    const loadLastKnownGood = (): boolean => {
        for (const scope of options.scopes()) {
            const companyId = options.store.readScope(scope);
            const stored = companyId ? options.store.readLkg(companyId) : null;
            if (stored) {
                replace(stored.document, stored.receivedAt);
                return true;
            }
        }
        return false;
    };

    const keepOrFallBack = () => {
        if (document || loadLastKnownGood()) {
            unknown = false;
            return;
        }
        if (!unknown) audit('state', 'unknown', 'state', null, null);
        unknown = true;
    };

    const accept = (raw: unknown) => {
        let parsed;
        try {
            parsed = parseOrgRequirements(raw, document ?? undefined);
        } catch (error) {
            if (!(error instanceof OrgRequirementsDocumentError)) throw error;
            audit('document', null, 'document_rejected', null, null);
            keepOrFallBack();
            return;
        }
        const { document: next, issues } = parsed;
        for (const issue of issues) audit(issue.key, issue.reason, 'document_issue', next.companyId, next.revision, true);
        unknown = false;
        if (Object.keys(next.items).length === 0) {
            options.store.deleteLkg(next.companyId);
            replace(null, now());
            return;
        }
        if (options.store.writeLkg(next, now()) === 'too_large') audit('document', null, 'lkg_too_large', next.companyId, next.revision, true);
        for (const scope of options.scopes()) options.store.writeScope(scope, next.companyId);
        replace(next, now());
    };

    return {
        current: () => document,
        publicState: () => {
            if (document) {
                const stale = now() - receivedAt > ORG_STALE_AFTER_MS;
                if (stale && !reportedStale) {
                    reportedStale = true;
                    audit('state', 'stale', 'state', document.companyId, document.revision);
                }
                return { state: stale ? 'stale' : 'ok', revision: document.revision };
            }
            return unknown ? { state: 'unknown' } : null;
        },
        ingest: (outcome) => {
            if (outcome.kind === 'not-configured') return;
            lastLookupAt = now();
            if (outcome.kind === 'response' && outcome.status === 'ok') return accept(outcome.requirements);
            if (outcome.kind === 'response' && outcome.status === 'no-company') {
                for (const scope of options.scopes()) options.store.deleteScope(scope);
                unknown = false;
                replace(null, 0);
                return;
            }
            keepOrFallBack();
        },
        shouldRefresh: () => lastLookupAt !== null && now() - lastLookupAt >= ORG_REFRESH_AFTER_MS,
        onChange: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
