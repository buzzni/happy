import { describe, expect, it } from 'vitest';

import {
    LessonBindingError,
    createLessonBindingIssuer,
    type LessonBindingIssuerOptions,
} from './lessonBindingIssuer';

function issuerFor(overrides: Partial<LessonBindingIssuerOptions> = {}) {
    const state = { generation: 1, closed: false, clock: 1_000, projectHash: 'hash-a' as string | null };
    const issuer = createLessonBindingIssuer({
        projectHash: () => state.projectHash,
        projectId: 'p1',
        generation: async () => state.generation,
        closed: () => state.closed,
        now: () => state.clock,
        ...overrides,
    });
    return { issuer, state };
}

const identity = {
    projectId: 'p1', userId: 'u1', machineId: 'm1', sessionId: 's1',
    capabilities: ['lesson.read'] as const, ttlMs: 60_000,
};

describe('createLessonBindingIssuer', () => {
    it('resolves a handle it issued, with the store\'s own project hash', async () => {
        const { issuer } = issuerFor();
        const { handle } = await issuer.issue(identity);
        expect(await issuer.verifier()(handle)).toEqual({
            projectHash: 'hash-a', actorId: 'user:u1', userId: 'u1', machineId: 'm1',
            sessionId: 's1', generation: 1, capabilities: ['lesson.read'],
        });
    });

    it('refuses a forged binding object outright', async () => {
        const { issuer } = issuerFor();
        const forged = {
            projectHash: 'hash-a', actorId: 'user:attacker', userId: 'attacker', machineId: 'm1',
            sessionId: 's1', generation: 1, capabilities: ['lesson.manage'],
        };
        await expect(issuer.verifier()(forged)).rejects.toThrow(LessonBindingError);
        await expect(issuer.verifier()(forged)).rejects.toMatchObject({ reason: 'unknown-binding' });
    });

    it('refuses a structural copy of a real handle', async () => {
        const { issuer } = issuerFor();
        const { handle } = await issuer.issue(identity);
        await expect(issuer.verifier()({ ...(handle as object) })).rejects.toThrow(LessonBindingError);
    });

    it('refuses primitives and null', async () => {
        const { issuer } = issuerFor();
        for (const value of [null, undefined, 'binding', 7]) {
            await expect(issuer.verifier()(value)).rejects.toThrow(LessonBindingError);
        }
    });

    it('stops resolving once the request released it', async () => {
        const { issuer } = issuerFor();
        const { handle, release } = await issuer.issue(identity);
        expect((await issuer.verifier()(handle)).userId).toBe('u1');
        release();
        await expect(issuer.verifier()(handle)).rejects.toMatchObject({ reason: 'released' });
    });

    it('expires on its own, so a leaked handle cannot be used later', async () => {
        const { issuer, state } = issuerFor();
        const { handle } = await issuer.issue({ ...identity, ttlMs: 5_000 });
        state.clock = 6_000;
        await expect(issuer.verifier()(handle)).rejects.toMatchObject({ reason: 'expired' });
    });

    it('fences in-flight work when the generation moves', async () => {
        const { issuer, state } = issuerFor();
        const { handle } = await issuer.issue(identity);
        // This is what a settings change does: work that began under the old
        // configuration must not commit under the new one.
        state.generation = 2;
        await expect(issuer.verifier()(handle)).rejects.toMatchObject({ reason: 'stale-generation' });
    });

    it('refuses after the runtime closed', async () => {
        const { issuer, state } = issuerFor();
        const { handle } = await issuer.issue(identity);
        state.closed = true;
        await expect(issuer.verifier()(handle)).rejects.toMatchObject({ reason: 'runtime-closed' });
    });

    it('refuses to issue for a project this runtime was not opened for', async () => {
        const { issuer } = issuerFor();
        // A grant legitimately minted for another project on the same machine.
        await expect(issuer.issue({ ...identity, projectId: 'p2' }))
            .rejects.toMatchObject({ reason: 'project-mismatch' });
    });

    it('refuses if the store moved under an already-issued handle', async () => {
        const { issuer, state } = issuerFor();
        const { handle } = await issuer.issue(identity);
        state.projectHash = 'hash-b';
        await expect(issuer.verifier()(handle)).rejects.toMatchObject({ reason: 'project-mismatch' });
    });

    it.each(['released', 'expired', 'runtime-closed'] as const)('rejects %s while generation lookup is pending', async reason => {
        let resume: ((generation: number) => void) | undefined;
        let pause = false;
        const { issuer, state } = issuerFor({ generation: () => pause
            ? new Promise<number>(resolve => { resume = resolve; })
            : Promise.resolve(1) });
        const issued = await issuer.issue(identity);
        pause = true;
        const pending = issuer.verifier()(issued.handle);
        expect(resume).toBeTypeOf('function');
        if (reason === 'released') issued.release();
        if (reason === 'expired') state.clock += identity.ttlMs;
        if (reason === 'runtime-closed') state.closed = true;
        resume!(1);
        await expect(pending).rejects.toMatchObject({ reason });
    });

    it('never lets a caller choose its own actor id or project hash', async () => {
        const { issuer } = issuerFor();
        const { handle } = await issuer.issue({
            ...identity,
            // Fields a caller might hope to smuggle in; the shape does not accept
            // them, and the resolved binding is built from the runtime instead.
            ...({ projectHash: 'hash-evil', actorId: 'user:root' } as object),
        } as never);
        const resolved = await issuer.verifier()(handle);
        expect(resolved.projectHash).toBe('hash-a');
        expect(resolved.actorId).toBe('user:u1');
    });
});
