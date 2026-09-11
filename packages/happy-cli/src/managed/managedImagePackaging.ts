/**
 * Where the managed runtime image puts the pieces the isolated executor runs,
 * and what they must look like when it gets there.
 *
 * The executor's trusted helper refuses to `execve` anything that is not
 * root-owned or that is writable by group or other. `0755` would clear that
 * bar too, so `0555` is not what makes the workload runnable — it is a
 * read-only contract that goes further than the helper requires: nothing in
 * the running image has a reason to rewrite the code the agent is about to
 * become. The two files it reads are `0444` for the same reason.
 *
 * The check below compares the **exact** bits rather than a minimum, so a
 * packaging drift is a build failure instead of a silently looser image.
 *
 * This module exists so there is exactly one statement of that layout. The
 * image build follows it, `assertManagedImageLayout` checks it from inside the
 * built image, and `startManagedToolSession` takes its `workloadPath` from it —
 * three consumers that would otherwise each carry their own copy of the same
 * path and drift apart silently.
 *
 * `sqlite3` is here for the same reason: without it every project with a
 * SQLite database fails its checkpoint preflight (`unsupported-database`), and
 * an image that ships without it turns that into the normal case.
 */
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const MANAGED_IMAGE_LIB_DIR = '/usr/local/lib/saycode';

/**
 * The executor's `execve` target. Fixed, because the helper validates the path
 * it was handed and a caller that could choose it could choose anything.
 */
export const MANAGED_TOOL_WORKLOAD_PATH = join(MANAGED_IMAGE_LIB_DIR, 'tool-workload');

/**
 * The generation's `execve` target — the provider layer's equivalent, and a
 * different program on purpose. The tool workload is entered by the executor
 * uid inside a per-call PID/mount/network namespace; this is the provider
 * generation itself, under `exec-helper`.
 */
export const MANAGED_PROVIDER_EXEC_PATH = join(MANAGED_IMAGE_LIB_DIR, 'provider-workload');

/**
 * The Happy CLI entry the provider entry hands the run to.
 *
 * Installed as a directory, not a file: the build emits `index.mjs` beside
 * content-hashed sibling chunks it imports by relative path, so the entry
 * cannot be installed on its own, and the siblings' names change every build.
 * Only the entry is named here; the build is what proves its siblings came
 * with it.
 */
/**
 * The two trusted helpers.
 *
 * They are the reason any of this is isolation at all, and they are **not**
 * interchangeable: `executor-helper` enters a per-call PID/mount/network
 * namespace and drops to the executor uid for one tool, `exec-helper` enters no
 * namespace and runs the provider generation as the provider uid. Both are
 * `0500 root` — the caller hands a path and the helper validates it, so a file
 * anything in the running image could replace would make that check theatre.
 *
 * Listed here because an image without them cannot launch at all, and the
 * layout check is what says so at build time rather than at the first spawn.
 */
export const MANAGED_TOOL_HELPER_IMAGE_PATH = join(MANAGED_IMAGE_LIB_DIR, 'executor-helper');
export const MANAGED_PROVIDER_HELPER_IMAGE_PATH = join(MANAGED_IMAGE_LIB_DIR, 'exec-helper');

/**
 * The container entrypoint.
 *
 * Listed as an artefact because its absence is invisible: without it the image
 * inherits the base's `CMD ["node"]` and a Machine comes up as a REPL with
 * every file present and correctly moded. The layout check is what turns that
 * into a build failure instead of a runtime that never starts.
 */
export const MANAGED_ENTRYPOINT_PATH = join(MANAGED_IMAGE_LIB_DIR, 'entrypoint');

/**
 * The activation gate's payload.
 *
 * Fixed and root-owned because the gate execs it through the real helper: if
 * anything outside could choose the program, the gate would be verifying
 * whatever that thing wanted verified. Listed here so an image without it fails
 * the build rather than failing to activate.
 */
export const MANAGED_ISOLATION_PROBE_PATH = join(MANAGED_IMAGE_LIB_DIR, 'isolation-probe');

/**
 * What image this actually is, written at build time.
 *
 * The parent knows which image it *asked* for; a checkpoint has to record the
 * one that is *running*. If those two ever differ — a rollback, a cached layer,
 * a Machine that came back on an older image — an archive labelled with the
 * parent's answer tells a restore to assume a contract this runtime never had.
 * So the value comes from inside, and its absence is a build failure rather
 * than an unlabelled archive.
 */
export const MANAGED_IMAGE_VERSION_PATH = join(MANAGED_IMAGE_LIB_DIR, 'image-version');

/**
 * Makes this Machine's generation cgroup root usable before the gate looks.
 *
 * Nothing created it: the production image never did and only the P4 verify
 * scripts ever have, so the activation gate would refuse a machine that was
 * otherwise correct.
 */
export const MANAGED_CGROUP_PREPARE_PATH = join(MANAGED_IMAGE_LIB_DIR, 'cgroup-prepare');

export const MANAGED_PROVIDER_CLI_DIR = join(MANAGED_IMAGE_LIB_DIR, 'cli');
export const MANAGED_PROVIDER_CLI_PATH = join(MANAGED_PROVIDER_CLI_DIR, 'index.mjs');



export type ManagedImageArtifact = {
    path: string;
    /** Exact permission bits, not a minimum. */
    mode: number;
    role: 'executable' | 'data';
};




export const MANAGED_IMAGE_ARTIFACTS: readonly ManagedImageArtifact[] = [
    { path: MANAGED_TOOL_WORKLOAD_PATH, mode: 0o555, role: 'executable' },
    { path: join(MANAGED_IMAGE_LIB_DIR, 'tool-workload.mjs'), mode: 0o444, role: 'data' },
    { path: join(MANAGED_IMAGE_LIB_DIR, 'toolRuntime.cjs'), mode: 0o444, role: 'data' },
    { path: MANAGED_PROVIDER_EXEC_PATH, mode: 0o555, role: 'executable' },
    { path: join(MANAGED_IMAGE_LIB_DIR, 'provider-workload.mjs'), mode: 0o444, role: 'data' },
    { path: MANAGED_PROVIDER_CLI_PATH, mode: 0o444, role: 'data' },
    { path: MANAGED_TOOL_HELPER_IMAGE_PATH, mode: 0o500, role: 'executable' },
    { path: MANAGED_PROVIDER_HELPER_IMAGE_PATH, mode: 0o500, role: 'executable' },
    { path: MANAGED_ENTRYPOINT_PATH, mode: 0o555, role: 'executable' },
    { path: MANAGED_ISOLATION_PROBE_PATH, mode: 0o555, role: 'executable' },
    { path: MANAGED_IMAGE_VERSION_PATH, mode: 0o444, role: 'data' },
    { path: MANAGED_CGROUP_PREPARE_PATH, mode: 0o555, role: 'executable' },
];

/** Programs the image must carry for a checkpoint to be able to complete. */
/**
 * Programs the image must carry, each because a real path fails without it.
 *
 * `sqlite3` is the checkpoint's flush: without it every project holding a
 * SQLite database fails its preflight.
 *
 * `ip`, `iptables` and `ip6tables` are how a tool call gets its network
 * namespace — `toolExecutor` builds the veth pair, the default route and the
 * REJECT rules that keep host services away from the executor
 * (`toolExecutor.ts:495-505`). Missing, the isolation is not weakened, it is
 * absent: the very first tool call fails at setup. They are listed here so
 * that is a build failure rather than a discovery on the first run.
 */
export const MANAGED_IMAGE_PROGRAMS: readonly string[] = [
    'sqlite3',
    'ip',
    'iptables',
    'ip6tables',
];

export type ManagedImageLayoutProblem =
    | { path: string; reason: 'missing' }
    | { path: string; reason: 'not-a-regular-file' }
    | { path: string; reason: 'not-root-owned'; uid: number }
    | { path: string; reason: 'wrong-mode'; mode: number; expected: number }
    | { path: string; reason: 'program-missing' };

export type ManagedImageLayoutDeps = {
    lstatPath: (path: string) => Promise<{ uid: number; mode: number; isFile: boolean }>;
    /** Resolves a program on PATH; `null` when it is not there. */
    findProgram: (name: string) => Promise<string | null>;
};

export const defaultManagedImageLayoutDeps: ManagedImageLayoutDeps = {
    lstatPath: async (path) => {
        const entry = await lstat(path);
        return { uid: entry.uid, mode: entry.mode & 0o7777, isFile: entry.isFile() };
    },
    findProgram: async (name) => {
        for (const directory of (process.env.PATH ?? '').split(':')) {
            if (!directory) continue;
            const candidate = join(directory, name);
            try {
                await access(candidate, constants.X_OK);
                return candidate;
            } catch { /* keep looking */ }
        }
        return null;
    },
};

/**
 * Checks the layout of a built image. Reports every problem rather than the
 * first: a build that is wrong in three places should say so once.
 *
 * `prefix` exists for verifying a staged tree before it becomes an image; in
 * the image itself it is empty.
 */
export async function assertManagedImageLayout(input?: {
    prefix?: string;
    deps?: Partial<ManagedImageLayoutDeps>;
}): Promise<ManagedImageLayoutProblem[]> {
    const deps = { ...defaultManagedImageLayoutDeps, ...input?.deps };
    const prefix = input?.prefix ?? '';
    const problems: ManagedImageLayoutProblem[] = [];

    for (const artifact of MANAGED_IMAGE_ARTIFACTS) {
        const path = `${prefix}${artifact.path}`;
        let entry: { uid: number; mode: number; isFile: boolean };
        try {
            entry = await deps.lstatPath(path);
        } catch {
            problems.push({ path: artifact.path, reason: 'missing' });
            continue;
        }
        // `lstat`, so a symlink is a finding rather than something followed to
        // a file that happens to look right.
        if (!entry.isFile) {
            problems.push({ path: artifact.path, reason: 'not-a-regular-file' });
            continue;
        }
        if (entry.uid !== 0) problems.push({ path: artifact.path, reason: 'not-root-owned', uid: entry.uid });
        if (entry.mode !== artifact.mode) {
            problems.push({ path: artifact.path, reason: 'wrong-mode', mode: entry.mode, expected: artifact.mode });
        }
    }

    for (const program of MANAGED_IMAGE_PROGRAMS) {
        if (await deps.findProgram(program) === null) {
            problems.push({ path: program, reason: 'program-missing' });
        }
    }
    return problems;
}
