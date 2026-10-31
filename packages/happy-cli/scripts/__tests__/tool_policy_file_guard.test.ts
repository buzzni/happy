import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

    it('still guards the policy file when directories are given', () => {
        expect(runWithDir({ tool_name: 'Write', tool_input: { file_path: POLICY_FILE } }).status).toBe(2);
    });
});
