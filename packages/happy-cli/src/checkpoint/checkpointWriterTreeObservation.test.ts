/**
 * Asking whether writers remain, without changing whether they do.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { CheckpointWriterProcessTree } from './checkpointWriterProcessTree';

describe('hasRemainingWriters', () => {
    it('shouldSayNothingRemainsForATreeThatNeverTrackedAnything', () => {
        expect(new CheckpointWriterProcessTree().hasRemainingWriters()).toBe(false);
    });

    it('shouldSeeALivingWriterAndLeaveItAlive', async () => {
        /*
         * The whole point: `quiesce` would escalate to SIGTERM and SIGKILL and
         * then report emptiness it created. This asks the kernel with signal 0
         * and changes nothing, so a managed checkpoint can refuse on a living
         * writer instead of killing it into a proof.
         */
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true, stdio: 'ignore',
        });
        const tree = new CheckpointWriterProcessTree();
        tree.track(child);
        try {
            expect(tree.hasRemainingWriters()).toBe(true);
            // Asked twice, still alive: the question did not answer itself.
            expect(tree.hasRemainingWriters()).toBe(true);
            expect(child.killed).toBe(false);
            process.kill(child.pid!, 0);
        } finally {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }
    });

    it('shouldStopSeeingAWriterOnceItHasActuallyGone', async () => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
            detached: true, stdio: 'ignore',
        });
        const tree = new CheckpointWriterProcessTree();
        tree.track(child);
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
        // The exit has to be observed, not assumed — poll rather than sleep.
        for (let i = 0; i < 40 && tree.hasRemainingWriters(); i += 1) {
            await new Promise((resolve) => { setTimeout(resolve, 25); });
        }
        expect(tree.hasRemainingWriters()).toBe(false);
    });
});
