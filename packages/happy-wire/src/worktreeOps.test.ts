/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree — the rules the web server and
 * the daemon share for worktrees on a strict machine: names and managed paths, the operation
 * ticket, and the result the daemon attests.
 */
import { describe, expect, it } from 'vitest';
import {
  WORKTREE_OPS_CAPABILITY,
  canonicalWorktreeJson,
  isManagedWorktreePath,
  isProjectWorktreePath,
  isSameWorktreePath,
  managedWorktreePath,
  readWorktreeTicket,
  resolveWorktreeName,
  resolveWorktreeRepoRoot,
  sanitizeWorktreeName,
  worktreeAttestationPayload,
  worktreeOpsCapabilitySchema,
} from './worktreeOps';

const opId = Buffer.alloc(16, 4).toString('base64');
const ticket = (over: Record<string, unknown> = {}) => ({
  v: 1,
  opId,
  op: 'create',
  projectId: 'p1',
  machineId: 'm1',
  issuedAt: 1_790_000_000_000,
  expiresAt: 1_790_000_600_000,
  params: {
    workspaceDir: '/root/work/u/p1',
    name: 'bright-fox-1a2b',
    baseRef: null,
    baseSource: 'local',
    snapshotCurrent: true,
    copyOwnerRuntimeFiles: true,
    expectedRepoRoot: null,
  },
  ...over,
});

describe('worktree names', () => {
  it('sanitizes requested names as the server always has', () => {
    expect(sanitizeWorktreeName('  Feature/Login Page!! ')).toBe('feature/login-page');
    expect(sanitizeWorktreeName('--a//b--')).toBe('a/b');
    expect(sanitizeWorktreeName('x'.repeat(80))).toHaveLength(60);
  });

  it('generates a name when none usable was asked for', () => {
    expect(resolveWorktreeName({ requested: '!!!', random: () => 0 })).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
    expect(resolveWorktreeName({ requested: 'my-version' })).toBe('my-version');
  });
});

describe('managed worktree paths', () => {
  it('builds and recognizes the project namespace path', () => {
    expect(managedWorktreePath('/repo', 'p1', 'feature/x')).toBe('/repo/.aplus/worktrees/p1/feature/x');
    expect(isProjectWorktreePath('/repo/.aplus/worktrees/p1/feature/x', '/repo', 'p1')).toBe(true);
  });

  it('refuses paths outside the repo, another project, traversal and unsanitized names', () => {
    expect(isProjectWorktreePath('/other/.aplus/worktrees/p1/x', '/repo', 'p1')).toBe(false);
    expect(isProjectWorktreePath('/repo/.aplus/worktrees/p2/x', '/repo', 'p1')).toBe(false);
    expect(isProjectWorktreePath('/repo/.aplus/worktrees/p1/../../etc', '/repo', 'p1')).toBe(false);
    expect(isProjectWorktreePath('/repo/.aplus/worktrees/p1/', '/repo', 'p1')).toBe(false);
    expect(isProjectWorktreePath('/repo/.aplus/worktrees/p1/Upper Case', '/repo', 'p1')).toBe(false);
  });

  it('reads Windows paths with either separator, as git and the store write them', () => {
    expect(isProjectWorktreePath('C:/repo/.aplus/worktrees/p1/x', 'C:\\repo', 'p1')).toBe(true);
    expect(isSameWorktreePath('C:\\Repo\\.aplus\\worktrees\\p1\\x', 'c:/repo/.aplus/worktrees/p1/x')).toBe(true);
    expect(resolveWorktreeRepoRoot('/repo/.aplus/worktrees/p1/x')).toBe('/repo');
    expect(isManagedWorktreePath('/repo/src')).toBe(false);
  });
});

describe('worktree operation ticket', () => {
  it('reads a ticket for a known operation with its params', () => {
    expect(readWorktreeTicket(ticket())).toMatchObject({ ok: true, ticket: { op: 'create', params: { name: 'bright-fox-1a2b' } } });
  });

  it('refuses a ticket with unknown fields, an unknown operation or params of another operation', () => {
    expect(readWorktreeTicket(ticket({ extra: 1 })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ op: 'format-disk' })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ op: 'remove' })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, name: '../x' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, baseRef: '--upload-pack=evil' } })).ok).toBe(false);
  });
});

describe('worktree result attestation', () => {
  it('canonicalizes so the daemon and the server sign the same bytes', () => {
    expect(canonicalWorktreeJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  });

  it('binds the result to the ticket it answers', () => {
    const read = readWorktreeTicket(ticket());
    if (!read.ok) throw new Error('ticket');
    const payload = worktreeAttestationPayload(read.ticket, { path: '/repo/.aplus/worktrees/p1/bright-fox-1a2b' }, 1_790_000_001_000);
    expect(payload).toEqual({
      v: 1,
      purpose: 'worktree-result',
      opId,
      op: 'create',
      machineId: 'm1',
      projectId: 'p1',
      params: read.ticket.params,
      result: { path: '/repo/.aplus/worktrees/p1/bright-fox-1a2b' },
      finishedAt: 1_790_000_001_000,
    });
  });
});

describe('worktreeOpsCapabilitySchema', () => {
  it('reads the capability the daemon advertises', () => {
    expect(worktreeOpsCapabilitySchema.parse(WORKTREE_OPS_CAPABILITY)).toEqual({ version: 1 });
    expect(worktreeOpsCapabilitySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
