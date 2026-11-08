import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHookServer, type HookServer } from '../../src/claude/utils/startHookServer';

const GUARD_SCRIPT = join(__dirname, '..', 'tool_policy_file_guard.cjs');
const POLICY_FILE = '/Users/me/.happy/tool-policy.json';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { targetsPolicyFile, targetsProtectedDirectory } = require(GUARD_SCRIPT);

const ENV = { home: '/Users/me', happyHome: '/Users/me/.happy' };

function run(payload: unknown, policyFile = POLICY_FILE) {
    return spawnSync(process.execPath, [GUARD_SCRIPT, policyFile], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, HOME: '/Users/me', HAPPY_HOME_DIR: '' },
    });
}

const bash = (command: string, cwd = '/Users/me/project') => ({ tool_name: 'Bash', tool_input: { command }, cwd });

describe('tool_policy_file_guard', () => {
    it.each([
        { tool_name: 'Write', tool_input: { file_path: POLICY_FILE } },
        { tool_name: 'Edit', tool_input: { file_path: '../.happy/tool-policy.json' }, cwd: '/Users/me/project' },
        { tool_name: 'NotebookEdit', tool_input: { notebook_path: POLICY_FILE } },
        { tool_name: 'Bash', tool_input: { command: `echo '{}' > ${POLICY_FILE}` } },
        { tool_name: 'Bash', tool_input: { command: "sed -i '' s/blocked/allow/ ~/.happy/tool-policy.json" } },
    ])('blocks %j', (payload) => {
        expect(targetsPolicyFile(payload, POLICY_FILE, ENV)).toBe(true);
        const result = run(payload);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('도구 정책 파일');
    });

    it.each([
        { tool_name: 'Write', tool_input: { file_path: '/Users/me/project/tool-policy.json' } },
        { tool_name: 'Edit', tool_input: { file_path: '/Users/me/.happy/settings.json' } },
        { tool_name: 'Bash', tool_input: { command: 'ls ~/.happy' } },
    ])('allows %j', (payload) => {
        expect(run(payload).status).toBe(0);
    });

    // Cross review #1: compare normalized paths, not substrings.
    it.each([
        "printf '{}' > ~/.happy/tool-po*.json",
        'F=$HOME/.happy/tool-policy.json; echo x > "$F"',
        'cat > "${HOME}/.happy/tool-policy.json"',
        'cp /tmp/x $HAPPY_HOME_DIR/tool-policy.json',
        'D=~/.happy; F=tool-policy.json; echo x > $D/$F',
        'cd ~/.happy && vi tool-policy.json',
        "python3 -c 'open(\"/Users/me/.happy/tool-policy.json\",\"w\")'",
    ])('blocks the Bash command %s', (command) => {
        expect(targetsPolicyFile(bash(command), POLICY_FILE, ENV)).toBe(true);
        expect(run(bash(command)).status).toBe(2);
    });

    // Review bot (#909): macOS and Windows file systems ignore case by default.
    it('compares case-insensitively where the file system does', () => {
        const write = { tool_name: 'Write', tool_input: { file_path: '/Users/me/.happy/Tool-Policy.json' } };
        expect(targetsPolicyFile(write, POLICY_FILE, { ...ENV, caseInsensitive: true })).toBe(true);
        expect(targetsPolicyFile(bash('echo x > ~/.HAPPY/TOOL-POLICY.JSON'), POLICY_FILE, { ...ENV, caseInsensitive: true })).toBe(true);
        expect(targetsPolicyFile(write, POLICY_FILE, { ...ENV, caseInsensitive: false })).toBe(false);
    });

    it('blocks a relative name from inside the policy directory', () => {
        expect(targetsPolicyFile(bash('echo x > tool-policy.json', '/Users/me/.happy'), POLICY_FILE, ENV)).toBe(true);
        expect(targetsPolicyFile({ tool_name: 'Write', tool_input: { file_path: '~/.happy/tool-policy.json' } }, POLICY_FILE, ENV)).toBe(true);
    });

    it.each([
        'cat docs/tool-policy.json',
        'cat fixtures/tool-policy.json && ls',
        'vi /Users/me/project/tool-policy.json',
        'ls ~/.happy',
        'echo tool-policy',
    ])('lets %s through (same name elsewhere)', (command) => {
        expect(targetsPolicyFile(bash(command), POLICY_FILE, ENV)).toBe(false);
        expect(run(bash(command)).status).toBe(0);
    });

    it('never breaks a session on input it cannot read', () => {
        expect(run('not json').status).toBe(0);
        expect(run({ tool_name: 'Write', tool_input: { file_path: POLICY_FILE } }, '').status).toBe(0);
    });
});

// codexcli-org-requirements T15: the organization requirements cache is protected the same way.
describe('tool_policy_file_guard protected directories', () => {
    const ORG_DIR = '/Users/me/.happy/org-requirements';
    const runWithDir = (payload: unknown) => spawnSync(process.execPath, [GUARD_SCRIPT, POLICY_FILE, '--dir', ORG_DIR], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, HOME: '/Users/me', HAPPY_HOME_DIR: '' },
    });

    it.each([
        { tool_name: 'Write', tool_input: { file_path: `${ORG_DIR}/0123456789abcdef.json` } },
        { tool_name: 'Edit', tool_input: { file_path: '~/.happy/org-requirements/scope-1.json' } },
        bash('rm -rf ~/.happy/org-requirements'),
        bash('rm ~/.happy/org-requirements/*.json'),
        bash('cd ~/.happy && rm -r org-requirements'),
        bash('D=$HOME/.happy; rm -rf $D/org-requirements'),
    ])('blocks %j', (payload) => {
        expect(targetsProtectedDirectory(payload, ORG_DIR, ENV)).toBe(true);
        const result = runWithDir(payload);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('조직 정책');
    });

    it.each([
        bash('ls ~/.happy'),
        bash('cat ~/project/org-requirements/notes.md'),
        { tool_name: 'Write', tool_input: { file_path: '/Users/me/.happy/org-requirements-notes.md' } },
    ])('allows %j', (payload) => {
        expect(targetsProtectedDirectory(payload, ORG_DIR, ENV)).toBe(false);
        expect(runWithDir(payload).status).toBe(0);
    });

    it('treats a backslash as a separator too (Windows paths)', () => {
        expect(targetsProtectedDirectory({ tool_name: 'Write', tool_input: { file_path: `${ORG_DIR}\\0123.json` } }, ORG_DIR, ENV)).toBe(true);
    });

    it('still guards the policy file when directories are given', () => {
        expect(runWithDir({ tool_name: 'Write', tool_input: { file_path: POLICY_FILE } }).status).toBe(2);
    });
});

// aplus-dev-studio-desktop specs/skill-lock: the same hook process refuses writes into locked skills.
describe('tool_policy_file_guard --skill-locks', () => {
    let root: string;
    let home: string;
    let lockFile: string;
    let skill: string;

    beforeEach(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-skill-lock-')));
        home = join(root, 'home');
        skill = join(home, '.claude', 'skills', 'deep-research');
        mkdirSync(skill, { recursive: true });
        writeFileSync(join(skill, 'SKILL.md'), '# deep research');
        mkdirSync(join(home, '.happy'), { recursive: true });
        lockFile = join(home, '.happy', 'skill-locks.json');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function guard(payload: unknown, extra: string[] = []) {
        return new Promise<{ status: number | null; stderr: string }>((resolvePromise) => {
            const child = spawn(process.execPath, [GUARD_SCRIPT, join(home, '.happy', 'tool-policy.json'), '--skill-locks', lockFile, ...extra], {
                env: { ...process.env, HOME: home, HAPPY_HOME_DIR: '' },
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('close', (status) => resolvePromise({ status, stderr }));
            child.stdin.end(JSON.stringify(payload));
        });
    }
    const write = (file: string) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: home, permission_mode: 'bypassPermissions' });
    const shell = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: home, permission_mode: 'bypassPermissions' });

    it('refuses writes into a locked skill under bypassPermissions, and lets reads and other skills through', async () => {
        writeFileSync(lockFile, JSON.stringify({ version: 1, locked: [{ dir: skill, name: 'deep-research' }] }));
        const refused = await guard(write(join(skill, 'SKILL.md')));
        expect(refused.status).toBe(2);
        expect(refused.stderr).toContain("'deep-research' 스킬은 사용자가 잠가");
        expect((await guard(shell('echo x >> ~/.claude/skills/deep-research/SKILL.md'))).status).toBe(2);
        expect((await guard(shell('cat ~/.claude/skills/deep-research/SKILL.md'))).status).toBe(0);
        expect((await guard(write(join(home, '.claude', 'skills', 'other', 'SKILL.md')))).status).toBe(0);
    });

    it('refuses any command naming the lock file itself', async () => {
        writeFileSync(lockFile, JSON.stringify({ version: 1, locked: [] }));
        const result = await guard(shell(`echo '{"version":1,"locked":[]}' > ${lockFile}`));
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('스킬 잠금 설정 파일은 에이전트가 바꿀 수 없다');
        expect((await guard(write(lockFile))).status).toBe(2);
    });

    it('passes everything when there is no lock file', async () => {
        expect((await guard(write(join(skill, 'SKILL.md')))).status).toBe(0);
    });

    describe('a corrupt lock file (R4)', () => {
        let server: HookServer;
        let unattended = false;
        let secretFile: string;
        beforeEach(async () => {
            writeFileSync(lockFile, '{ not json');
            secretFile = join(root, 'secret');
            writeFileSync(secretFile, 'b'.repeat(64));
            server = await startHookServer({
                onSessionHook: () => {},
                preToolUse: { secret: 'b'.repeat(64), decide: async () => ({ kind: 'pass' }), unattended: () => unattended },
            });
        });
        afterEach(() => server.stop());

        it('locks every skill in an unattended turn and nothing in an attended one', async () => {
            unattended = true;
            const refused = await guard(write(join(skill, 'SKILL.md')), ['--hook', String(server.port), secretFile]);
            expect(refused.status).toBe(2);
            expect(refused.stderr).toContain('모든 스킬 폴더를 잠긴 것으로');
            expect((await guard(write(join(home, 'project', 'a.ts')), ['--hook', String(server.port), secretFile])).status).toBe(0);
            unattended = false;
            expect((await guard(write(join(skill, 'SKILL.md')), ['--hook', String(server.port), secretFile])).status).toBe(0);
        });

        it('treats an unanswered question as unattended', async () => {
            writeFileSync(secretFile, 'wrong');
            expect((await guard(write(join(skill, 'SKILL.md')), ['--hook', String(server.port), secretFile])).status).toBe(2);
            expect((await guard(write(join(skill, 'SKILL.md')))).status).toBe(2);
        });
    });
});
