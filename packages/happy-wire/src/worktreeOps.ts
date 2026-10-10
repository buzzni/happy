import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree (worktree-strict-design.md) —
 * git worktrees on a strict machine. The server sends no command there, so the daemon runs each
 * worktree operation itself (`worktree:*` customer-lane methods), the browser asks for it with a
 * ticket the server issued, and the server records the result only after checking the daemon's
 * attestation (an HMAC with a key derived from the server-lane key).
 *
 * This module holds what both sides must agree on: worktree names and managed paths (moved from the
 * web server's `worktreeCommands.ts`, unchanged), the ticket, and the attested payload. Pure and
 * browser-safe; the HMAC itself is computed with each side's own crypto.
 */

export const WORKTREE_OPS_VERSION = 1;
export const WORKTREE_RESULT_ATTESTATION_KEY_LABEL = 'happy worktree result attestation v1';
export const WORKTREE_DIR_SEGMENT = '.aplus/worktrees';
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const worktreeOpsCapabilitySchema = z.object({ version: z.literal(WORKTREE_OPS_VERSION) });
export type WorktreeOpsCapability = z.infer<typeof worktreeOpsCapabilitySchema>;
export const WORKTREE_OPS_CAPABILITY: WorktreeOpsCapability = { version: WORKTREE_OPS_VERSION };

// ── Names and managed paths (the server's rules, moved here unchanged) ──────────────────────────

const WORKTREE_NAME_ADJECTIVES = [
  'bright', 'calm', 'eager', 'brave', 'swift', 'quiet', 'clever', 'lucky',
  'gentle', 'bold', 'fresh', 'keen', 'merry', 'noble', 'proud', 'witty',
];
const WORKTREE_NAME_ANIMALS = [
  'fox', 'otter', 'hawk', 'lynx', 'wolf', 'crane', 'koala', 'panda',
  'tiger', 'whale', 'finch', 'gecko', 'moose', 'raven', 'seal', 'newt',
];

export function sanitizeWorktreeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .replace(/\.+/g, '.')
    .slice(0, 60);
}

export function generateWorktreeName(random: () => number = Math.random): string {
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length) % items.length]!;
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0').slice(-4);
  return `${pick(WORKTREE_NAME_ADJECTIVES)}-${pick(WORKTREE_NAME_ANIMALS)}-${suffix}`;
}

export function resolveWorktreeName(input: { requested?: string | null; random?: () => number }): string {
  const sanitized = input.requested ? sanitizeWorktreeName(input.requested) : '';
  return sanitized || generateWorktreeName(input.random);
}

/** A remote workspace path is read independently of the reader's OS. */
export function isWindowsWorktreePath(value: string): boolean {
  if (value.includes('\0')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(value);
  return Boolean(unc && [unc[1], unc[2]].every((part) => part !== '.' && part !== '..' && !/[?:]/.test(part!)));
}

/** Windows paths with `/` (git writes `C:/…`, the store keeps `C:\…`); POSIX paths unchanged. */
function slashSeparated(path: string): string {
  return isWindowsWorktreePath(path) ? path.replace(/\\/g, '/') : path;
}

/** The same worktree; Windows paths ignore separators and case. */
export function isSameWorktreePath(a: string, b: string): boolean {
  if (isWindowsWorktreePath(a) && isWindowsWorktreePath(b)) {
    return slashSeparated(a).toLowerCase() === slashSeparated(b).toLowerCase();
  }
  return a === b;
}

export function worktreePathBaseName(path: string): string {
  return slashSeparated(path).split('/').filter(Boolean).at(-1) ?? '';
}

export function isManagedWorktreePath(path: string): boolean {
  return slashSeparated(path).includes(`/${WORKTREE_DIR_SEGMENT}/`);
}

/** The repository root of a managed worktree path (flat legacy or project namespace), else null. */
export function resolveWorktreeRepoRoot(path: string): string | null {
  const index = slashSeparated(path).lastIndexOf(`/${WORKTREE_DIR_SEGMENT}/`);
  return index > 0 ? path.slice(0, index) : null;
}

/** `<repoRoot>/.aplus/worktrees/<projectId>/<name>`, with the repo root's own separator style. */
export function managedWorktreePath(repoRoot: string, projectId: string, name: string): string {
  const windows = isWindowsWorktreePath(repoRoot);
  const root = windows ? slashSeparated(repoRoot).replace(/\/+$/, '') : repoRoot.replace(/\/+$/, '');
  return `${root}/${WORKTREE_DIR_SEGMENT}/${projectId}/${name}`;
}

/** Exactly a worktree of this project under this repo: a sanitized name, no traversal. */
export function isProjectWorktreePath(path: string, repoRoot: string, projectId: string): boolean {
  if (!PROJECT_ID.test(projectId)) return false;
  const prefix = managedWorktreePath(repoRoot, projectId, '');
  const normalized = isWindowsWorktreePath(path) ? slashSeparated(path) : path;
  const sameCase = isWindowsWorktreePath(path) ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix);
  if (!sameCase) return false;
  const name = normalized.slice(prefix.length);
  return name !== '' && sanitizeWorktreeName(name) === name && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// ── Operation ticket ───────────────────────────────────────────────────────────────────────────

const opIdSchema = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
const absolutePath = z.string().min(1).max(4096).refine(
  (value) => !value.includes('\0') && (value.startsWith('/') || isWindowsWorktreePath(value)),
  'absolute path',
);
const worktreeNameSchema = z.string().min(1).max(60).refine((value) => sanitizeWorktreeName(value) === value, 'worktree name');
// A ref the daemon passes to git as an argument: never read as an option, never empty.
const refSchema = z.string().min(1).max(255).refine((value) => !value.startsWith('-') && !/[\0\s]/.test(value), 'git ref');

export const worktreeOpParamsSchemas = {
  capability: z.object({ workspaceDir: absolutePath }).strict(),
  prepare: z.object({ workspaceDir: absolutePath }).strict(),
  status: z.object({ worktreePath: absolutePath, branch: refSchema, baseBranch: refSchema.nullable() }).strict(),
  create: z.object({
    workspaceDir: absolutePath,
    name: worktreeNameSchema,
    baseRef: refSchema.nullable(),
    baseSource: z.enum(['local', 'origin']),
    snapshotCurrent: z.boolean(),
    copyOwnerRuntimeFiles: z.boolean(),
    expectedRepoRoot: absolutePath.nullable(),
  }).strict(),
  remove: z.object({ worktreePath: absolutePath, branch: refSchema, force: z.boolean() }).strict(),
} as const;

export type WorktreeOp = keyof typeof worktreeOpParamsSchemas;
export const WORKTREE_OPS = Object.keys(worktreeOpParamsSchemas) as WorktreeOp[];
export type WorktreeOpParams<Op extends WorktreeOp> = z.infer<(typeof worktreeOpParamsSchemas)[Op]>;

const ticketBase = z.object({
  v: z.literal(WORKTREE_OPS_VERSION),
  opId: opIdSchema,
  op: z.enum(WORKTREE_OPS as [WorktreeOp, ...WorktreeOp[]]),
  projectId: z.string().regex(PROJECT_ID),
  machineId: z.string().min(1).max(256),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  params: z.unknown(),
}).strict();

export type WorktreeTicket = Omit<z.infer<typeof ticketBase>, 'params'> & { params: Record<string, unknown> };

/** A ticket the server issued, with params of its operation. The server alone checks its signature. */
export function readWorktreeTicket(value: unknown): { ok: true; ticket: WorktreeTicket } | { ok: false; error: string } {
  const base = ticketBase.safeParse(value);
  if (!base.success) return { ok: false, error: 'malformed ticket' };
  const params = worktreeOpParamsSchemas[base.data.op].safeParse(base.data.params);
  if (!params.success) return { ok: false, error: `malformed ${base.data.op} params` };
  return { ok: true, ticket: { ...base.data, params: params.data as Record<string, unknown> } };
}

// ── Attested result ────────────────────────────────────────────────────────────────────────────

export interface WorktreeAttestationPayload {
  v: typeof WORKTREE_OPS_VERSION;
  purpose: 'worktree-result';
  opId: string;
  op: WorktreeOp;
  machineId: string;
  projectId: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  finishedAt: number;
}

/** What the daemon attests: the ticket's operation and params, with the result it produced. */
export function worktreeAttestationPayload(
  ticket: WorktreeTicket,
  result: Record<string, unknown>,
  finishedAt: number,
): WorktreeAttestationPayload {
  return {
    v: WORKTREE_OPS_VERSION,
    purpose: 'worktree-result',
    opId: ticket.opId,
    op: ticket.op,
    machineId: ticket.machineId,
    projectId: ticket.projectId,
    params: ticket.params,
    result,
    finishedAt,
  };
}

/** JSON with sorted object keys, so both sides HMAC the same bytes. */
export function canonicalWorktreeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalWorktreeJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalWorktreeJson(item)}`).join(',')}}`;
}
