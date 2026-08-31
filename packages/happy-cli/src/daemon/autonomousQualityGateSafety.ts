export const MAX_AUTONOMOUS_FINGERPRINT_ENTRIES = 2_048;
export const MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES = 64 * 1_024;
export const MAX_AUTONOMOUS_FINGERPRINT_CONTENT_BYTES = 2 * MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES;

export interface AutonomousFingerprintCandidate {
    path: string;
    size: number;
    binary: boolean;
}

export interface AutonomousFingerprintInput {
    path: string;
    mode: 'content' | 'metadata';
    maxBytes: number;
}

export interface AutonomousFingerprintPlan {
    entries: AutonomousFingerprintInput[];
    contentBytes: number;
    excludedCount: number;
}

const EXCLUDED_DIRECTORY = /^(?:\.git|node_modules|dist|build|coverage|target)(?:\/|$)/i;
const SECRET_BASENAME = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|credentials?|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx))$/i;

function safeFingerprintPath(path: string): boolean {
    if (!path || path.length > 4_096 || path.includes('\0') || path.includes('\\')) return false;
    if (path.startsWith('/') || /^[a-z]:\//i.test(path)) return false;
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return false;
    if (EXCLUDED_DIRECTORY.test(path)) return false;
    if (path.startsWith('.aplus/verify-')) return false;
    return !SECRET_BASENAME.test(parts.at(-1) ?? '');
}

export function planAutonomousFingerprintInputs(
    candidates: readonly AutonomousFingerprintCandidate[],
): AutonomousFingerprintPlan {
    const safe = candidates
        .filter(candidate => safeFingerprintPath(candidate.path))
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, MAX_AUTONOMOUS_FINGERPRINT_ENTRIES);
    let contentBytes = 0;
    const entries = safe.map((candidate): AutonomousFingerprintInput => {
        const boundedSize = Number.isSafeInteger(candidate.size) && candidate.size >= 0
            ? candidate.size
            : 0;
        const canReadContent = !candidate.binary
            && boundedSize <= MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES
            && contentBytes + boundedSize <= MAX_AUTONOMOUS_FINGERPRINT_CONTENT_BYTES;
        if (!canReadContent) {
            return { path: candidate.path, mode: 'metadata', maxBytes: 0 };
        }
        contentBytes += boundedSize;
        return { path: candidate.path, mode: 'content', maxBytes: boundedSize };
    });
    return {
        entries,
        contentBytes,
        excludedCount: candidates.length - safe.length,
    };
}

const AUTHORIZATION_BEARER = /(authorization["']?\s*[:=]\s*)["']?bearer\s+[^\s,"';}]+/gi;
const SECRET_ASSIGNMENT = /(["']?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passphrase|private[_-]?key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi;
const COMMON_BARE_TOKEN = /\b(?:gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{12,})\b/gi;

export function redactAutonomousGateText(text: string): string {
    return text
        .replace(AUTHORIZATION_BEARER, '$1Bearer [REDACTED]')
        .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
        .replace(COMMON_BARE_TOKEN, '[REDACTED]');
}
