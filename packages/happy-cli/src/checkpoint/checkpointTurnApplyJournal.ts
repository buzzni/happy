import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CheckpointStoreLayout } from './checkpointStore';
import type { CheckpointTurnApplyPlanEntry } from './checkpointTurnApply';

const turnApplyJournalEntrySchema = z.object({
    path: z.string().min(1),
    action: z.enum(['write', 'delete', 'conflict']),
    outcome: z.enum(['pending', 'applying', 'written', 'deleted', 'conflict', 'failed']),
}).strict().refine((entry) => (
    (entry.action === 'write' && ['pending', 'applying', 'written', 'failed'].includes(entry.outcome))
    || (entry.action === 'delete' && ['pending', 'applying', 'deleted', 'failed'].includes(entry.outcome))
    || (entry.action === 'conflict' && entry.outcome === 'conflict')
));

const turnApplyJournalSchema = z.object({
    schemaVersion: z.literal(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    checkpointId: z.string().regex(/^[a-f0-9]{40,64}$/),
    entries: z.array(turnApplyJournalEntrySchema),
}).strict();

export type CheckpointTurnApplyJournal = z.infer<typeof turnApplyJournalSchema>;

export function checkpointTurnApplyJournalPath(
    layout: CheckpointStoreLayout,
    operationId: string,
): string {
    const bindingId = basename(layout.metadataFile, '.json');
    const operationKey = createHash('sha256').update(operationId).digest('hex');
    return join(layout.gitDirectory, 'turn-applies', bindingId, `${operationKey}.json`);
}

export function checkpointTurnApplyRequestFingerprint(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createCheckpointTurnApplyJournal(
    requestFingerprint: string,
    checkpointId: string,
    entries: CheckpointTurnApplyPlanEntry[],
): CheckpointTurnApplyJournal {
    return turnApplyJournalSchema.parse({
        schemaVersion: 1,
        requestFingerprint,
        checkpointId,
        entries: entries.map((entry) => ({
            path: entry.path,
            action: entry.action,
            outcome: entry.action === 'conflict' ? 'conflict' : 'pending',
        })),
    });
}

export async function readCheckpointTurnApplyJournal(
    journalFile: string,
): Promise<CheckpointTurnApplyJournal | null> {
    try {
        return turnApplyJournalSchema.parse(JSON.parse(await readFile(journalFile, 'utf8')));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw new Error('checkpoint turn apply journal is corrupt');
    }
}

export async function writeCheckpointTurnApplyJournal(
    journalFile: string,
    journal: CheckpointTurnApplyJournal,
): Promise<void> {
    const validated = turnApplyJournalSchema.parse(journal);
    const journalDirectory = dirname(journalFile);
    await mkdir(journalDirectory, { recursive: true });
    const temporaryFile = join(journalDirectory, `.${basename(journalFile)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryFile, 'wx', 0o600);
    try {
        try {
            await handle.writeFile(JSON.stringify(validated));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporaryFile, journalFile);
        const directoryHandle = await open(journalDirectory, 'r');
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } catch (error) {
        await rm(temporaryFile, { force: true });
        throw error;
    }
}
