import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CheckpointWriterProcessTree } from './checkpointWriterProcessTree';

describe('CheckpointWriterProcessTree', () => {
    it('accepts an inaccessible process group only after its tracked root exits', async () => {
        const exitListeners: Array<() => void> = [];
        const child = {
            pid: 424_242,
            once: (_event: string, listener: () => void) => {
                exitListeners.push(listener);
                return child;
            },
        };
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        });
        try {
            const tree = new CheckpointWriterProcessTree();
            tree.track(child as any);
            exitListeners[0]();

            await expect(tree.quiesce(() => {})).resolves.toBeUndefined();
        } finally {
            kill.mockRestore();
        }
    });

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
