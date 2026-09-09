import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    assertProvisioningStat,
    probeIsolationBackendUnavailable,
    resolveManagedRuntimeIdentity,
    type ManagedProvisioningDeps,
} from './managedRuntimeIdentity';

const keys = generateKeyPairSync('ed25519');
const verifierPublicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .toString('base64');

const DAEMON_UID = typeof process.getuid === 'function' ? process.getuid()! : 0;
const AGENT_UID = DAEMON_UID + 1;

let root: string;
let workspaceDir: string;
let stateDir: string;
let provisioningPath: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-identity-'));
    workspaceDir = join(root, 'workspace');
    stateDir = join(root, 'managed-state');
    provisioningPath = join(root, 'managed-runtime.json');
    mkdirSync(workspaceDir, { recursive: true, mode: 0o755 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function writeProvisioning(overrides: Record<string, unknown> = {}, path = provisioningPath): void {
    const body = {
        runtimeId: 'runtime-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        keyId: 'kid-1',
        stateDir,
        workspaceDir,
        verifierPublicKey,
        isolation: {
            backend: 'privileged-launch-supervisor',
            agentUid: AGENT_UID,
            cgroupRoot: '/sys/fs/cgroup/saycode',
        },
        ...overrides,
    };
    writeFileSync(path, JSON.stringify(body), { mode: 0o644 });
    chmodSync(path, 0o644);
}

/**
 * The real file's ownership is this test user, not root, so the root-owner
 * check is exercised separately with an injected uid. Everything else — mode,
 * symlink, path containment, directory ownership — uses the real filesystem.
 */
function deps(overrides: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            const { lstatSync } = require('node:fs') as typeof import('node:fs');
            const stat = lstatSync(path);
            return {
                uid: stat.uid,
                mode: stat.mode,
                isDirectory: stat.isDirectory(),
                isSymbolicLink: stat.isSymbolicLink(),
            };
        },
        probeIsolationBackend: () => ({ verified: true }),
        ...overrides,
    };
}

describe('resolveManagedRuntimeIdentity — provisioning file', () => {
    it('reports absent only when the file is genuinely missing', () => {
        expect(resolveManagedRuntimeIdentity(join(root, 'nope.json'), deps()))
            .toEqual({ status: 'absent' });
    });

    it('reports absent when a path component is not a directory', () => {
        writeFileSync(join(root, 'file'), 'x');
        expect(resolveManagedRuntimeIdentity(join(root, 'file', 'managed.json'), deps()))
            .toEqual({ status: 'absent' });
    });

    it('refuses — never reports absent — when the marker cannot be read', () => {
        // A downgrade is trivial if "cannot read" means "not managed": make the
        // file unreadable and every legacy spawn path reopens.
        writeProvisioning();
        chmodSync(provisioningPath, 0o000);
        const result = resolveManagedRuntimeIdentity(provisioningPath, deps());
        if (DAEMON_UID === 0) {
            // root bypasses the permission bits; assert the property that holds.
            expect(result.status).not.toBe('absent');
        } else {
            expect(result).toMatchObject({ status: 'refused', reason: 'unreadable' });
        }
    });

    it('refuses a symlinked marker instead of following it', () => {
        const real = join(root, 'real.json');
        writeProvisioning({}, real);
        symlinkSync(real, provisioningPath);
        expect(resolveManagedRuntimeIdentity(provisioningPath, deps()))
            .toMatchObject({ status: 'refused', reason: 'symlinked' });
    });

    it('refuses a group- or world-writable marker', () => {
        writeProvisioning();
        chmodSync(provisioningPath, 0o664);
        // Ownership would already refuse this file under a non-root test user,
        // so the owner check is neutralised to leave the mode check exposed.
        expect(resolveManagedRuntimeIdentity(provisioningPath, deps({
            statGate: (stat) => assertProvisioningStat({ ...stat, uid: 0 }),
        }))).toMatchObject({ status: 'refused', reason: 'world-or-group-writable' });
    });

    it('refuses a marker not owned by root', () => {
        writeProvisioning();
        // The test file is owned by the test user; on a root runner it is
        // root-owned, so force the non-root case explicitly.
        if (DAEMON_UID === 0) return;
        expect(resolveManagedRuntimeIdentity(provisioningPath, deps()))
            .toMatchObject({ status: 'refused', reason: 'not-root-owned' });
    });

    it('refuses a directory in place of the marker', () => {
        mkdirSync(join(root, 'asdir.json'));
        const result = resolveManagedRuntimeIdentity(join(root, 'asdir.json'), deps());
        expect(result.status).toBe('refused');
    });
});

/**
 * A temp file cannot be root-owned unless the suite runs as root, so these
 * cases substitute a gate that keeps every check except ownership. Ownership
 * itself is covered exhaustively against `assertProvisioningStat` below, so no
 * case is lost — the seam only moves where it is asserted.
 */
function rootOwnedDeps(overrides: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return deps({
        statGate: (stat) => assertProvisioningStat({ ...stat, uid: 0 }),
        ...overrides,
    });
}

describe('resolveManagedRuntimeIdentity — content and isolation', () => {
    it('activates only when the isolation backend confirms it is wired', () => {
        writeProvisioning();
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result.status).toBe('active');
    });

    it('refuses when the trusted launch backend is not implemented', () => {
        // This is the shipped default: T09 has not landed, so no runtime can
        // activate no matter what the attestation declares.
        writeProvisioning();
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps({
            probeIsolationBackend: probeIsolationBackendUnavailable,
        }))).toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it('refuses an unknown isolation backend', () => {
        writeProvisioning({
            isolation: { backend: 'trust-me', agentUid: AGENT_UID, cgroupRoot: '/sys/fs/cgroup/x' },
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it('refuses when the daemon shares the agent uid', () => {
        writeProvisioning({
            isolation: { backend: 'privileged-launch-supervisor', agentUid: DAEMON_UID, cgroupRoot: '/sys/fs/cgroup/x' },
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'isolation-unverified' });
    });

    it('refuses a state directory inside the agent workspace', () => {
        const inside = join(workspaceDir, 'managed');
        mkdirSync(inside, { recursive: true, mode: 0o700 });
        writeProvisioning({ stateDir: inside });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe', detail: 'inside workspace' });
    });

    it('refuses a group-writable state directory', () => {
        chmodSync(stateDir, 0o770);
        writeProvisioning();
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe' });
    });

    it('refuses a symlinked state directory', () => {
        const link = join(root, 'state-link');
        symlinkSync(stateDir, link);
        writeProvisioning({ stateDir: link });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'state-dir-unsafe', detail: 'symlink' });
    });

    it('refuses a state directory owned by the agent uid', () => {
        writeProvisioning({
            isolation: { backend: 'privileged-launch-supervisor', agentUid: DAEMON_UID + 0, cgroupRoot: '/c' },
        });
        // agentUid === owner of stateDir (the test user) must be refused.
        const result = resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps());
        expect(result.status).toBe('refused');
    });

    it('refuses malformed JSON rather than falling back to BYOS', () => {
        writeFileSync(provisioningPath, '{not json', { mode: 0o644 });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'malformed' });
    });

    it('refuses a missing required field', () => {
        writeProvisioning({ workspaceId: '  ' });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'malformed' });
    });

    it('refuses a non-ed25519 verifier key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
        writeProvisioning({
            verifierPublicKey: (rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
        });
        expect(resolveManagedRuntimeIdentity(provisioningPath, rootOwnedDeps()))
            .toMatchObject({ status: 'refused', reason: 'bad-verifier-key' });
    });
});

describe('probeIsolationBackendUnavailable', () => {
    it('is the shipped default and never verifies', () => {
        expect(probeIsolationBackendUnavailable()).toEqual({
            verified: false,
            reason: 'trusted-launch-backend-not-implemented',
        });
    });
});

describe('assertProvisioningStat', () => {
    const base = { uid: 0, mode: 0o644, isFile: true, size: 100 };

    it('accepts a root-owned, non-group-writable regular file', () => {
        expect(assertProvisioningStat(base)).toBeNull();
    });

    it('refuses any owner other than root', () => {
        for (const uid of [1, 500, 10001, 65534]) {
            expect(assertProvisioningStat({ ...base, uid }))
                .toEqual({ reason: 'not-root-owned' });
        }
    });

    it('refuses group- or world-writable modes', () => {
        for (const mode of [0o664, 0o646, 0o666, 0o622, 0o606]) {
            expect(assertProvisioningStat({ ...base, mode }))
                .toEqual({ reason: 'world-or-group-writable' });
        }
    });

    it('accepts read-only and owner-writable modes', () => {
        for (const mode of [0o400, 0o600, 0o644, 0o444]) {
            expect(assertProvisioningStat({ ...base, mode })).toBeNull();
        }
    });

    it('refuses anything that is not a regular file', () => {
        expect(assertProvisioningStat({ ...base, isFile: false }))
            .toEqual({ reason: 'not-a-regular-file' });
    });

    it('refuses a file larger than the read bound', () => {
        expect(assertProvisioningStat({ ...base, size: 16 * 1024 + 1 }))
            .toEqual({ reason: 'too-large' });
    });
});
