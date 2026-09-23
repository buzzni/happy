/**
 * Loads the **built** CML artifact, not a mock.
 *
 * The previous version of this adapter imported `dist/core/sqlite-wrapper.js`
 * because that is where the function is declared in source. The built package
 * rolls `dist/core/` up into one `index.js`, so the import resolved to nothing
 * and every load reported `unsupported` — a failure no amount of mocking would
 * have shown. This test therefore runs against a real `dist/`, or skips and
 * says why.
 *
 * Named a plain `.test.ts` on purpose: the `integration` vitest project has a
 * fixed include list, so an `.integration.test.ts` here would be collected by
 * nothing and quietly never run. This one is hermetic anyway — an isolated
 * storage root, no network, no shared state — so it belongs with the unit
 * suite where it actually executes.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    loadCmlLessonHost,
    openLessonHost,
    readLessonPage,
    resolveServiceEntry,
    type VerifiedLessonHostBinding,
} from './cmlLessonHost';

const ROOT = process.env.CLAUDE_MEMORY_LESSON_HOST_ROOT
    // ../../.. from packages/happy-cli is the checkouts directory this clone
    // sits in, where the CML checkout is a sibling.
    ?? join(process.cwd(), '..', '..', '..', 'claude-memory-layer');
const BUILT = existsSync(join(ROOT, 'dist', 'services', 'lesson-host-service.js'));

describe.skipIf(!BUILT)('CML lesson host adapter against the built package', () => {
    const env = { CLAUDE_MEMORY_LESSON_HOST_ROOT: ROOT } as NodeJS.ProcessEnv;

    it('resolves every entry point it declares from the real dist layout', async () => {
        const loaded = await loadCmlLessonHost(env);
        if (!loaded.ok) throw new Error(`load failed: ${loaded.detail}`);
        expect(typeof loaded.modules.openLessonHostService).toBe('function');
        expect(typeof loaded.modules.hashLessonCandidatePayload).toBe('function');
    });

    it('opens an isolated store whose schema the service can actually query', async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), 'cml-lesson-ws-'));
        const storageRoot = await mkdtemp(join(tmpdir(), 'cml-lesson-store-'));
        let projectHash = '';
        const binding = (): VerifiedLessonHostBinding => ({
            projectHash, actorId: 'user:u1', userId: 'u1', machineId: 'm1',
            sessionId: 's1', generation: 1, capabilities: ['lesson.read', 'lesson.manage'],
        });
        const opened = await openLessonHost({
            workspaceDir,
            // Never the canonical store: a test must not write into the
            // developer's real project memory.
            isolatedStorageRoot: storageRoot,
            verifyBinding: () => binding(),
            env,
        });
        if (!opened.ok) throw new Error(`open failed: ${opened.detail}`);
        projectHash = opened.handle.projectHash;
        try {
            expect(projectHash).toMatch(/^[a-f0-9]{8,}$/);
            // A store with no schema throws here; an empty store pages cleanly.
            const page = readLessonPage(await opened.handle.service.listCandidates({
                version: 1, requestId: 'r1', binding: binding(), limit: 100, offset: 0,
            }), 'candidates');
            expect(page).toEqual({ ok: true, outcome: 'ok', rows: [], nextOffset: null });

            const lessons = readLessonPage(await opened.handle.service.listLessons({
                version: 1, requestId: 'r2', binding: binding(), limit: 100, offset: 0,
            }), 'lessons');
            expect(lessons).toEqual({ ok: true, outcome: 'ok', rows: [], nextOffset: null });
        } finally {
            await opened.handle.close();
            await rm(workspaceDir, { recursive: true, force: true });
            await rm(storageRoot, { recursive: true, force: true });
        }
    });

    it('resolves through `npm root -g`, the way a real installation is found', async () => {
        /*
         * No checkout override. This exercises the resolver itself: a stub
         * `npm` prints a global root, and the package is found underneath it —
         * which is the only path a real, globally installed CML is reached by,
         * and the one an earlier version of this adapter never took.
         */
        const globalRoot = await mkdtemp(join(tmpdir(), 'npm-root-resolver-'));
        const pkg = join(globalRoot, 'claude-memory-layer');
        await mkdir(pkg, { recursive: true });
        await cp(join(ROOT, 'dist'), join(pkg, 'dist'), { recursive: true });
        if (existsSync(join(ROOT, 'node_modules'))) {
            await symlink(join(ROOT, 'node_modules'), join(pkg, 'node_modules'), 'dir');
        }
        const npmStub = join(globalRoot, 'npm-stub.sh');
        await writeFile(npmStub, `#!/bin/sh\necho "${globalRoot}"\n`, { mode: 0o755 });
        try {
            const resolved = await resolveServiceEntry({
                CLAUDE_MEMORY_NPM_BIN: npmStub,
            } as NodeJS.ProcessEnv);
            expect(resolved).toBe(join(pkg, 'dist', 'services', 'lesson-host-service.js'));

            const loaded = await loadCmlLessonHost({
                CLAUDE_MEMORY_NPM_BIN: npmStub,
            } as NodeJS.ProcessEnv);
            if (!loaded.ok) throw new Error(`npm-root load failed: ${loaded.detail}`);
            expect(typeof loaded.modules.openLessonHostService).toBe('function');
        } finally {
            await rm(globalRoot, { recursive: true, force: true });
        }
    });

    it('reports not-installed when the global root has no such package', async () => {
        const globalRoot = await mkdtemp(join(tmpdir(), 'npm-root-empty-'));
        const npmStub = join(globalRoot, 'npm-stub.sh');
        await writeFile(npmStub, `#!/bin/sh\necho "${globalRoot}"\n`, { mode: 0o755 });
        try {
            expect(await resolveServiceEntry({ CLAUDE_MEMORY_NPM_BIN: npmStub } as NodeJS.ProcessEnv))
                .toBeNull();
        } finally {
            await rm(globalRoot, { recursive: true, force: true });
        }
    });

    it('loads from a global npm layout given an explicit root', async () => {
        // `<npm root -g>/claude-memory-layer/dist/services/...`. CML is a global
        // CLI, not a dependency of this package, so plain Node resolution never
        // finds it — this pins the layout that actually ships.
        const globalRoot = await mkdtemp(join(tmpdir(), 'npm-root-g-'));
        const pkg = join(globalRoot, 'claude-memory-layer');
        await mkdir(pkg, { recursive: true });
        // The package as npm lays it out: dist plus the deps it imports.
        await cp(join(ROOT, 'dist'), join(pkg, 'dist'), { recursive: true });
        if (existsSync(join(ROOT, 'node_modules'))) {
            await symlink(join(ROOT, 'node_modules'), join(pkg, 'node_modules'), 'dir');
        }
        try {
            const loaded = await loadCmlLessonHost({
                CLAUDE_MEMORY_LESSON_HOST_ROOT: pkg,
            } as NodeJS.ProcessEnv);
            if (!loaded.ok) throw new Error(`global-layout load failed: ${loaded.detail}`);
            expect(typeof loaded.modules.openLessonHostService).toBe('function');
        } finally {
            await rm(globalRoot, { recursive: true, force: true });
        }
    });

    it('reports unsupported when the package is absent', async () => {
        const missing = await loadCmlLessonHost({
            CLAUDE_MEMORY_LESSON_HOST_ROOT: join(tmpdir(), 'no-such-cml'),
        } as NodeJS.ProcessEnv);
        expect(missing.ok).toBe(false);
        expect(missing.ok === false && missing.reason).toBe('unsupported');
        // A classification, not a path: the detail is logged and must not
        // quote where the daemon looked.
        expect(missing.ok === false && missing.detail).toBe('not-installed');
    });
});
