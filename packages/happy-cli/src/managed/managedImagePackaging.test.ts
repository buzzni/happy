import { describe, expect, it } from 'vitest';

import {
    assertManagedImageLayout,
    MANAGED_IMAGE_ARTIFACTS,
    MANAGED_PROVIDER_CLI_PATH,
    MANAGED_PROVIDER_EXEC_PATH,
    MANAGED_TOOL_WORKLOAD_PATH,
    type ManagedImageLayoutDeps,
} from './managedImagePackaging';

type ImageEntry = { uid: number; mode: number; isFile: boolean };

function image(overrides: Record<string, ImageEntry> = {}, programs = ['sqlite3', 'ip', 'iptables', 'ip6tables']) {
    const files: Record<string, ImageEntry> = {
        [MANAGED_TOOL_WORKLOAD_PATH]: { uid: 0, mode: 0o555, isFile: true },
        '/usr/local/lib/saycode/tool-workload.mjs': { uid: 0, mode: 0o444, isFile: true },
        '/usr/local/lib/saycode/toolRuntime.cjs': { uid: 0, mode: 0o444, isFile: true },
        // The provider layer: the generation's own exec target, its entry, and
        // the CLI it hands the run to.
        [MANAGED_PROVIDER_EXEC_PATH]: { uid: 0, mode: 0o555, isFile: true },
        '/usr/local/lib/saycode/provider-workload.mjs': { uid: 0, mode: 0o444, isFile: true },
        [MANAGED_PROVIDER_CLI_PATH]: { uid: 0, mode: 0o444, isFile: true },
        // Without these the image cannot launch anything at all.
        '/usr/local/lib/saycode/executor-helper': { uid: 0, mode: 0o500, isFile: true },
        '/usr/local/lib/saycode/exec-helper': { uid: 0, mode: 0o500, isFile: true },
        // Absent, the Machine comes up as a REPL with everything else correct.
        '/usr/local/lib/saycode/entrypoint': { uid: 0, mode: 0o555, isFile: true },
        '/usr/local/lib/saycode/isolation-probe': { uid: 0, mode: 0o555, isFile: true },
        '/usr/local/lib/saycode/image-version': { uid: 0, mode: 0o444, isFile: true },
        '/usr/local/lib/saycode/cgroup-prepare': { uid: 0, mode: 0o555, isFile: true },
        ...overrides,
    };
    const deps: ManagedImageLayoutDeps = {
        lstatPath: async (path) => {
            const entry = files[path];
            if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return entry;
        },
        findProgram: async (name) => (programs.includes(name) ? `/usr/bin/${name}` : null),
    };
    return deps;
}

describe('assertManagedImageLayout', () => {
    it('shouldAcceptAnImageThatMatchesTheDeclaredLayout', async () => {
        expect(await assertManagedImageLayout({ deps: image() })).toEqual([]);
    });

    it('shouldNameEveryArtifactTheImageIsMissing', async () => {
        const deps = image();
        expect(await assertManagedImageLayout({
            deps: { ...deps, lstatPath: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
        })).toEqual(MANAGED_IMAGE_ARTIFACTS.map((artifact) => ({ path: artifact.path, reason: 'missing' })));
    });

    it('shouldRefuseAWorkloadTheTrustedHelperWouldRefuse', async () => {
        // The helper will not exec anything writable by group or other, so an
        // image that ships it that way produces a runtime that cannot run
        // tools at all.
        expect(await assertManagedImageLayout({
            deps: image({ [MANAGED_TOOL_WORKLOAD_PATH]: { uid: 0, mode: 0o777, isFile: true } }),
        })).toEqual([
            { path: MANAGED_TOOL_WORKLOAD_PATH, reason: 'wrong-mode', mode: 0o777, expected: 0o555 },
        ]);

        expect(await assertManagedImageLayout({
            deps: image({ [MANAGED_TOOL_WORKLOAD_PATH]: { uid: 10602, mode: 0o555, isFile: true } }),
        })).toEqual([
            { path: MANAGED_TOOL_WORKLOAD_PATH, reason: 'not-root-owned', uid: 10602 },
        ]);
    });

    it('shouldRefuseAWritableDataFile', async () => {
        expect(await assertManagedImageLayout({
            deps: image({ '/usr/local/lib/saycode/toolRuntime.cjs': { uid: 0, mode: 0o644, isFile: true } }),
        })).toEqual([
            { path: '/usr/local/lib/saycode/toolRuntime.cjs', reason: 'wrong-mode', mode: 0o644, expected: 0o444 },
        ]);
    });

    it('shouldRefuseASymlinkStandingInForAnArtifact', async () => {
        expect(await assertManagedImageLayout({
            deps: image({ [MANAGED_TOOL_WORKLOAD_PATH]: { uid: 0, mode: 0o555, isFile: false } }),
        })).toEqual([{ path: MANAGED_TOOL_WORKLOAD_PATH, reason: 'not-a-regular-file' }]);
    });

    it('shouldRefuseAnImageWithoutTheFlushAdapter', async () => {
        // Without it every SQLite project fails its checkpoint preflight, so
        // this is a build error rather than a runtime surprise.
        expect(await assertManagedImageLayout({
            deps: image({}, ['ip', 'iptables', 'ip6tables']),
        })).toEqual([{ path: 'sqlite3', reason: 'program-missing' }]);
    });

    it('shouldRefuseAnImageThatCannotBuildAToolCallsNetworkNamespace', async () => {
        /*
         * `toolExecutor` builds the veth pair, the default route and the REJECT
         * rules that keep host services away from the executor. Without these
         * the isolation is not weakened, it is absent — and the very first tool
         * call fails at setup rather than running unprotected.
         */
        expect(await assertManagedImageLayout({ deps: image({}, ['sqlite3']) }))
            .toEqual([
                { path: 'ip', reason: 'program-missing' },
                { path: 'iptables', reason: 'program-missing' },
                { path: 'ip6tables', reason: 'program-missing' },
            ]);
    });

    it('shouldReportEveryProblemAtOnceRatherThanTheFirst', async () => {
        const problems = await assertManagedImageLayout({
            deps: image({
                [MANAGED_TOOL_WORKLOAD_PATH]: { uid: 10602, mode: 0o777, isFile: true },
                '/usr/local/lib/saycode/toolRuntime.cjs': { uid: 0, mode: 0o644, isFile: true },
            }, ['ip', 'iptables', 'ip6tables']),
        });
        expect(problems).toHaveLength(4);
        expect(problems.map((problem) => problem.reason).sort())
            .toEqual(['not-root-owned', 'program-missing', 'wrong-mode', 'wrong-mode']);
    });

    it('shouldCheckAStagedTreeUnderAPrefixBeforeItBecomesAnImage', async () => {
        const staged: Record<string, { uid: number; mode: number; isFile: boolean }> = {
            '/stage/usr/local/lib/saycode/tool-workload': { uid: 0, mode: 0o555, isFile: true },
            '/stage/usr/local/lib/saycode/tool-workload.mjs': { uid: 0, mode: 0o444, isFile: true },
            '/stage/usr/local/lib/saycode/toolRuntime.cjs': { uid: 0, mode: 0o444, isFile: true },
            [`/stage${MANAGED_PROVIDER_EXEC_PATH}`]: { uid: 0, mode: 0o555, isFile: true },
            '/stage/usr/local/lib/saycode/provider-workload.mjs': { uid: 0, mode: 0o444, isFile: true },
            [`/stage${MANAGED_PROVIDER_CLI_PATH}`]: { uid: 0, mode: 0o444, isFile: true },
            '/stage/usr/local/lib/saycode/executor-helper': { uid: 0, mode: 0o500, isFile: true },
            '/stage/usr/local/lib/saycode/exec-helper': { uid: 0, mode: 0o500, isFile: true },
            '/stage/usr/local/lib/saycode/entrypoint': { uid: 0, mode: 0o555, isFile: true },
            '/stage/usr/local/lib/saycode/isolation-probe': { uid: 0, mode: 0o555, isFile: true },
            '/stage/usr/local/lib/saycode/image-version': { uid: 0, mode: 0o444, isFile: true },
            '/stage/usr/local/lib/saycode/cgroup-prepare': { uid: 0, mode: 0o555, isFile: true },
        };
        expect(await assertManagedImageLayout({
            prefix: '/stage',
            deps: {
                lstatPath: async (path) => {
                    const entry = staged[path];
                    if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                    return entry;
                },
                findProgram: async () => '/usr/bin/sqlite3',
            },
        })).toEqual([]);
    });
});
