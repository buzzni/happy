import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectPath } from '@/claude/utils/path';
import { extractWorkMachineArchive, packWorkMachineArchive, selectWorkMachineTransfer } from './workMachineTransferArchive';
import { workMachineSessionStopPath, writeWorkMachineSessionStop, type WorkMachineSessionStop } from './workMachineSessionStop';

const claudeId = '11111111-2222-4333-8444-555555555555';
const codexId = '019a0000-0000-7000-8000-000000000001';

async function machineFixture(root: string) {
    const home = join(root, 'happy');
    const claudeConfigDir = join(root, 'claude');
    const codexHome = join(root, 'codex');
    const project = join(root, 'workspace', 'project');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, 'tracked.txt'), 'tracked\n');
    await writeFile(join(project, '.git', 'config'), '[core]\n\tbare = false\n');
    await writeFile(join(project, '.git', 'index.lock'), '');
    await writeFile(join(project, 'server.pid'), '123');
    await writeFile(join(project, '.git-credentials'), 'https://user:secret@example.invalid');
    await writeFile(join(home, 'access.key'), '{"token":"account-token"}', { mode: 0o600 });
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(join(claudeConfigDir, '.credentials.json'), '{"claudeAiOauth":{}}');
    const claudeRecord = join(getProjectPath(project, claudeConfigDir), `${claudeId}.jsonl`);
    await mkdir(join(claudeRecord, '..'), { recursive: true });
    await writeFile(claudeRecord, JSON.stringify({ sessionId: claudeId, cwd: project }) + '\n');
    await mkdir(join(codexHome, 'sessions', '2026', '11', '22'), { recursive: true });
    await writeFile(join(codexHome, 'auth.json'), '{"tokens":{}}');
    const codexRecord = join(codexHome, 'sessions', '2026', '11', '22', `rollout-2026-11-22T00-00-00-${codexId}.jsonl`);
    await writeFile(codexRecord, JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: project } }) + '\n');
    const record = (nativeField: string, nativeId: string, lastProcessedSeq: number) => ({
        encryptionKey: Buffer.alloc(32, 7).toString('base64'), encryptionVariant: 'dataKey', seq: 9,
        metadataVersion: 1, agentStateVersion: 1, savedAt: 1,
        metadata: { path: project, host: 'source', [nativeField]: nativeId }, lastProcessedSeq,
    });
    const archived = record('claudeSessionId', '99999999-2222-4333-8444-555555555555', 1);
    const sessions = {
        'claude-session': record('claudeSessionId', claudeId, 4),
        'codex-session': record('codexThreadId', codexId, 6),
        // Archived on this machine: closed, so a plan that leaves it out does not block.
        'other-session': { ...archived, metadata: { ...archived.metadata, lifecycleState: 'archived' } },
    };
    await writeFile(join(home, 'sessions.json'), JSON.stringify({ sessions }), { mode: 0o600 });
    // What each planned session process left when it stopped (workMachineSessionStop.ts).
    const stopped = (sessionId: string, fields: Partial<WorkMachineSessionStop>) => writeWorkMachineSessionStop(workMachineSessionStopPath(home, sessionId), {
        v: 1, sessionId, cleanStop: true, stoppedAt: 1_000, lastProcessedSeq: 0, turnInFlight: false, inputSkipped: false, ...fields,
    });
    stopped('claude-session', { lastProcessedSeq: 4, claudeSessionId: claudeId });
    stopped('codex-session', { lastProcessedSeq: 6, codexThreadId: codexId });
    return { home, claudeConfigDir, codexHome, project, claudeRecord, codexRecord, stopped };
}

describe('work machine transfer archive selection', () => {
    let root: string;
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'work-machine-archive-test-')); });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    const select = (fixture: Awaited<ReturnType<typeof machineFixture>>,
        overrides: { projectPaths?: string[]; sessionIds?: string[]; requireStopRecords?: boolean } = {}) =>
        selectWorkMachineTransfer({
            happyHome: fixture.home, claudeConfigDir: fixture.claudeConfigDir, codexHome: fixture.codexHome,
            projectPaths: overrides.projectPaths ?? [fixture.project],
            sessionIds: overrides.sessionIds ?? ['claude-session', 'codex-session'],
            requireStopRecords: overrides.requireStopRecords ?? true,
        });

    it('selects project trees and the planned provider records but no logins, locks or pid files', async () => {
        const fixture = await machineFixture(root);
        const selection = await select(fixture);
        expect(selection.roots).toEqual([fixture.project, fixture.claudeRecord, fixture.codexRecord].sort());
        expect(selection.entries).toContain(join(fixture.project, 'tracked.txt'));
        expect(selection.entries).toContain(join(fixture.project, '.git', 'config'));
        for (const excluded of [
            join(fixture.project, '.git', 'index.lock'), join(fixture.project, 'server.pid'), join(fixture.project, '.git-credentials'),
            join(fixture.home, 'access.key'), join(fixture.codexHome, 'auth.json'), join(fixture.claudeConfigDir, '.credentials.json'),
        ]) expect(selection.entries).not.toContain(excluded);
        expect(selection.sessions).toEqual([
            { sessionId: 'claude-session', provider: 'claude', nativeId: claudeId, lastProcessedSeq: 4 },
            { sessionId: 'codex-session', provider: 'codex', nativeId: codexId, lastProcessedSeq: 6 },
        ]);
        expect(Object.keys(selection.records)).toEqual(['claude-session', 'codex-session']);
    });

    it('aborts naming the provider record that carries an execution credential, without its value', async () => {
        const fixture = await machineFixture(root);
        const token = 'wmx_' + 'a'.repeat(40);
        await writeFile(fixture.codexRecord, JSON.stringify({ type: 'event', payload: { output: `token ${token}` } }) + '\n', { flag: 'a' });
        const failure = await select(fixture).catch((error: Error) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(fixture.codexRecord);
        expect((failure as Error).message).not.toContain(token);
    });

    it('aborts when a planned recovery record carries an execution credential', async () => {
        const fixture = await machineFixture(root);
        const stored = JSON.parse(await readFile(join(fixture.home, 'sessions.json'), 'utf8'));
        stored.sessions['claude-session'].agentEnvironment = { SOME_GRANT: 'wmx_' + 'b'.repeat(40) };
        await writeFile(join(fixture.home, 'sessions.json'), JSON.stringify(stored), { mode: 0o600 });
        await expect(select(fixture)).rejects.toThrow(join(fixture.home, 'sessions.json'));
    });

    // Reviewer scenario (High 1): the daemon wrote seq 10 and stopped; the session ran seq 12 within the
    // next 30 s and named its Claude conversation after that. The manifest carries what the session recorded.
    it('carries the cursor and provider conversation the session recorded when it stopped, not the daemon\'s older write', async () => {
        const fixture = await machineFixture(root);
        const stored = JSON.parse(await readFile(join(fixture.home, 'sessions.json'), 'utf8'));
        stored.sessions['claude-session'].lastProcessedSeq = 10;
        delete stored.sessions['claude-session'].metadata.claudeSessionId;
        await writeFile(join(fixture.home, 'sessions.json'), JSON.stringify(stored), { mode: 0o600 });
        fixture.stopped('claude-session', { lastProcessedSeq: 12, claudeSessionId: claudeId });

        const selection = await select(fixture);

        expect(selection.sessions[0]).toEqual({ sessionId: 'claude-session', provider: 'claude', nativeId: claudeId, lastProcessedSeq: 12 });
        expect(selection.records['claude-session']).toMatchObject({ lastProcessedSeq: 12, metadata: { claudeSessionId: claudeId } });
    });

    it('refuses a session whose process left no clean-stop record, and the dry run does not need one', async () => {
        const fixture = await machineFixture(root);
        await rm(workMachineSessionStopPath(fixture.home, 'codex-session'));

        await expect(select(fixture)).rejects.toThrow(/codex-session has no clean-stop record.*cancel the migration/i);
        await expect(select(fixture, { requireStopRecords: false })).resolves.toMatchObject({
            sessions: [expect.objectContaining({ lastProcessedSeq: 4 }), expect.objectContaining({ lastProcessedSeq: 6 })],
        });
    });

    it.each([
        ['a turn was still running', { turnInFlight: true }],
        ['an input never started while a later one did', { inputSkipped: true }],
    ])('refuses a session whose stop record shows %s', async (_label, fields) => {
        const fixture = await machineFixture(root);
        fixture.stopped('codex-session', { lastProcessedSeq: 6, codexThreadId: codexId, ...fields });

        await expect(select(fixture)).rejects.toThrow(/codex-session .*cancel the migration.*drain longer/i);
    });

    it('blocks the export naming every session on this machine the plan leaves out', async () => {
        const fixture = await machineFixture(root);
        const stored = JSON.parse(await readFile(join(fixture.home, 'sessions.json'), 'utf8'));
        stored.sessions['unplanned-b'] = stored.sessions['claude-session'];
        stored.sessions['unplanned-a'] = stored.sessions['codex-session'];
        await writeFile(join(fixture.home, 'sessions.json'), JSON.stringify(stored), { mode: 0o600 });

        const failure = await select(fixture).catch((error: Error) => error);
        expect((failure as Error).message).toContain('unplanned-a, unplanned-b');
        expect((failure as Error).message).not.toContain('other-session');
        await expect(select(fixture, { requireStopRecords: false })).rejects.toThrow('unplanned-a, unplanned-b');
    });

    it.each([
        ['an MCP Authorization header', 'headers: {"Authorization": "Bearer abcdefghijklmnop"}'],
        ['a signed caller grant', `${Buffer.from(JSON.stringify({ version: 2, userId: 'u', exp: 1 })).toString('base64url')}.${'f'.repeat(64)}`],
    ])('aborts when an env file in the project carries %s', async (_label, contents) => {
        const fixture = await machineFixture(root);
        await writeFile(join(fixture.project, '.env.local'), `MCP=${contents}\n`);
        await expect(select(fixture)).rejects.toThrow(join(fixture.project, '.env.local'));
    });

    it.each([
        ['a remote URL with a bare token', '.git/config', '[remote "origin"]\n\turl = https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y\n'],
        ['a credential helper', '.git/config', '[credential]\n\thelper = store --file /tmp/creds\n'],
        ['an extra header', '.git/config', '[http]\n\textraheader = AUTHORIZATION: basic eDp5\n'],
        ['a submodule credential helper', '.git/modules/lib/config', '[credential "https://example.invalid"]\n\thelper = !echo password=x\n'],
        ['a worktree extra header', '.git/worktrees/w1/config.worktree', '[http]\n\textraHeader = Authorization: Bearer abc\n'],
        ['an npm token', '.npmrc', '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnop\n'],
        ['a nested npm token', 'packages/app/.npmrc', '_auth=dXNlcjpwYXNz\n'],
        ['a private key file', 'deploy/id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n'],
        ['a PEM key', 'certs/server.key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n'],
    ])('aborts naming the file when the project carries %s, never its value', async (_label, relative, contents) => {
        const fixture = await machineFixture(root);
        await mkdir(join(fixture.project, relative, '..'), { recursive: true });
        await writeFile(join(fixture.project, relative), contents);

        const failure = await select(fixture).catch((error: Error) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(join(fixture.project, relative));
        for (const secret of ['ghp_abc', 'creds', 'eDp5', 'password=x', 'Bearer abc', 'npm_abc', 'dXNlcjpwYXNz', 'b3BlbnNzaC1', 'MIIEpAIB']) {
            expect((failure as Error).message).not.toContain(secret);
        }
    });

    it('keeps ordinary Git remotes, a public key and a plain .npmrc', async () => {
        const fixture = await machineFixture(root);
        await writeFile(join(fixture.project, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:x/y.git\n[remote "mirror"]\n\turl = https://git@example.invalid/x/y\n');
        await writeFile(join(fixture.project, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
        await writeFile(join(fixture.project, 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host\n');
        await expect(select(fixture)).resolves.toBeTruthy();
    });

    it('aborts when a Git remote embeds a login', async () => {
        const fixture = await machineFixture(root);
        await writeFile(join(fixture.project, '.git', 'config'), '[remote "origin"]\n\turl = https://user:ghp_secret@github.com/x/y\n');
        await expect(select(fixture)).rejects.toThrow(join(fixture.project, '.git', 'config'));
    });

    it('refuses a symlink that escapes the project tree but keeps one inside it', async () => {
        const fixture = await machineFixture(root);
        await symlink('tracked.txt', join(fixture.project, 'inside-link'));
        expect((await select(fixture)).entries).toContain(join(fixture.project, 'inside-link'));
        await symlink(fixture.home, join(fixture.project, 'escape-link'));
        await expect(select(fixture)).rejects.toThrow(join(fixture.project, 'escape-link'));
    });

    it('refuses a link that steps up through another link, which leaves the tree although its text stays inside', async () => {
        const fixture = await machineFixture(root);
        await mkdir(join(fixture.project, 'node_modules', '.bin'), { recursive: true });
        await symlink('../tool/cli.js', join(fixture.project, 'node_modules', '.bin', 'tool'));
        expect((await select(fixture)).entries).toContain(join(fixture.project, 'node_modules', '.bin', 'tool'));
        await mkdir(join(fixture.project, 'a', 'b'), { recursive: true });
        await symlink('../..', join(fixture.project, 'a', 'b', 'up'));
        // Lexically <project>/a/b, but a/b/up is the project itself, so this is its parent.
        await symlink('a/b/up/..', join(fixture.project, 'chained'));
        await expect(select(fixture)).rejects.toThrow(join(fixture.project, 'chained'));
    });

    it('refuses paths outside the plan', async () => {
        const fixture = await machineFixture(root);
        await expect(select(fixture, { projectPaths: ['relative/project'] })).rejects.toThrow();
        await expect(select(fixture, { projectPaths: [`${fixture.project}/../project`] })).rejects.toThrow();
        await expect(select(fixture, { projectPaths: [root] })).rejects.toThrow();
        await expect(select(fixture, { projectPaths: [join(root, 'workspace', 'other')] })).rejects.toThrow();
        await mkdir(join(root, 'workspace', 'other'));
        await expect(select(fixture, { projectPaths: [join(root, 'workspace', 'other')] })).rejects.toThrow('claude-session');
        await expect(select(fixture, { sessionIds: ['claude-session', 'codex-session', 'missing-session'] })).rejects.toThrow('missing-session');
    });

    it('extracts only entries under the declared roots and rejects anything else', async () => {
        const fixture = await machineFixture(root);
        await symlink(join(fixture.project, 'tracked.txt'), join(fixture.project, 'absolute-link'));
        const selection = await select(fixture);
        const recordsFile = join(root, 'records.json');
        await writeFile(recordsFile, JSON.stringify(selection.records));
        const archive = join(root, 'archive.tar');
        await pipeline(packWorkMachineArchive(selection, recordsFile), createWriteStream(archive));
        const staging = join(root, 'staging');
        const records = await extractWorkMachineArchive({ archivePath: archive, roots: selection.roots, staging });
        expect(Object.keys(records)).toEqual(['claude-session', 'codex-session']);
        expect(await readFile(join(staging, 'fs', fixture.project, 'tracked.txt'), 'utf8')).toBe('tracked\n');
        expect(await readlink(join(staging, 'fs', fixture.project, 'absolute-link'))).toBe(join(fixture.project, 'tracked.txt'));

        const evil = join(root, 'evil.tar');
        await mkdir(join(root, 'evil', 'happy'), { recursive: true });
        await writeFile(join(root, 'evil', 'happy', 'sessions.json'), '{}');
        await mkdir(join(root, 'evil', 'fs', 'elsewhere'), { recursive: true });
        await writeFile(join(root, 'evil', 'fs', 'elsewhere', 'payload'), 'x');
        await createTar({ cwd: join(root, 'evil'), file: evil, portable: true }, ['happy/sessions.json', 'fs/elsewhere/payload']);
        await expect(extractWorkMachineArchive({ archivePath: evil, roots: selection.roots, staging: join(root, 'staging-evil') }))
            .rejects.toThrow();

        const crafted = async (name: string, build: (dir: string) => Promise<Record<string, string>>) => {
            const tree = join(root, name);
            await mkdir(join(tree, 'happy'), { recursive: true });
            await writeFile(join(tree, 'happy', 'sessions.json'), '{}');
            const dir = join(tree, 'fs', fixture.project.slice(1));
            await mkdir(dir, { recursive: true });
            const renames = await build(dir);
            const file = join(root, `${name}.tar`);
            await createTar({
                cwd: tree, file, portable: true,
                onWriteEntry: entry => { entry.path = renames[entry.path] ?? entry.path; },
            }, ['happy/sessions.json', ...Object.keys(renames)]);
            return extractWorkMachineArchive({ archivePath: file, roots: selection.roots, staging: join(root, `staging-${name}`) });
        };
        const inTree = (dir: string, name: string) => `${dir.slice(root.length + 1).split('/').slice(1).join('/')}/${name}`;
        await expect(crafted('relative-escape', async dir => {
            await symlink('../../../../../../../../../../../../etc', join(dir, 'escape'));
            return { [inTree(dir, 'escape')]: inTree(dir, 'escape') };
        })).rejects.toThrow('outside the transfer manifest');
        // Each link reads as inside the root; the second steps up through the first, out of it.
        await expect(crafted('chained-link', async dir => {
            await mkdir(join(dir, 'a', 'b'), { recursive: true });
            await symlink('../..', join(dir, 'a', 'b', 'up'));
            await symlink('a/b/up/..', join(dir, 'chained'));
            return { [inTree(dir, 'a/b/up')]: inTree(dir, 'a/b/up'), [inTree(dir, 'chained')]: inTree(dir, 'chained') };
        })).rejects.toThrow('outside the transfer manifest');
        // A link that stays inside the root, then a file written through it.
        await expect(crafted('through-link', async dir => {
            await symlink(join(fixture.project, 'elsewhere'), join(dir, 'link'));
            await writeFile(join(dir, 'payload'), 'x');
            return { [inTree(dir, 'link')]: inTree(dir, 'link'), [inTree(dir, 'payload')]: inTree(dir, 'link/payload') };
        })).rejects.toThrow('outside the transfer manifest');
    });
});
