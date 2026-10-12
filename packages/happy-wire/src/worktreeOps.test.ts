/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 worktree — the rules the web server and
 * the daemon share for worktrees on a strict machine: names and managed paths, the operation
 * ticket, and the result the daemon attests.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  WORKTREE_OPS_CAPABILITY,
  canonicalWorktreeJson,
  readSealedGitCredential,
  isManagedWorktreePath,
  isProjectWorktreePath,
  isSameWorktreePath,
  managedWorktreePath,
  readWorktreeTicket,
  resolveWorktreeName,
  resolveWorktreeRepoRoot,
  sanitizeWorktreeName,
  worktreeAttestationPayload,
  worktreeOpMethod,
  worktreeOpResultSchemas,
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
    remoteUrl: null,
  },
  ...over,
});

describe('worktree names', () => {
  it('sanitizes requested names as the server always has', () => {
    expect(sanitizeWorktreeName('  Feature/Login Page!! ')).toBe('feature/login-page');
    expect(sanitizeWorktreeName('--a//b--')).toBe('a/b');
    expect(sanitizeWorktreeName('x'.repeat(80))).toHaveLength(60);
  });

  it('does not end a name cut at 60 characters with a separator, so a sanitized name stays sanitized', () => {
    expect(sanitizeWorktreeName(`${'a'.repeat(59)}-b`)).toBe('a'.repeat(59));
    expect(sanitizeWorktreeName(`${'a'.repeat(59)}/b`)).toBe('a'.repeat(59));
    const name = sanitizeWorktreeName(`${'a'.repeat(59)}-b`);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, name } })).ok).toBe(true);
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

  it('accepts version-1 create tickets issued before remoteUrl was added', () => {
    const { remoteUrl: _remoteUrl, ...legacyParams } = ticket().params;
    expect(readWorktreeTicket(ticket({ params: legacyParams }))).toMatchObject({
      ok: true,
      ticket: { params: { remoteUrl: null } },
    });
  });

  it('refuses a ticket with unknown fields, an unknown operation or params of another operation', () => {
    expect(readWorktreeTicket(ticket({ extra: 1 })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ op: 'format-disk' })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ op: 'remove' })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, name: '../x' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, baseRef: '--upload-pack=evil' } })).ok).toBe(false);
  });

  it('refuses a ticket that expires before it was issued', () => {
    expect(readWorktreeTicket(ticket({ expiresAt: 1_790_000_000_000 })).ok).toBe(false);
  });

  it('refuses paths with . or .. segments and refs with control characters', () => {
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, workspaceDir: '/root/work/../../etc' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, workspaceDir: '/root/./work' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, workspaceDir: 'C:\\work\\..\\x' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, baseRef: 'main\u001b[2J' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, workspaceDir: 'C:\\work\\p1', baseRef: 'origin/main', snapshotCurrent: false } })).ok).toBe(true);
  });

  it('refuses a ticket that lives longer than ten minutes', () => {
    expect(readWorktreeTicket(ticket({ expiresAt: 1_790_000_600_001 })).ok).toBe(false);
  });

  it('refuses create params the server never combines', () => {
    const create = ticket().params;
    expect(readWorktreeTicket(ticket({ params: { ...create, snapshotCurrent: true, baseRef: 'main' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...create, snapshotCurrent: false, baseSource: 'origin', baseRef: null } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({ params: { ...create, snapshotCurrent: false, baseSource: 'origin', baseRef: 'main' } })).ok).toBe(true);
  });

  it('reads remove params for a worktree without a branch, and a dry run', () => {
    const params = { worktreePath: '/repo/.aplus/worktrees/p1/x', branch: null, force: false, dryRun: true };
    expect(readWorktreeTicket(ticket({ op: 'remove', params })).ok).toBe(true);
  });

  it('types params by operation', () => {
    const read = readWorktreeTicket(ticket());
    if (!read.ok || read.ticket.op !== 'create') throw new Error('ticket');
    expectTypeOf(read.ticket.params.name).toEqualTypeOf<string>();
    expectTypeOf(read.ticket.params.baseSource).toEqualTypeOf<'local' | 'origin'>();
  });
});

describe('worktree result attestation', () => {
  it('canonicalizes so the daemon and the server sign the same bytes', () => {
    expect(canonicalWorktreeJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  });

  it('refuses values JSON would change or drop, so both sides cannot sign different meanings', () => {
    expect(() => canonicalWorktreeJson([1, undefined])).toThrow();
    expect(() => canonicalWorktreeJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalWorktreeJson({ a: new Date(0) })).toThrow();
    expect(() => canonicalWorktreeJson({ a: 1n })).toThrow();
    expect(() => canonicalWorktreeJson(undefined)).toThrow();
    expect(canonicalWorktreeJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
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

describe('worktree operations that change, publish or switch work', () => {
  const read = (op: string, params: Record<string, unknown>) => readWorktreeTicket(ticket({ op, params })).ok;
  const path = '/repo/.aplus/worktrees/p1/x';

  it('reads the params of each operation', () => {
    expect(read('apply', { worktreePath: path, branch: 'x', baseBranch: 'main' })).toBe(true);
    expect(read('update', { worktreePath: path, branch: 'x', baseBranch: 'main', conflictChoice: 'base' })).toBe(true);
    expect(read('update', { worktreePath: path, branch: 'x', baseBranch: 'main', conflictChoice: 'mine' })).toBe(false);
    expect(read('recover', { worktreePath: path, branch: 'x' })).toBe(true);
    expect(read('adopt-check', { workspaceDir: '/repo', worktreePath: path, expectedRepoRoot: null })).toBe(true);
    expect(read('publish', { worktreePath: path, branch: 'x', remoteUrl: 'https://github.com/o/r.git' })).toBe(true);
    expect(read('reconcile', { worktreePath: path, branch: 'x', baseBranch: 'main', expectedHead: 'a'.repeat(40) })).toBe(true);
    expect(read('reconcile', { worktreePath: path, branch: 'x', baseBranch: 'main', expectedHead: 'HEAD' })).toBe(false);
    expect(read('create-branch', { workspaceDir: '/repo', branchName: 'feature/a' })).toBe(true);
    expect(read('prepare-conversation', {
      workspaceDir: '/repo', baseBranch: 'main', source: 'origin', allowCurrentBranchDirty: true,
      remoteUrl: null, statusPathspecs: ['.', ':(exclude,glob)**/.env*'],
    })).toBe(true);
  });

  it('takes only a plain http(s) remote without credentials in it', () => {
    const publish = (remoteUrl: string) => read('publish', { worktreePath: path, branch: 'x', remoteUrl });
    expect(publish('https://gitlab.example.com:8443/group/project.git')).toBe(true);
    expect(publish('https://user:token@github.com/o/r.git')).toBe(false);
    expect(publish('file:///etc/passwd')).toBe(false);
    expect(publish('ext::sh -c touch% /tmp/x')).toBe(false);
    expect(publish('https://github.com/o/r.git\n')).toBe(false);
  });

  it('fetches a create base from a remote url only for an origin base', () => {
    expect(readWorktreeTicket(ticket({ params: { ...ticket().params, remoteUrl: 'https://github.com/o/r.git' } })).ok).toBe(false);
    expect(readWorktreeTicket(ticket({
      params: { ...ticket().params, snapshotCurrent: false, baseSource: 'origin', baseRef: 'main', remoteUrl: 'https://github.com/o/r.git' },
    })).ok).toBe(true);
  });

  it('bounds the status pathspecs the server passes', () => {
    const prepare = (statusPathspecs: unknown) => read('prepare-conversation', {
      workspaceDir: '/repo', baseBranch: 'main', source: 'local', allowCurrentBranchDirty: false, remoteUrl: null, statusPathspecs,
    });
    expect(prepare(['bad\u0000'])).toBe(false);
    expect(prepare(Array.from({ length: 101 }, () => '.'))).toBe(false);
  });
});

describe('sealed git credential', () => {
  const credential = (over: Record<string, unknown> = {}) => ({
    v: 1, purpose: 'git-credential', machineId: 'm1', opId, username: 'x-access-token', token: 'ghs_secret', ...over,
  });

  it('reads a credential sealed for this machine and this operation', () => {
    expect(readSealedGitCredential(credential(), { machineId: 'm1', opId })).toEqual({ ok: true, username: 'x-access-token', token: 'ghs_secret' });
  });

  it('refuses one sealed for another machine or operation, or with a line break', () => {
    expect(readSealedGitCredential(credential(), { machineId: 'm2', opId }).ok).toBe(false);
    expect(readSealedGitCredential(credential({ opId: Buffer.alloc(16, 9).toString('base64') }), { machineId: 'm1', opId }).ok).toBe(false);
    expect(readSealedGitCredential(credential({ token: 'a\nb' }), { machineId: 'm1', opId }).ok).toBe(false);
    expect(readSealedGitCredential(credential({ extra: 1 }), { machineId: 'm1', opId }).ok).toBe(false);
    expect(readSealedGitCredential(credential({ purpose: 'spawn-env' }), { machineId: 'm1', opId }).ok).toBe(false);
  });
});

describe('worktree operation results', () => {
  it('names each operation\'s daemon method', () => {
    expect(worktreeOpMethod('create')).toBe('worktree:create');
  });

  it('reads the result of each operation strictly', () => {
    const created = {
      path: '/repo/.aplus/worktrees/p1/x', branch: 'x', baseBranch: 'main', baseRevision: null,
      repoRelativeDir: '', repoRoot: '/repo',
    };
    expect(worktreeOpResultSchemas.create.parse(created)).toEqual(created);
    expect(worktreeOpResultSchemas.create.safeParse({ ...created, extra: 1 }).success).toBe(false);
    expect(worktreeOpResultSchemas.status.parse({ dirty: true, behind: 0, ahead: 2 })).toEqual({ dirty: true, behind: 0, ahead: 2 });
    expect(worktreeOpResultSchemas.remove.safeParse({ outcome: 'gone' }).success).toBe(false);
    expect(worktreeOpResultSchemas.capability.parse({ capable: false, reason: 'not-git', branch: null, branches: [] }).reason).toBe('not-git');
    expect(worktreeOpResultSchemas.apply.parse({ appliedToBranch: 'main' })).toEqual({ appliedToBranch: 'main' });
    expect(worktreeOpResultSchemas.publish.safeParse({ commit: 'HEAD' }).success).toBe(false);
    expect(worktreeOpResultSchemas['prepare-conversation'].parse({ branch: 'main' })).toEqual({ branch: 'main' });
  });
});

describe('worktreeOpsCapabilitySchema', () => {
  it('reads the capability the daemon advertises', () => {
    expect(worktreeOpsCapabilitySchema.parse(WORKTREE_OPS_CAPABILITY)).toEqual({ version: 1 });
    expect(worktreeOpsCapabilitySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
