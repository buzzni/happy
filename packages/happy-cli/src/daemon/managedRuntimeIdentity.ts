/**
 * Decides whether this daemon is a managed Cloud runtime, and refuses to guess.
 *
 * The only admissible evidence is a provisioning file the runtime's own code
 * cannot write: owned by uid 0, not writable by group or other, reached without
 * following a symlink. An environment variable is not evidence — the daemon
 * passes its whole `process.env` to agent children on the default spawn path,
 * so anything there is attacker-controlled once the first agent turn runs. A
 * signed-token echo is not evidence either: the verifier key is public, so any
 * process can perform that exchange.
 *
 * Three outcomes, and the middle one carries the weight:
 *   - absent    → no marker. An ordinary BYOS machine; nothing changes for it.
 *                 Only ENOENT/ENOTDIR produce this. A marker we cannot read
 *                 (EACCES, EIO, ELOOP) is a refusal, never an absence —
 *                 treating "cannot read" as "not managed" would let anyone
 *                 downgrade the runtime by making the file unreadable.
 *   - refused   → a marker exists but cannot be trusted. Managed RPCs are not
 *                 served AND legacy spawn is not restored.
 *   - active    → verified provisioning, verified state directory, and an
 *                 isolation backend that actually answered.
 *
 * Isolation is not a declaration. `isolation.backend` names a trusted launch /
 * fencing mechanism and the daemon asks that backend whether it is wired. As of
 * T04/T09 no backend is implemented, so `probeIsolationBackend` reports
 * unavailable and `active` is unreachable — by construction, not by comment.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseManagedVerifierKey } from './managedDispatchToken';
import type { KeyObject } from 'node:crypto';

const MAX_PROVISIONING_BYTES = 16 * 1024;

/**
 * Mechanisms that may ever grant isolation. None is implemented yet (T09).
 *
 * The name is deliberately not a cgroup path: T09 measured that a non-root
 * daemon cannot signal an agent running under a different uid, and that setuid
 * shell wrappers are ignored on Linux. Downgrading to another uid and later
 * terminating that process both require a privileged launcher, so the backend
 * is that launcher — a declared cgroup root is not a substitute for it.
 */
export const MANAGED_ISOLATION_BACKENDS = ['privileged-launch-supervisor'] as const;
export type ManagedIsolationBackend = (typeof MANAGED_ISOLATION_BACKENDS)[number];

export type ManagedIdentityRefusal =
    | 'not-root-owned'
    | 'world-or-group-writable'
    | 'not-a-regular-file'
    | 'symlinked'
    | 'too-large'
    | 'unreadable'
    | 'malformed'
    | 'bad-verifier-key'
    | 'state-dir-unsafe'
    | 'isolation-unverified';

export type ManagedRuntimeIdentity = {
    runtimeId: string;
    workspaceId: string;
    projectId: string;
    keyId: string;
    verifier: KeyObject;
    /** Directory the receipt store owns. Never inside the agent workspace. */
    stateDir: string;
    isolation: { backend: ManagedIsolationBackend; agentUid: number; cgroupRoot: string };
};

export type ManagedIdentityResolution =
    | { status: 'absent' }
    | { status: 'refused'; reason: ManagedIdentityRefusal; detail?: string }
    | { status: 'active'; identity: ManagedRuntimeIdentity };

export type IsolationProbeResult = { verified: true } | { verified: false; reason: string };

export type ManagedProvisioningDeps = {
    getuid: () => number;
    /** Ownership/mode of a directory, without following a final symlink. */
    lstatDir: (path: string) => { uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean };
    /** Trust decision about the opened provisioning file. */
    statGate?: (stat: ProvisioningStat) => { reason: ManagedIdentityRefusal } | null;
    /**
     * Asks the privileged launch backend whether it is actually wired up —
     * meaning it can both start an agent under `agentUid` and terminate it.
     * T09 owns that implementation; until then this reports unavailable.
     */
    probeIsolationBackend: (input: {
        backend: ManagedIsolationBackend;
        agentUid: number;
        cgroupRoot: string;
        daemonUid: number;
    }) => IsolationProbeResult;
};

/**
 * No trusted launch backend exists yet, so managed mode cannot activate. This
 * is the activation gate: it becomes a real probe in T09 and not before.
 */
export function probeIsolationBackendUnavailable(): IsolationProbeResult {
    return { verified: false, reason: 'trusted-launch-backend-not-implemented' };
}

const defaultDeps: ManagedProvisioningDeps = {
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    lstatDir: (path) => {
        const stat = lstatSync(path);
        return {
            uid: stat.uid,
            mode: stat.mode,
            isDirectory: stat.isDirectory(),
            isSymbolicLink: stat.isSymbolicLink(),
        };
    },
    probeIsolationBackend: probeIsolationBackendUnavailable,
};

export function managedProvisioningPath(root = '/etc/saycode'): string {
    return join(root, 'managed-runtime.json');
}

function readString(value: unknown, max = 200): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
}

type FileReadOutcome =
    | { kind: 'absent' }
    | { kind: 'refused'; reason: ManagedIdentityRefusal; detail?: string }
    | { kind: 'ok'; content: string };

export type ProvisioningStat = { uid: number; mode: number; isFile: boolean; size: number };

/**
 * The trust decision about the opened file, separated from the I/O so every
 * ownership and permission combination is testable without running as root.
 * `resolveManagedRuntimeIdentity` uses this by default; a test may substitute
 * a narrower gate to exercise the parsing that follows.
 */
export function assertProvisioningStat(
    stat: ProvisioningStat,
): { reason: ManagedIdentityRefusal } | null {
    if (!stat.isFile) return { reason: 'not-a-regular-file' };
    if (stat.uid !== 0) return { reason: 'not-root-owned' };
    if ((stat.mode & 0o022) !== 0) return { reason: 'world-or-group-writable' };
    if (stat.size > MAX_PROVISIONING_BYTES) return { reason: 'too-large' };
    return null;
}

/**
 * Open, stat and read through a single descriptor.
 *
 * A stat-then-read pair checks one file and reads another if the path is
 * swapped in between, and `O_NOFOLLOW` keeps a symlink from redirecting the
 * final component at all. The read is bounded by the stat'd size so a huge or
 * growing file cannot be pulled into memory.
 */
function readProvisioningFile(
    path: string,
    gate: (stat: ProvisioningStat) => { reason: ManagedIdentityRefusal } | null,
): FileReadOutcome {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Only a genuinely missing path means "this is not a managed runtime".
        // ENOTDIR is not that: it means a path component is a file, which is a
        // state anyone who can write the parent can create, so treating it as
        // absence would be a switch for turning managed mode off.
        if (code === 'ENOENT') return { kind: 'absent' };
        if (code === 'ENOTDIR') {
            return { kind: 'refused', reason: 'unreadable', detail: 'ENOTDIR' };
        }
        if (code === 'ELOOP') return { kind: 'refused', reason: 'symlinked' };
        return { kind: 'refused', reason: 'unreadable', detail: code ?? 'open failed' };
    }
    try {
        const stat = fstatSync(fd);
        const refusal = gate({
            uid: stat.uid, mode: stat.mode, isFile: stat.isFile(), size: Number(stat.size),
        });
        if (refusal) return { kind: 'refused', reason: refusal.reason };

        const buffer = Buffer.allocUnsafe(Number(stat.size));
        let read = 0;
        while (read < buffer.length) {
            const chunk = readSync(fd, buffer, read, buffer.length - read, read);
            if (chunk === 0) break;
            read += chunk;
        }
        return { kind: 'ok', content: buffer.subarray(0, read).toString('utf8') };
    } catch (error) {
        return { kind: 'refused', reason: 'unreadable', detail: (error as NodeJS.ErrnoException).code ?? 'read failed' };
    } finally {
        closeSync(fd);
    }
}

/**
 * Walks a path from the filesystem root and checks every component.
 *
 * Checking only the final directory is not enough: a 0700 leaf inside a
 * writable parent can be renamed away and replaced, after which the lease and
 * receipts are read from a directory the agent controls. Each ancestor must be
 * a real directory, not a symlink, not owned by the agent, and not writable by
 * group or other. No sticky-bit exception is assumed — a shared temp directory
 * is not a safe home for fencing state, and guessing that it is would be the
 * kind of assumption this check exists to remove.
 */
function trustedPathRefusal(
    target: string,
    agentUid: number,
    reason: ManagedIdentityRefusal,
    deps: ManagedProvisioningDeps,
): { reason: ManagedIdentityRefusal; detail: string } | null {
    const resolved = resolve(target);
    const parts = resolved.split(sep).filter((part) => part.length > 0);
    const chain: string[] = [sep];
    for (let i = 0; i < parts.length; i += 1) {
        chain.push(sep + parts.slice(0, i + 1).join(sep));
    }
    for (const component of chain) {
        let stat: { uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean };
        try {
            stat = deps.lstatDir(component);
        } catch (error) {
            return { reason, detail: `${component}: ${(error as NodeJS.ErrnoException).code ?? 'stat failed'}` };
        }
        if (stat.isSymbolicLink) return { reason, detail: `${component}: symlink` };
        if (!stat.isDirectory) return { reason, detail: `${component}: not a directory` };
        if (stat.uid === agentUid) return { reason, detail: `${component}: owned by agent uid` };
        if ((stat.mode & 0o022) !== 0) return { reason, detail: `${component}: group or world writable` };
    }
    return null;
}

/**
 * The state directory holds the receipts and the lease that fencing reads. If
 * agent code can write there it can fabricate a stopped receipt or roll the
 * epoch back, so it must be outside the workspace and not agent-writable —
 * along its whole path, not just at the leaf.
 */
function stateDirRefusal(
    stateDir: string,
    workspaceDir: string,
    agentUid: number,
    deps: ManagedProvisioningDeps,
): { reason: ManagedIdentityRefusal; detail: string } | null {
    if (!isAbsolute(stateDir)) return { reason: 'state-dir-unsafe', detail: 'not absolute' };
    const resolvedState = resolve(stateDir);
    const resolvedWorkspace = resolve(workspaceDir);
    const rel = relative(resolvedWorkspace, resolvedState);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return { reason: 'state-dir-unsafe', detail: 'inside workspace' };
    }
    return trustedPathRefusal(resolvedState, agentUid, 'state-dir-unsafe', deps);
}

export function resolveManagedRuntimeIdentity(
    path: string = managedProvisioningPath(),
    deps: ManagedProvisioningDeps = defaultDeps,
): ManagedIdentityResolution {
    const file = readProvisioningFile(path, deps.statGate ?? assertProvisioningStat);
    if (file.kind === 'absent') return { status: 'absent' };
    if (file.kind === 'refused') {
        return { status: 'refused', reason: file.reason, ...(file.detail ? { detail: file.detail } : {}) };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return { status: 'refused', reason: 'malformed', detail: 'not JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'refused', reason: 'malformed', detail: 'not an object' };
    }
    const record = parsed as Record<string, unknown>;

    const runtimeId = readString(record.runtimeId);
    const workspaceId = readString(record.workspaceId);
    const projectId = readString(record.projectId);
    const keyId = readString(record.keyId);
    const stateDir = readString(record.stateDir, 4096);
    const workspaceDir = readString(record.workspaceDir, 4096);
    const verifierKeyB64 = readString(record.verifierPublicKey, 4096);
    if (!runtimeId || !workspaceId || !projectId || !keyId || !stateDir || !workspaceDir || !verifierKeyB64) {
        return { status: 'refused', reason: 'malformed', detail: 'missing required field' };
    }

    let verifier: KeyObject;
    try {
        verifier = parseManagedVerifierKey(Buffer.from(verifierKeyB64, 'base64'));
    } catch (error) {
        return { status: 'refused', reason: 'bad-verifier-key', detail: (error as Error).message };
    }

    const rawIsolation = record.isolation;
    if (!rawIsolation || typeof rawIsolation !== 'object' || Array.isArray(rawIsolation)) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'missing attestation' };
    }
    const isolation = rawIsolation as Record<string, unknown>;
    const backend = readString(isolation.backend);
    const agentUid = isolation.agentUid;
    const cgroupRoot = readString(isolation.cgroupRoot, 4096);
    if (!backend || !MANAGED_ISOLATION_BACKENDS.includes(backend as ManagedIsolationBackend)
        || typeof agentUid !== 'number' || !Number.isSafeInteger(agentUid) || agentUid <= 0
        || !cgroupRoot) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'incomplete attestation' };
    }

    const daemonUid = deps.getuid();
    if (daemonUid < 0 || daemonUid === agentUid) {
        return { status: 'refused', reason: 'isolation-unverified', detail: 'daemon shares the agent uid' };
    }

    // The marker decides this runtime's identity, so an agent that can replace
    // it chooses who the runtime is. Its directory chain gets the same walk.
    const unsafeMarkerDir = trustedPathRefusal(dirname(resolve(path)), agentUid, 'not-root-owned', deps);
    if (unsafeMarkerDir) {
        return { status: 'refused', reason: 'not-root-owned', detail: unsafeMarkerDir.detail };
    }

    const unsafeStateDir = stateDirRefusal(stateDir, workspaceDir, agentUid, deps);
    if (unsafeStateDir) {
        return { status: 'refused', reason: unsafeStateDir.reason, detail: unsafeStateDir.detail };
    }

    // The declared cgroup root says where processes are meant to land, not that
    // they do. Only the backend can answer that, and today none can.
    const probe = deps.probeIsolationBackend({
        backend: backend as ManagedIsolationBackend,
        agentUid,
        cgroupRoot,
        daemonUid,
    });
    if (!probe.verified) {
        return { status: 'refused', reason: 'isolation-unverified', detail: probe.reason };
    }

    return {
        status: 'active',
        identity: {
            runtimeId,
            workspaceId,
            projectId,
            keyId,
            verifier,
            stateDir: resolve(stateDir),
            isolation: { backend: backend as ManagedIsolationBackend, agentUid, cgroupRoot },
        },
    };
}
