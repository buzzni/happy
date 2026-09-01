import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CheckpointWriterProcessTree } from './checkpointWriterProcessTree';

describe('CheckpointWriterProcessTree', () => {
    it.runIf(process.platform !== 'win32')(
        'does not report quiescence while a detached descendant can still write',
        async () => {
            const child = spawn('bash', ['-c', 'sleep 30 & descendant=$!; echo "$descendant"; wait'], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const descendantPid = await new Promise<number>((resolve, reject) => {
                child.once('error', reject);
                child.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim())));
            });
            const tree = new CheckpointWriterProcessTree();
            tree.track(child);

            await tree.quiesce(() => {
                child.kill('SIGTERM');
            });

            expect(() => process.kill(descendantPid, 0)).toThrow();
        },
        10_000,
    );

    it.runIf(process.platform !== 'win32')(
        'still terminates the writer group when provider close reports an error',
        async () => {
            const child = spawn('bash', ['-c', 'sleep 30'], {
                detached: true,
                stdio: 'ignore',
            });
            const tree = new CheckpointWriterProcessTree();
            tree.track(child);

            try {
                await expect(tree.quiesce(() => {
                    throw new Error('provider close failed');
                })).rejects.toThrow('provider close failed');

                expect(() => process.kill(child.pid!, 0)).toThrow();
            } finally {
                try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already quiescent */ }
            }
        },
        10_000,
    );
});
