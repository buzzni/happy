#!/usr/bin/env node
/**
 * Tool Policy File Guard
 *
 * PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit/Bash (aplus-dev-studio
 * specs/agent-tool-policy, 제약 "보안"). The local tool policy file is written by Saycode Desktop;
 * an agent that edits it could loosen its own rules. This blocks file tools aimed at that path
 * and Bash commands that mention the file.
 *
 * Best-effort, not a security boundary: an agent running shell commands as the same OS user can
 * still reach the file other ways. Any read/parse failure exits 0 — this guard must never break a
 * session — which is the opposite of policy_hook_forwarder.cjs on purpose.
 *
 * Usage: node tool_policy_file_guard.cjs <policy-file-path>
 */

const path = require('path');

const MESSAGE = '도구 정책으로 막힘: Saycode 도구 정책 파일은 에이전트가 바꿀 수 없다 — 정책은 Saycode 설정 화면에서 사용자가 바꾼다. 대신: 필요한 변경을 사용자에게 요청하라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

function targetsPolicyFile(payload, policyFile) {
    const input = (payload && payload.tool_input) || {};
    const fileName = path.basename(policyFile);
    if (payload.tool_name === 'Bash') {
        return typeof input.command === 'string' && (input.command.includes(policyFile) || input.command.includes(fileName));
    }
    const target = input.file_path || input.notebook_path;
    if (typeof target !== 'string' || target.length === 0) return false;
    const resolved = path.resolve(payload.cwd || process.cwd(), target);
    return resolved === policyFile || (path.basename(resolved) === fileName && path.dirname(resolved) === path.dirname(policyFile));
}

function main() {
    const policyFile = process.argv[2];
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
        try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (policyFile && targetsPolicyFile(payload, path.resolve(policyFile))) {
                process.stderr.write(MESSAGE + '\n');
                process.exit(2);
            }
        } catch {
            // fall through
        }
        process.exit(0);
    });
    process.stdin.resume();
}

module.exports = { targetsPolicyFile };

if (require.main === module) {
    main();
}
