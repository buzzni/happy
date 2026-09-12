import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CheckpointRestorePlanEntry } from './checkpointRestorePlan';
import type { CheckpointStoreLayout } from './checkpointStore';

const restoreJournalEntrySchema = z.object({
    path: z.string().min(1),
    action: z.enum(['restore', 'delete', 'skip', 'conflict']),
    outcome: z.enum([
        'pending',
        'applying',
        'restored',
        'deleted',
        'skipped',
        'conflict',
        'failed',
    ]),
}).strict().refine((entry) => (
    (entry.action === 'restore' && ['pending', 'applying', 'restored', 'failed'].includes(entry.outcome))
    || (entry.action === 'delete' && ['pending', 'applying', 'deleted', 'failed'].includes(entry.outcome))
    || (entry.action === 'skip' && entry.outcome === 'skipped')
    || (entry.action === 'conflict' && entry.outcome === 'conflict')
));

const restoreJournalSchema = z.object({
    schemaVersion: z.literal(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    safetyCheckpointId: z.string().regex(/^[a-f0-9]{40,64}$/),
    entries: z.array(restoreJournalEntrySchema),
}).strict();

export type CheckpointRestoreJournalEntry = z.infer<typeof restoreJournalEntrySchema>;
export type CheckpointRestoreJournal = z.infer<typeof restoreJournalSchema>;

export function checkpointRestoreJournalPath(
    layout: CheckpointStoreLayout,
    operationId: string,
): string {
    const bindingId = basename(layout.metadataFile, '.json');
    const operationKey = createHash('sha256').update(operationId).digest('hex');
    return join(layout.gitDirectory, 'restores', bindingId, `${operationKey}.json`);
}

export function checkpointRestoreRequestFingerprint(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createCheckpointRestoreJournal(
    requestFingerprint: string,
    safetyCheckpointId: string,
    entries: CheckpointRestorePlanEntry[],
): CheckpointRestoreJournal {
    return restoreJournalSchema.parse({
        schemaVersion: 1,
        requestFingerprint,
        safetyCheckpointId,
        entries: entries.map((entry) => ({
            path: entry.path,
            action: entry.action,
            outcome: entry.action === 'skip'
                ? 'skipped'
                : entry.action === 'conflict'
                    ? 'conflict'
                    : 'pending',
        })),
    });
}

export async function readCheckpointRestoreJournal(
    journalFile: string,
): Promise<CheckpointRestoreJournal | null> {
    try {
        return restoreJournalSchema.parse(JSON.parse(await readFile(journalFile, 'utf8')));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw new Error('checkpoint restore journal is corrupt');
    }
}

export async function writeCheckpointRestoreJournal(
    journalFile: string,
    journal: CheckpointRestoreJournal,
): Promise<void> {
    const validated = restoreJournalSchema.parse(journal);
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
