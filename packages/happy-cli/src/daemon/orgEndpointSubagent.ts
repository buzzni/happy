/** New endpoint children have their own binding and journal. Uncertain submissions are observed, never replayed. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseOutputFormat } from '@/claude/structuredOutput';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const endpointSchema = z.object({ endpointId: id, generation: z.number().int().positive() }).strict();
const parentSchema = z.object({ sessionId: id, launchId: id, orgEndpoint: endpointSchema.optional() }).strict();
const outputFormatSchema = z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }).strict()
    .refine(value => { try { return parseOutputFormat(value) !== undefined; } catch { return false; } });
export const orgSubagentInputSchema = z.object({ operationId: id, spawnId: id, sourceSessionId: id, directory: z.string().min(1).max(4096),
    agent: z.literal('claude'), initialPrompt: z.string().min(1).max(512 * 1024), endpointId: id.optional(),
    deadlineAt: z.number().int().nonnegative().optional(),
    sourcePolicyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(32).optional(), outputFormat: outputFormatSchema.optional(),
}).strict();
const inputSchema = orgSubagentInputSchema;
const selectionSchema = z.object({ kind: z.literal('org-endpoint'), bindingId: id, endpointId: id,
    generation: z.number().int().positive(), candidates: z.array(id).min(1).max(16),
}).strict();
export type OrgSubagentInput = z.infer<typeof inputSchema>;
export type OrgSubagentParent = z.infer<typeof parentSchema>;
export type OrgSubagentSelection = z.infer<typeof selectionSchema>;
export type OrgSubagentRecord = {
    version: 1; operationId: string; sourceSessionId: string; digest: string; request: OrgSubagentInput;
    phase: 'reserved' | 'preparing' | 'prepared' | 'creating-session' | 'launching' | 'started' | 'failed' | 'unknown';
    createdAt: number; selection?: OrgSubagentSelection; sessionId?: string; targetId?: string; providerConfirmed?: boolean;
    displayName?: string; warnings?: Array<'ORG_LLM_ENDPOINT_BUSY'>;
    reason?: string;
    snapshot?: Record<string, unknown>; result?: OrgSubagentResult;
};
export type OrgSubagentResult = { ok: boolean; state: string; operationId: string; sessionId?: string; endpointId?: string;
    error?: string; reason?: string; displayName?: string; warnings?: Array<'ORG_LLM_ENDPOINT_BUSY'>; next?: { command: string } };
export const orgSubagentRecordSchema = z.object({
    version: z.literal(1), operationId: id, sourceSessionId: id, digest: z.string().regex(/^[a-f0-9]{64}$/), request: inputSchema,
    phase: z.enum(['reserved', 'preparing', 'prepared', 'creating-session', 'launching', 'started', 'failed', 'unknown']),
    createdAt: z.number().int().nonnegative(), selection: selectionSchema.optional(), sessionId: id.optional(), targetId: id.optional(),
    providerConfirmed: z.boolean().optional(), displayName: z.string().max(200).optional(), warnings: z.array(z.literal('ORG_LLM_ENDPOINT_BUSY')).optional(),
    reason: z.string().regex(/^ORG_LLM_ENDPOINT_[A-Z0-9_]+$/).optional(),
    snapshot: z.record(z.string(), z.unknown()).optional(),
    result: z.object({ ok: z.boolean(), state: z.string(), operationId: id, sessionId: id.optional(), endpointId: id.optional(),
        displayName: z.string().max(200).optional(), warnings: z.array(z.literal('ORG_LLM_ENDPOINT_BUSY')).optional(),
        error: z.string().optional(), reason: z.string().optional(), next: z.object({ command: z.string() }).strict().optional() }).strict().optional(),
}).strict().refine(record => record.operationId === record.request.operationId && record.sourceSessionId === record.request.sourceSessionId
    && record.digest === createHash('sha256').update(JSON.stringify(record.request)).digest('hex'));
export type OrgSubagentDependencies = {
    parent(sessionId: string): Promise<unknown>;
    strict(): boolean;
    localEndpoint(endpointId: string): Promise<{ endpointId: string; generation: number } | null>;
    journal: {
        reserve(record: OrgSubagentRecord): Promise<{ owner: boolean; record: OrgSubagentRecord }>;
        read(operationId: string): Promise<OrgSubagentRecord | null>;
        write(record: OrgSubagentRecord): Promise<void>;
    };
    studio(parent: OrgSubagentParent, action: 'prepare' | 'launching' | 'started' | 'status' | 'failure' | 'child-ticket', body: Record<string, unknown>): Promise<unknown>;
    sync(raw: unknown): Promise<void>;
    environment(selection: OrgSubagentSelection): Promise<{ targetId: string; environment: Record<string, string> }>;
    /** Persist encrypted create bytes and key before its POST. This callback must not launch a provider. */
    createSession(record: OrgSubagentRecord, save: (snapshot: Record<string, unknown>) => Promise<void>): Promise<{ sessionId: string; snapshot: Record<string, unknown> }>;
    start(record: OrgSubagentRecord, environment: Record<string, string>): Promise<{ sessionId: string }>;
    now(): number;
    warn?(message: string): void;
};
export class OrgSubagentRefused extends Error {
    constructor(readonly code: string) { super(code); }
}
const refuse = (code: string): never => { throw new OrgSubagentRefused(`ORG_LLM_ENDPOINT_${code}`); };
const object = (raw: unknown): Record<string, unknown> | null => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const digest = (input: OrgSubagentInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

export function createOrgEndpointSubagent(deps: OrgSubagentDependencies) {
    async function parent(sourceSessionId: string) {
        const parsed = parentSchema.safeParse(await deps.parent(sourceSessionId));
        if (!parsed.success || parsed.data.sessionId !== sourceSessionId) return refuse('PROOF_REQUIRED');
        return parsed.data;
    }
    function pending(record: OrgSubagentRecord): OrgSubagentResult {
        return { ok: false, error: 'spawn_pending', reason: record.reason ?? 'ORG_LLM_ENDPOINT_EXECUTION_UNCONFIRMED', state: record.phase,
            operationId: record.operationId, next: { command: `happy agent spawn --resume-op ${record.operationId}` } };
    }
    function same(record: OrgSubagentRecord, input: OrgSubagentInput) {
        if (record.sourceSessionId !== input.sourceSessionId || record.digest !== digest(input)) refuse('OPERATION_CONFLICT');
    }
    async function spawn(raw: unknown): Promise<OrgSubagentResult> {
        const parsed = inputSchema.safeParse(raw);
        if (!parsed.success) return refuse('INVALID_INPUT');
        const input = parsed.data, source = await parent(input.sourceSessionId);
        const recorded = await deps.journal.read(input.operationId);
        if (recorded) { same(recorded, input); return recorded.result ?? pending(recorded); }
        const deadlineAt = Math.min(deps.now() + 620_000, input.deadlineAt ?? Infinity);
        if (deadlineAt <= deps.now()) return refuse('DEADLINE_EXCEEDED');
        const endpointId = source.orgEndpoint?.endpointId ?? input.endpointId;
        if (!endpointId) return refuse('ENDPOINT_REQUIRED');
        if (source.orgEndpoint && input.endpointId !== undefined && input.endpointId !== source.orgEndpoint.endpointId) return refuse('PARENT_BOUND');
        const local = deps.strict() ? await deps.localEndpoint(endpointId) : null;
        if (deps.strict() && (!local || local.endpointId !== endpointId)) return refuse('NOT_SYNCED');
        if (local && source.orgEndpoint && local.generation !== source.orgEndpoint.generation) return refuse('CHANGED');
        const reservation = await deps.journal.reserve({ version: 1, operationId: input.operationId, sourceSessionId: input.sourceSessionId,
            digest: digest(input), request: input, phase: 'reserved', createdAt: deadlineAt - 620_000 });
        const record = reservation.record;
        same(record, input);
        if (!reservation.owner) return record.result ?? pending(record);
        let writes = Promise.resolve();
        const save = () => {
            const snapshot = structuredClone(record);
            writes = writes.then(() => deps.journal.write(snapshot));
            return writes;
        };
        const budget = () => { if (deps.now() >= record.createdAt + 620_000) refuse('DEADLINE_EXCEEDED'); };
        const request = () => ({ operationId: record.operationId, digest: record.digest });
        try {
            budget();
            record.phase = 'preparing'; await save();
            const answer = object(await deps.studio(source, 'prepare', { ...request(), ...(input.endpointId ? { endpointId: input.endpointId } : {}) }));
            if (answer?.version === 1 && answer.state === 'failed') {
                const code = typeof answer.reason === 'string' && /^ORG_LLM_ENDPOINT_[A-Z0-9_]{1,100}$/.test(answer.reason)
                    ? answer.reason : 'ORG_LLM_ENDPOINT_PREPARE_REFUSED';
                throw new OrgSubagentRefused(code);
            }
            if (answer?.version !== 1 || answer.state !== 'prepared') {
                record.phase = 'unknown'; await save(); return pending(record);
            }
            const selected = selectionSchema.safeParse(answer.selection);
            if (!selected.success || selected.data.endpointId !== endpointId) return refuse('CHANGED');
            const selection = selected.data;
            if ((source.orgEndpoint && selection.generation !== source.orgEndpoint.generation) || (local && selection.generation !== local.generation)) return refuse('CHANGED');
            if (!deps.strict() && answer.sync !== undefined) await deps.sync(answer.sync);
            // strict never applies an endpoint received from the server, even when the request succeeded.
            record.selection = selection; record.phase = 'prepared'; await save();
            if (typeof answer.displayName === 'string' && answer.displayName.length <= 200) record.displayName = answer.displayName;
            if (Array.isArray(answer.warnings) && answer.warnings.includes('ORG_LLM_ENDPOINT_BUSY')) record.warnings = ['ORG_LLM_ENDPOINT_BUSY'];
            budget();
            const managed = await deps.environment(selection);
            budget();
            if (!selection.candidates.includes(managed.targetId) || managed.environment.HAPPY_AI_AUTH_SOURCE !== 'org-endpoint') return refuse('NOT_SYNCED');
            record.targetId = managed.targetId;
            record.phase = 'creating-session'; await save();
            const created = await deps.createSession(record, async snapshot => { record.snapshot = snapshot; await save(); });
            if (!id.safeParse(created.sessionId).success) return refuse('PROOF_FORBIDDEN');
            record.sessionId = created.sessionId; record.snapshot = created.snapshot; await save();
            budget();
            const claim = object(await deps.studio(source, 'launching', request()));
            if (claim?.version !== 1 || claim.launchAuthorized !== true || claim.state !== 'launching') {
                record.phase = 'unknown'; await save(); return pending(record);
            }
            record.phase = 'launching'; await save();
            budget();
            // The daemon continues observing a submitted provider after the caller's deadline. It never resubmits it.
            const completion = deps.start(record, managed.environment).then(async started => {
                if (started.sessionId !== record.sessionId) return refuse('PROOF_FORBIDDEN');
                record.providerConfirmed = true; await save();
                const report = object(await deps.studio(source, 'started', { ...request(), sessionId: record.sessionId, targetId: record.targetId }));
                if (report?.version !== 1 || report.state !== 'started') {
                    record.phase = 'unknown'; await save(); return pending(record);
                }
                record.phase = 'started';
                record.result = { ok: true, state: 'started', operationId: record.operationId, sessionId: record.sessionId, endpointId,
                    ...(record.displayName ? { displayName: record.displayName } : {}), ...(record.warnings ? { warnings: record.warnings } : {}) };
                await save();
                return record.result;
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([completion, new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('ORG_LLM_ENDPOINT_EXECUTION_UNCONFIRMED')), Math.max(1, record.createdAt + 620_000 - deps.now()));
                })]);
            } finally { if (timer) clearTimeout(timer); }
        } catch (error) {
            const uncertain = ['launching', 'creating-session', 'unknown'].includes(record.phase) || !(error instanceof OrgSubagentRefused);
            if (error instanceof OrgSubagentRefused) record.reason = error.code;
            if (!uncertain && record.selection && error instanceof OrgSubagentRefused) {
                try { await deps.studio(source, 'failure', { ...request(), reason: error.code }); }
                catch { deps.warn?.(`org endpoint operation ${record.operationId}: pre-provider failure cleanup is unconfirmed`); }
            }
            record.phase = uncertain ? 'unknown' : 'failed';
            if (!uncertain && error instanceof OrgSubagentRefused) record.result = { ok: false, state: 'failed', operationId: record.operationId,
                error: error.code, reason: error.code };
            await save();
            if (!uncertain) throw error;
            return pending(record);
        }
    }
    async function status(raw: unknown): Promise<OrgSubagentResult> {
        const parsed = z.object({ operationId: id, sourceSessionId: id }).strict().safeParse(raw);
        if (!parsed.success) return refuse('INVALID_INPUT');
        const record = await deps.journal.read(parsed.data.operationId);
        if (!record || record.sourceSessionId !== parsed.data.sourceSessionId) return refuse('PROOF_FORBIDDEN');
        const source = await parent(record.sourceSessionId);
        if (record.result) return record.result;
        // Observation cannot call prepare, createSession, claim or start.
        const answer = object(await deps.studio(source, 'status', { operationId: record.operationId, digest: record.digest }));
        if (answer?.version === 1 && answer.state === 'started' && answer.sessionId === record.sessionId && record.selection) {
            record.phase = 'started'; record.result = { ok: true, state: 'started', operationId: record.operationId,
                sessionId: record.sessionId, endpointId: record.selection.endpointId,
                ...(record.displayName ? { displayName: record.displayName } : {}), ...(record.warnings ? { warnings: record.warnings } : {}) };
            await deps.journal.write(record); return record.result;
        }
        return pending(record);
    }
    return { spawn, status };
}
