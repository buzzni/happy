import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const GUARD_SCRIPT = join(__dirname, '..', 'tool_policy_file_guard.cjs');
const POLICY_FILE = '/Users/me/.happy/tool-policy.json';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { targetsPolicyFile } = require(GUARD_SCRIPT);

function run(payload: unknown, policyFile = POLICY_FILE) {
    return spawnSync(process.execPath, [GUARD_SCRIPT, policyFile], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });
}

describe('tool_policy_file_guard', () => {
    it.each([
        { tool_name: 'Write', tool_input: { file_path: POLICY_FILE } },
        { tool_name: 'Edit', tool_input: { file_path: '../.happy/tool-policy.json' }, cwd: '/Users/me/project' },
        { tool_name: 'NotebookEdit', tool_input: { notebook_path: POLICY_FILE } },
        { tool_name: 'Bash', tool_input: { command: `echo '{}' > ${POLICY_FILE}` } },
        { tool_name: 'Bash', tool_input: { command: "sed -i '' s/blocked/allow/ ~/.happy/tool-policy.json" } },
    ])('blocks %j', (payload) => {
        expect(targetsPolicyFile(payload, POLICY_FILE)).toBe(true);
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

    it('never breaks a session on input it cannot read', () => {
        expect(run('not json').status).toBe(0);
        expect(run({ tool_name: 'Write', tool_input: { file_path: POLICY_FILE } }, '').status).toBe(0);
    });
});
