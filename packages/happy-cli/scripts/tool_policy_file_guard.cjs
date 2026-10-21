#!/usr/bin/env node
/**
 * Tool Policy File Guard
 *
 * PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit/Bash (aplus-dev-studio
 * specs/agent-tool-policy, 제약 "보안"). The local tool policy file is written by Saycode Desktop;
 * an agent that edits it could loosen its own rules. This blocks file tools aimed at that path
 * and Bash commands that name it.
 *
 * Paths are compared after normalizing (`~`, `$HOME`, `$HAPPY_HOME_DIR` expanded, relative paths
 * resolved against the hook's cwd, globs matched), so the same file name in another directory
 * passes. A Bash command is also blocked when it names the policy directory and, anywhere else,
 * the file name (`D=~/.happy; F=tool-policy.json; … $D/$F`, `cd ~/.happy && vi tool-policy.json`).
 *
 * Best-effort, not a security boundary: an agent running shell commands as the same OS user can
 * still reach the file other ways (a quoted path with spaces, a name built from parts). Any
 * read/parse failure exits 0 — this guard must never break a session — which is the opposite of
 * policy_hook_forwarder.cjs on purpose.
 *
 * Usage: node tool_policy_file_guard.cjs <policy-file-path>
 */

const os = require('os');
const path = require('path');

const MESSAGE = '도구 정책으로 막힘: Saycode 도구 정책 파일은 에이전트가 바꿀 수 없다 — 정책은 Saycode 설정 화면에서 사용자가 바꾼다. 대신: 필요한 변경을 사용자에게 요청하라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

function defaultEnv(policyFile) {
    return { home: os.homedir(), happyHome: process.env.HAPPY_HOME_DIR || path.dirname(policyFile) };
}

/** `~`, `$HOME`, `${HOME}`, `$HAPPY_HOME_DIR`, `${HAPPY_HOME_DIR}` → absolute, then resolved against cwd. */
function normalize(token, cwd, env) {
    const expanded = token
        .replace(/^~(?=$|\/)/, env.home)
        .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, env.home)
        .replace(/\$\{HAPPY_HOME_DIR\}|\$HAPPY_HOME_DIR(?![A-Za-z0-9_])/g, env.happyHome);
    return path.resolve(cwd, expanded);
}

function globMatches(pattern, value) {
    if (!/[*?[]/.test(pattern)) return pattern === value;
    const source = pattern.split('').map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch === '[' || ch === ']' ? ch : ch.replace(/[.+^${}()|\\]/g, '\\$&'))).join('');
    try {
        return new RegExp(`^${source}$`).test(value);
    } catch {
        return false;
    }
}

function targetsPolicyFile(payload, policyFile, env = defaultEnv(policyFile)) {
    const input = (payload && payload.tool_input) || {};
    const cwd = payload.cwd || process.cwd();
    const policyDir = path.dirname(policyFile);
    const fileName = path.basename(policyFile);
    if (payload.tool_name === 'Bash') {
        if (typeof input.command !== 'string') return false;
        // Quotes, operators, `=` and `,` separate words; what is left may be a path.
        const words = input.command.match(/[^\s;|&<>()`'"=,]+/g) || [];
        let namesDir = false;
        let namesFile = false;
        for (const word of words) {
            const resolved = normalize(word, cwd, env);
            if (globMatches(resolved, policyFile)) return true;
            if (globMatches(resolved.replace(/\/+$/, ''), policyDir)) namesDir = true;
            if (globMatches(path.basename(word), fileName)) namesFile = true;
        }
        return namesDir && namesFile;
    }
    const target = input.file_path || input.notebook_path;
    if (typeof target !== 'string' || target.length === 0) return false;
    return normalize(target, cwd, env) === policyFile;
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
