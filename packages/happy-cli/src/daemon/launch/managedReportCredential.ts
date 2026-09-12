/**
 * How a managed child gets the material it signs its lifecycle reports with.
 *
 * The control server refuses a managed report that no launch vouched for: the
 * loopback bearer is readable by the agent's own tools, so it proves "something
 * on this host" and nothing about *which* launch is reporting. The registry
 * side of that was already wired; this is the other side — the child needs the
 * per-launch secret, or every real report is refused as `capability-missing`.
 *
 * ## Why not the envelope
 *
 * The B2 envelope is the parent's document: the parent builds it, signs for it,
 * and the launcher re-parses it precisely so no field the parent did not
 * validate can ride inside those bytes. Adding a launcher-minted secret to it
 * would put something the parent never saw inside the parent's signature
 * boundary. So this travels on its **own** inherited descriptor.
 *
 * ## Why not the environment
 *
 * `/proc/<pid>/environ` is readable by the process itself and by anything that
 * shares its uid, and the environment is copied into every child it spawns.
 * A secret there is a secret every tool call inherits. The descriptor number is
 * not a secret and does travel in the environment — the same split the
 * bootstrap envelope already uses.
 *
 * The descriptor is read once and closed, so a later reader finds nothing.
 */
import { close, read as readFd } from 'node:fs';

import {
    mintManagedReportCapability,
    type ManagedReportKind,
} from './managedReportCapability';

/** Names the descriptor, never the secret. */
export const MANAGED_REPORT_FD_ENV = 'HAPPY_MANAGED_REPORT_FD';

/** The number the launcher binds it to in the child. Bootstrap holds 3. */
export const MANAGED_REPORT_CHILD_FD = 4;

/** Bounded: this document is two short fields, never a stream. */
export const MANAGED_REPORT_CREDENTIAL_MAX_BYTES = 4096;

export type ManagedReportCredential = {
    launchId: string;
    secret: Buffer;
    /**
     * Where this launch sends its reports.
     *
     * Carried here because the ordinary control client finds the daemon by
     * reading the daemon's own state file and then signalling its pid — and a
     * managed child runs as a **different uid**. That file is `0600` and owned
     * by the daemon, and `kill(pid, 0)` across uids is `EPERM`, so a provider
     * that had to go that way could not report at all. It is an address, not a
     * credential: the capability is what authorises the report.
     */
    reportBaseUrl: string;
};

function fail(detail: string): never {
    throw new ManagedReportCredentialError(detail);
}

export class ManagedReportCredentialError extends Error {
    constructor(detail: string) {
        super(`managed report credential: ${detail}`);
        this.name = 'ManagedReportCredentialError';
    }
}

/** The wire form the launcher stages. Base64 so it survives JSON unchanged. */
export function encodeManagedReportCredential(credential: ManagedReportCredential): Buffer {
    return Buffer.from(JSON.stringify({
        v: 1,
        launchId: credential.launchId,
        secretBase64: Buffer.from(credential.secret).toString('base64'),
        reportBaseUrl: credential.reportBaseUrl,
    }), 'utf8');
}

export function parseManagedReportCredential(raw: Buffer): ManagedReportCredential {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch {
        throw new ManagedReportCredentialError('is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ManagedReportCredentialError('must be an object');
    }
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) throw new ManagedReportCredentialError('unsupported version');
    const launchId = record.launchId;
    if (typeof launchId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(launchId)) {
        throw new ManagedReportCredentialError('launchId is not a safe id');
    }
    const secretBase64 = record.secretBase64;
    if (typeof secretBase64 !== 'string') {
        throw new ManagedReportCredentialError('secret must be base64');
    }
    const secret = Buffer.from(secretBase64, 'base64');
    // The capability's own floor. A short secret is refused here rather than at
    // the first report, where it would look like a signing failure.
    if (secret.length < 32) throw new ManagedReportCredentialError('secret must be at least 32 bytes');
    const reportBaseUrl = record.reportBaseUrl;
    if (typeof reportBaseUrl !== 'string') {
        throw new ManagedReportCredentialError('reportBaseUrl must be a string');
    }
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(reportBaseUrl);
    } catch {
        return fail('reportBaseUrl must be an absolute URL');
    }
    /*
     * Loopback only. This address is handed to a process the agent influences,
     * and an off-host address would turn every lifecycle report into an
     * outbound request carrying the session's own metadata.
     */
    const loopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '[::1]';
    if (parsedUrl.protocol !== 'http:' || !loopback) {
        throw new ManagedReportCredentialError('reportBaseUrl must be http on loopback');
    }
    if (parsedUrl.search !== '' || parsedUrl.hash !== '') {
        throw new ManagedReportCredentialError('reportBaseUrl must be a bare origin');
    }
    return { launchId, secret, reportBaseUrl: parsedUrl.origin };
}

/**
 * Reads the credential off the inherited descriptor and closes it.
 *
 * Bounded by one read of at most the cap plus a byte, so an oversized document
 * is refused rather than buffered. The descriptor is closed in every path: a
 * refusal that leaves it open leaves the secret readable.
 */
export async function readManagedReportCredentialFromFd(
    fd: number,
): Promise<ManagedReportCredential> {
    if (!Number.isInteger(fd) || fd < 0) {
        throw new ManagedReportCredentialError('descriptor must be a non-negative integer');
    }
    try {
        const buffer = Buffer.alloc(MANAGED_REPORT_CREDENTIAL_MAX_BYTES + 1);
        const bytes = await new Promise<number>((resolve, reject) => {
            readFd(fd, buffer, 0, buffer.length, 0, (error, length) => {
                if (error) reject(error);
                else resolve(length);
            });
        });
        if (bytes > MANAGED_REPORT_CREDENTIAL_MAX_BYTES) {
            throw new ManagedReportCredentialError('is too large');
        }
        return parseManagedReportCredential(buffer.subarray(0, bytes));
    } finally {
        await new Promise<void>((resolve) => { close(fd, () => resolve()); });
    }
}

export type ManagedReportSigner = {
    /** The launch's own report address. Never the daemon's state file. */
    reportBaseUrl: string;
    sign: (input: {
        kind: ManagedReportKind;
        seq: number;
        expiresAt: number;
        body: unknown;
    }) => string;
};

/**
 * The child's report signer, or `null` for an ordinary spawn.
 *
 * Read once: the descriptor is consumed, and the environment variable naming it
 * is deleted before anything can fail, so a retry cannot read a number that has
 * since been closed and reassigned to something else.
 */
export async function createManagedReportSigner(
    env: NodeJS.ProcessEnv,
    deps: { read?: (fd: number) => Promise<ManagedReportCredential> } = {},
): Promise<ManagedReportSigner | null> {
    const raw = env[MANAGED_REPORT_FD_ENV];
    if (raw === undefined) return null;
    delete env[MANAGED_REPORT_FD_ENV];
    if (!/^\d+$/.test(raw.trim())) {
        throw new ManagedReportCredentialError('descriptor must be a non-negative integer');
    }
    const credential = await (deps.read ?? readManagedReportCredentialFromFd)(Number(raw));
    return {
        reportBaseUrl: credential.reportBaseUrl,
        sign: (input) => mintManagedReportCapability({
            secret: credential.secret,
            launchId: credential.launchId,
            kind: input.kind,
            seq: input.seq,
            expiresAt: input.expiresAt,
            body: input.body,
        }),
    };
}

/**
 * Who is allowed to report, keyed by generation.
 *
 * Report authority has to be revoked wherever a generation stops, and most
 * stops never mention a pid: `managed:stop` and lease maintenance both address
 * a run/attempt/epoch. Keying the revocation on the pid left a stopped
 * generation still able to report — a request already in flight when the stop
 * landed would be admitted afterwards and re-register tracking for a session
 * that is gone. So the key is the generation, and the pid is only an alias.
 */
export type ManagedReportAuthority = {
    grant: (input: {
        key: { runId: string; attemptId: string; epoch: number };
        pid: number;
        launchId: string;
    }) => void;
    /** Revoked by generation. Returns the launch that lost it, if any. */
    revoke: (key: { runId: string; attemptId: string; epoch: number }) => string | null;
    launchIdForPid: (pid: number) => string | null;
    /**
     * The launches a lease renewal applies to.
     *
     * A run-scoped renewal names one generation. A **runtime** lease names
     * none — there is no run yet — and yet it widens the write window for every
     * generation on the runtime, so it applies to all of them. Returning an
     * empty list for that case would quietly let every report authority lapse
     * while the runtime still held the right to write.
     */
    launchIdsFor: (scope: { runId?: string; attemptId?: string; epoch: number }) => string[];
};

export function createManagedReportAuthority(
    deps: { discard: (launchId: string) => void },
): ManagedReportAuthority {
    const byGeneration = new Map<string, { launchId: string; pid: number }>();
    const id = (key: { runId: string; attemptId: string; epoch: number }) =>
        `${key.runId} ${key.attemptId} ${key.epoch}`;
    return {
        grant({ key, pid, launchId }) {
            byGeneration.set(id(key), { launchId, pid });
        },
        revoke(key) {
            const entry = byGeneration.get(id(key));
            if (!entry) return null;
            byGeneration.delete(id(key));
            deps.discard(entry.launchId);
            return entry.launchId;
        },
        launchIdForPid(pid) {
            for (const entry of byGeneration.values()) {
                if (entry.pid === pid) return entry.launchId;
            }
            return null;
        },
        launchIdsFor(scope) {
            if (scope.runId !== undefined && scope.attemptId !== undefined) {
                const entry = byGeneration.get(id({
                    runId: scope.runId, attemptId: scope.attemptId, epoch: scope.epoch,
                }));
                return entry ? [entry.launchId] : [];
            }
            return [...byGeneration.values()].map((entry) => entry.launchId);
        },
    };
}
