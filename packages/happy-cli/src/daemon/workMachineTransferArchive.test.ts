import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectPath } from '@/claude/utils/path';
import { extractWorkMachineArchive, packWorkMachineArchive, selectWorkMachineTransfer } from './workMachineTransferArchive';

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
    const sessions = {
        'claude-session': record('claudeSessionId', claudeId, 4),
        'codex-session': record('codexThreadId', codexId, 6),
        'other-session': record('claudeSessionId', '99999999-2222-4333-8444-555555555555', 1),
    };
    await writeFile(join(home, 'sessions.json'), JSON.stringify({ sessions }), { mode: 0o600 });
    return { home, claudeConfigDir, codexHome, project, claudeRecord, codexRecord };
}

describe('work machine transfer archive selection', () => {
    let root: string;
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'work-machine-archive-test-')); });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    const select = (fixture: Awaited<ReturnType<typeof machineFixture>>, overrides: { projectPaths?: string[]; sessionIds?: string[] } = {}) =>
        selectWorkMachineTransfer({
            happyHome: fixture.home, claudeConfigDir: fixture.claudeConfigDir, codexHome: fixture.codexHome,
            projectPaths: overrides.projectPaths ?? [fixture.project],
            sessionIds: overrides.sessionIds ?? ['claude-session', 'codex-session'],
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
        await expect(select(fixture, { sessionIds: ['codex-session'] })).resolves.toBeTruthy();
    });

    it.each([
        ['an MCP Authorization header', 'headers: {"Authorization": "Bearer abcdefghijklmnop"}'],
        ['a signed caller grant', `${Buffer.from(JSON.stringify({ version: 2, userId: 'u', exp: 1 })).toString('base64url')}.${'f'.repeat(64)}`],
    ])('aborts when an env file in the project carries %s', async (_label, contents) => {
        const fixture = await machineFixture(root);
        await writeFile(join(fixture.project, '.env.local'), `MCP=${contents}\n`);
        await expect(select(fixture)).rejects.toThrow(join(fixture.project, '.env.local'));
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

    it('refuses paths outside the plan', async () => {
        const fixture = await machineFixture(root);
        await expect(select(fixture, { projectPaths: ['relative/project'] })).rejects.toThrow();
        await expect(select(fixture, { projectPaths: [`${fixture.project}/../project`] })).rejects.toThrow();
        await expect(select(fixture, { projectPaths: [root] })).rejects.toThrow();
        await expect(select(fixture, { projectPaths: [join(root, 'workspace', 'other')] })).rejects.toThrow();
        await mkdir(join(root, 'workspace', 'other'));
        await expect(select(fixture, { projectPaths: [join(root, 'workspace', 'other')] })).rejects.toThrow('claude-session');
        await expect(select(fixture, { sessionIds: ['missing-session'] })).rejects.toThrow('missing-session');
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
        // A link that stays inside the root, then a file written through it.
        await expect(crafted('through-link', async dir => {
            await symlink(join(fixture.project, 'elsewhere'), join(dir, 'link'));
            await writeFile(join(dir, 'payload'), 'x');
            return { [inTree(dir, 'link')]: inTree(dir, 'link'), [inTree(dir, 'payload')]: inTree(dir, 'link/payload') };
        })).rejects.toThrow('outside the transfer manifest');
    });
});
