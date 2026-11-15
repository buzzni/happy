/** Two-step root bootstrap: a user authorizes the encrypted create, then the daemon creates and starts it once. */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SessionExecutionTicketSchema, rotationIsFresh, type SessionExecutionTicket } from '@slopus/happy-wire';
import { createOrgSubagentFiles } from './orgEndpointSubagentJournal';
import { OrgSubagentRefused } from './orgEndpointSubagent';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestSchema = z.object({ machineId: id, launchId: id, initialNonce: z.string(),
    sessionTagHash: z.string().regex(/^[a-f0-9]{64}$/), sessionCreateBodyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const resultSchema = z.object({ version: z.literal(1), type: z.enum(['success', 'error']), sessionId: id.optional(), launchId: id,
    additionalDirectories: z.unknown().optional(), launchMcpDropped: z.unknown().optional(),
    code: z.string().optional(), errorMessage: z.string().optional() }).strict();
const rootSchema = z.object({ version: z.literal(1), operationId: id, companyId: id, machineAccountId: id,
    request: requestSchema, snapshot: z.record(z.string(), z.unknown()), createdAt: z.number().int().nonnegative(),
    phase: z.enum(['prepared', 'creating', 'launching', 'started', 'unknown']), sessionId: id.optional(),
    result: resultSchema.optional(), executionTicket: SessionExecutionTicketSchema.optional(),
}).strict().refine(record => record.operationId === record.request.launchId);
export type OrgSubagentRootRecord = z.infer<typeof rootSchema>;
export type OrgSubagentRootResult = z.infer<typeof resultSchema>;
export type OrgSubagentRootDependencies = {
    home: string; studioOrigin: string; happyOrigin: string; deviceSigningPublicKey: string; now(): number;
    capture(raw: unknown, launchId: string, initialNonce: string): Promise<{ companyId: string; machineAccountId: string;
        request: z.infer<typeof requestSchema>; snapshot: Record<string, unknown> }>;
    create(record: OrgSubagentRootRecord, ticket: SessionExecutionTicket): Promise<{ sessionId: string; snapshot: Record<string, unknown> }>;
    start(record: OrgSubagentRootRecord): Promise<{ sessionId: string; additionalDirectories?: unknown; launchMcpDropped?: unknown }>;
};
export function createOrgSubagentRoot(deps: OrgSubagentRootDependencies) {
    const files = createOrgSubagentFiles(deps.home, 'roots', raw => rootSchema.parse(raw));
    const claims = createOrgSubagentFiles(deps.home, 'root-claims', raw => rootSchema.parse(raw));
    const refuse = (): never => { throw new OrgSubagentRefused('ORG_LLM_ENDPOINT_PROOF_FORBIDDEN'); };
    function pending(record: OrgSubagentRootRecord): OrgSubagentRootResult {
        return { version: 1, type: 'error', launchId: record.operationId, ...(record.sessionId ? { sessionId: record.sessionId } : {}),
            code: 'ORG_LLM_ENDPOINT_ROOT_START_UNCONFIRMED', errorMessage: 'The authorized launch is unconfirmed. Query this launch; do not create it again.' };
    }
    async function prepare(raw: unknown) {
        const launchId = randomUUID(), initialNonce = randomBytes(32).toString('base64url');
        const captured = await deps.capture(raw, launchId, initialNonce);
        const record = rootSchema.parse({ version: 1, operationId: launchId, ...captured, phase: 'prepared', createdAt: deps.now() });
        await files.reserve(record);
        return { version: 1 as const, launchId, companyId: record.companyId, request: record.request };
    }
    async function start(raw: unknown): Promise<OrgSubagentRootResult> {
        const input = z.object({ launchId: id, executionTicket: SessionExecutionTicketSchema }).strict().parse(raw);
        const record = await files.read(input.launchId); if (!record) return refuse();
        if (record.result) return record.result;
        if (record.phase !== 'prepared') return pending(record);
        const body = input.executionTicket.body;
        const expected = { audience: deps.happyOrigin, studioOrigin: deps.studioOrigin, companyId: record.companyId,
            machineId: record.request.machineId, launchId: record.operationId, operationId: record.operationId,
            machineOwnerAccountId: record.machineAccountId, sessionOwnerAccountId: record.machineAccountId,
            initialNonce: record.request.initialNonce, sessionTagHash: record.request.sessionTagHash,
            sessionCreateBodyHash: record.request.sessionCreateBodyHash, deviceSigningPublicKey: deps.deviceSigningPublicKey };
        if (!rotationIsFresh(body, deps.now()) || (Object.keys(expected) as Array<keyof typeof expected>).some(key => body[key] !== expected[key])) return refuse();
        // A distinct durable claim closes read/prepared/write races across daemon instances and crashes.
        if (!(await claims.reserve(record)).owner) return pending(record);
        record.phase = 'creating'; record.executionTicket = input.executionTicket; await files.write(record);
        try {
            const created = await deps.create(record, input.executionTicket);
            record.sessionId = id.parse(created.sessionId); record.snapshot = created.snapshot;
            record.phase = 'launching'; await files.write(record);
            const started = await deps.start(record);
            if (started.sessionId !== record.sessionId) return refuse();
            record.phase = 'started'; record.result = { version: 1, type: 'success', launchId: record.operationId, sessionId: record.sessionId };
            if (started.additionalDirectories !== undefined) record.result.additionalDirectories = started.additionalDirectories;
            if (started.launchMcpDropped !== undefined) record.result.launchMcpDropped = started.launchMcpDropped;
            await files.write(record); return record.result;
        } catch {
            record.phase = 'unknown'; await files.write(record); return pending(record);
        }
    }
    async function status(raw: unknown) {
        const input = z.object({ launchId: id }).strict().parse(raw);
        const record = await files.read(input.launchId); if (!record) return refuse();
        return record.result ?? pending(record);
    }
    return { prepare, start, status, read: files.read };
}
