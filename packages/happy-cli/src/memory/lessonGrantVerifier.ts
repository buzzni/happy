/**
 * Verifies the short-lived, intent-bound grant the studio mints for one lesson
 * action (`aplus-dev-studio/packages/web-ui/server/lessonGrant.ts`).
 *
 * This is deliberately verify-only. The key is Ed25519 and this side holds the
 * public half, so a compromised daemon can check a grant and can never mint
 * one — the authority to say "a person approved this" stays with the server
 * that authenticated that person.
 *
 * It is also the only thing on this host that may confer `lesson.manage`. The
 * MCP caller grant (`src/daemon/mcpCallerGrantEnvelope.ts`) binds only machine
 * and project and is spent at spawn; it says a session belongs to a project,
 * never that somebody approved a lesson. Treating it as manage authority would
 * let anyone who can start a session rewrite what every later session is
 * taught.
 *
 * The parse rules mirror the minting side field for field. Identifiers are
 * taken exactly as signed and a non-canonical spelling is refused rather than
 * trimmed: two spellings of one scope is how a comparison against the
 * authority stops meaning what it looks like it means.
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';

/**
 * The protocol half of the audience. Never used alone: a fixed constant would
 * let a grant minted by a staging studio verify against a production host,
 * because both speak this protocol. The deployment origin is appended, and this
 * host derives it from the base URL it fetched the verification key from.
 */
export const LESSON_GRANT_PROTOCOL = 'saycode-lesson-host-v1';

/** Must match `lessonGrantAudience` on the minting side, character for character. */
export function lessonGrantAudience(baseUrl: string): string {
    return `${LESSON_GRANT_PROTOCOL}@${new URL(baseUrl).origin}`;
}
export const LESSON_GRANT_MAX_TTL_MS = 60_000;

export type LessonCapability = 'lesson.read' | 'lesson.review' | 'lesson.manage';
export const LESSON_OPERATIONS = ['snapshot', 'approve', 'reject', 'set-recall-enabled', 'configure'] as const;
export type LessonOperation = (typeof LESSON_OPERATIONS)[number];

export interface LessonGrantClaims {
    v: 1;
    aud: string;
    op: LessonOperation;
    digest: string;
    userId: string;
    projectId: string;
    machineId: string;
    /**
     * The project's workspace, as the studio read it off the authorized row.
     *
     * This is the only path the host may open a store for. The MCP caller
     * grant this daemon already holds signs a project and a machine but not a
     * directory, so without this claim a spawn holding a valid grant for
     * project A could name project B's directory and have B's memory opened
     * under A's authority.
     */
    workspaceDir: string;
    capabilities: readonly LessonCapability[];
    iat: number;
    expiresAt: number;
}

export type LessonGrantFailure =
    | 'malformed'
    | 'bad-signature'
    | 'wrong-audience'
    | 'wrong-operation'
    | 'wrong-project'
    | 'wrong-machine'
    | 'payload-mismatch'
    | 'expired'
    | 'lifetime-too-long'
    | 'replayed'
    /** The single-use table is full; refusing is the only safe answer. */
    | 'busy';

export type LessonGrantResult =
    | { ok: true; claims: LessonGrantClaims }
    | { ok: false; reason: LessonGrantFailure };

/**
 * Byte-identical to the minting side's `canonicalLessonDigest`.
 *
 * Keys sorted, `undefined` dropped. The request is digested after the envelope
 * has been split off it, so the two sides agree on what "the request" is even
 * though the RPC carries them in one flat object.
 */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export function canonicalLessonDigest(value: unknown): string {
    return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value !== value.trim()) return null;
    return value.length > 0 && value.length <= 240 ? value : null;
}

function readInt(value: unknown, min: number): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return value >= min ? value : null;
}

function parseClaims(raw: unknown): LessonGrantClaims | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.v !== 1) return null;
    const aud = typeof record.aud === 'string' && record.aud.length > 0 && record.aud.length <= 120 ? record.aud : null;
    const op = LESSON_OPERATIONS.includes(record.op as LessonOperation) ? record.op as LessonOperation : null;
    const digest = typeof record.digest === 'string' && /^[a-f0-9]{64}$/.test(record.digest) ? record.digest : null;
    const userId = readId(record.userId);
    const projectId = readId(record.projectId);
    const machineId = readId(record.machineId);
    // Absolute only. A relative path would resolve against whatever the
    // daemon's working directory happens to be.
    const workspaceDir = typeof record.workspaceDir === 'string'
        && record.workspaceDir === record.workspaceDir.trim()
        && record.workspaceDir.startsWith('/')
        && record.workspaceDir.length <= 4_096
        ? record.workspaceDir : null;
    const iat = readInt(record.iat, 0);
    const expiresAt = readInt(record.expiresAt, 1);
    if (!aud || !op || !digest || !userId || !projectId || !machineId || !workspaceDir
        || iat === null || expiresAt === null) return null;
    if (!Array.isArray(record.capabilities) || record.capabilities.length === 0 || record.capabilities.length > 3) return null;
    const known: readonly string[] = ['lesson.read', 'lesson.review', 'lesson.manage'];
    // An unrecognised capability is refused, never dropped: silently narrowing
    // a grant would turn "we do not know what this permits" into a permission.
    if (!record.capabilities.every((value) => typeof value === 'string' && known.includes(value))) return null;
    return {
        v: 1, aud, op, digest, userId, projectId, machineId, workspaceDir,
        capabilities: record.capabilities as LessonCapability[], iat, expiresAt,
    };
}

export interface LessonGrantVerifierOptions {
    /** Base64 SPKI Ed25519 key from `GET /api/lesson-grant/public-key`. */
    publicKeyBase64: string;
    /** This daemon's machine id. A grant for another machine is refused. */
    machineId: string;
    /** From {@link lessonGrantAudience}; binds the studio deployment. */
    audience: string;
    now?: () => number;
    /**
     * How many spent grants may be remembered at once.
     *
     * There is no eviction policy beyond expiry: forgetting a grant that has
     * not expired would make it usable again, so a full table refuses new
     * mutations instead. Entries are retained until their own signed expiry,
     * which is the only instant at which forgetting one is safe.
     */
    maxSpentEntries?: number;
}

export interface LessonGrantVerifier {
    verify(input: { envelope: unknown; request: unknown }): LessonGrantResult;
    /**
     * Verifies and burns the grant. Used for mutations only: a snapshot may be
     * retried by a slow machine, an approval may not.
     */
    consume(input: { envelope: unknown; request: unknown }): LessonGrantResult;
}

export function createLessonGrantVerifier(options: LessonGrantVerifierOptions): LessonGrantVerifier {
    const publicKey = createPublicKey({
        key: Buffer.from(options.publicKeyBase64, 'base64'), format: 'der', type: 'spki',
    });
    const audience = options.audience;
    const now = options.now ?? Date.now;
    const maxSpentEntries = options.maxSpentEntries ?? 1_000;
    const spent = new Map<string, number>();

    function verify(input: { envelope: unknown; request: unknown }): LessonGrantResult {
        if (typeof input.envelope !== 'string' || input.envelope.length > 32_768) {
            return { ok: false, reason: 'malformed' };
        }
        const parts = input.envelope.split('.');
        // Exactly two. A third segment would mean the signature covered only
        // part of what was presented.
        if (parts.length !== 2) return { ok: false, reason: 'malformed' };
        const [payload, signature] = parts;
        if (!payload || !signature) return { ok: false, reason: 'malformed' };

        let verified: boolean;
        try {
            verified = verifyEd25519(
                null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64url'),
            );
        } catch {
            return { ok: false, reason: 'bad-signature' };
        }
        if (!verified) return { ok: false, reason: 'bad-signature' };

        let decoded: unknown;
        try {
            decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
            return { ok: false, reason: 'malformed' };
        }
        const claims = parseClaims(decoded);
        if (!claims) return { ok: false, reason: 'malformed' };

        if (claims.aud !== audience) return { ok: false, reason: 'wrong-audience' };
        // An expiry at or before issue is not a window, and an issue time in the
        // future would let a grant outlive the cap by however far it was dated
        // forward. Both are malformed rather than merely expired.
        if (claims.expiresAt <= claims.iat) return { ok: false, reason: 'malformed' };
        if (claims.iat > now()) return { ok: false, reason: 'malformed' };
        if (claims.expiresAt - claims.iat > LESSON_GRANT_MAX_TTL_MS) return { ok: false, reason: 'lifetime-too-long' };
        // The boundary itself is refused: an expiry is the first instant the
        // grant is no longer valid, not the last instant it is.
        if (now() >= claims.expiresAt) return { ok: false, reason: 'expired' };
        if (claims.machineId !== options.machineId) return { ok: false, reason: 'wrong-machine' };

        const request = input.request;
        if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, reason: 'malformed' };
        const record = request as Record<string, unknown>;
        if (record.operation !== claims.op) return { ok: false, reason: 'wrong-operation' };
        if (record.projectId !== claims.projectId) return { ok: false, reason: 'wrong-project' };
        if (canonicalLessonDigest(request) !== claims.digest) return { ok: false, reason: 'payload-mismatch' };

        return { ok: true, claims };
    }

    return {
        verify,
        consume(input) {
            const result = verify(input);
            if (!result.ok) return result;
            const current = now();
            // Only expired entries are forgotten. Clearing the table to make
            // room would hand every still-valid grant back for a second use.
            for (const [key, expiry] of spent) if (expiry <= current) spent.delete(key);
            // The digest plus the issue time names this grant: a second click
            // produces a new `iat`, so a legitimate retry of the *action* is a
            // new grant while a replayed envelope is not.
            const key = `${result.claims.digest}:${result.claims.iat}`;
            if (spent.has(key)) return { ok: false, reason: 'replayed' };
            if (spent.size >= maxSpentEntries) return { ok: false, reason: 'busy' };
            // Retained to the grant's own signed expiry: any shorter and the
            // envelope becomes usable again while it is still valid.
            spent.set(key, result.claims.expiresAt);
            return result;
        },
    };
}
