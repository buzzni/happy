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
 * Directories passed with `--dir` are guarded the same way (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements T15: the organization requirements cache — deleting it while Studio is
 * unreachable would lift the organization's policy). A file tool aimed inside one, or a Bash command naming
 * a path inside one, is blocked.
 *
 * `--skill-locks <file>` adds skill locks (aplus-dev-studio-desktop specs/skill-lock): a write into a locked
 * skill's directory is blocked (skill_lock_guard.cjs decides), and so is any command naming the lock file itself.
 * A lock file that cannot be read locks every skill root in an unattended turn only (R4): the guard asks the
 * session's hook server (`--hook <port> <secret-file>`) whether this turn is unattended, and takes no answer as
 * unattended. Everything else about this guard stays best-effort.
 *
 * Usage: node tool_policy_file_guard.cjs <policy-file-path> [--dir <protected-directory>]...
 *        [--skill-locks <file>] [--hook <port> <secret-file>]
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { readSkillLocks, skillLockRefusal } = require('./skill_lock_guard.cjs');

const MESSAGE = '도구 정책으로 막힘: Saycode 도구 정책 파일은 에이전트가 바꿀 수 없다 — 정책은 Saycode 설정 화면에서 사용자가 바꾼다. 대신: 필요한 변경을 사용자에게 요청하라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

function defaultEnv(policyFile) {
    return {
        home: os.homedir(),
        happyHome: process.env.HAPPY_HOME_DIR || path.dirname(policyFile),
        // APFS and NTFS ignore case by default: `Tool-Policy.json` is the same file.
        caseInsensitive: process.platform === 'darwin' || process.platform === 'win32',
    };
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
    // Fold only resolved paths, never the command: `$HOME` must stay a variable name.
    const fold = env.caseInsensitive ? (value) => value.toLowerCase() : (value) => value;
    const file = fold(policyFile);
    const policyDir = path.dirname(file);
    const fileName = path.basename(file);
    if (payload.tool_name === 'Bash') {
        if (typeof input.command !== 'string') return false;
        // Quotes, operators, `=` and `,` separate words; what is left may be a path.
        const words = input.command.match(/[^\s;|&<>()`'"=,]+/g) || [];
        let namesDir = false;
        let namesFile = false;
        for (const word of words) {
            const resolved = fold(normalize(word, cwd, env));
            if (globMatches(resolved, file)) return true;
            if (globMatches(resolved.replace(/\/+$/, ''), policyDir)) namesDir = true;
            if (globMatches(fold(path.basename(word)), fileName)) namesFile = true;
        }
        return namesDir && namesFile;
    }
    const target = input.file_path || input.notebook_path;
    if (typeof target !== 'string' || target.length === 0) return false;
    return fold(normalize(target, cwd, env)) === file;
}

const DIRECTORY_MESSAGE = '도구 정책으로 막힘: Saycode 조직 정책 보관 폴더는 에이전트가 바꾸거나 지울 수 없다 — 조직 정책은 조직 관리자가 정한다. 대신: 필요한 변경을 사용자에게 요청하라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

function inside(resolved, dir) {
    // Both separators: `path.resolve` writes backslashes on Windows, and a command may use either.
    const trimmed = resolved.replace(/[\\/]+$/, '');
    return trimmed === dir || trimmed.startsWith(dir + '/') || trimmed.startsWith(dir + '\\') || globMatches(trimmed, dir);
}

function targetsProtectedDirectory(payload, protectedDir, env = defaultEnv(protectedDir)) {
    const input = (payload && payload.tool_input) || {};
    const cwd = payload.cwd || process.cwd();
    const fold = env.caseInsensitive ? (value) => value.toLowerCase() : (value) => value;
    const dir = fold(path.resolve(protectedDir)).replace(/[\\/]+$/, '');
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    if (payload.tool_name === 'Bash') {
        if (typeof input.command !== 'string') return false;
        const words = input.command.match(/[^\s;|&<>()`'"=,]+/g) || [];
        let namesParent = false;
        let namesBase = false;
        for (const word of words) {
            const resolved = fold(normalize(word, cwd, env));
            if (inside(resolved, dir)) return true;
            if (globMatches(resolved.replace(/[\\/]+$/, ''), parent)) namesParent = true;
            if (globMatches(fold(path.basename(word)), base)) namesBase = true;
        }
        return namesParent && namesBase;
    }
    const target = input.file_path || input.notebook_path;
    if (typeof target !== 'string' || target.length === 0) return false;
    return inside(fold(normalize(target, cwd, env)), dir);
}

const SKILL_LOCK_FILE_MESSAGE = '스킬 잠금으로 막힘: 스킬 잠금 설정 파일은 에이전트가 바꿀 수 없다 — 잠금은 Saycode 설정 화면에서 사용자가 바꾼다. 대신: 필요한 변경을 사용자에게 요청하라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

const ATTENDANCE_TIMEOUT_MS = 3000;

/** Whether the session's current turn is unattended; any failure to learn it counts as unattended (fail closed). */
function askUnattended(hook) {
    return new Promise((resolve) => {
        let secret;
        try {
            secret = fs.readFileSync(hook.secretFile, 'utf8').trim();
        } catch {
            return resolve(true);
        }
        const request = http.request({
            host: '127.0.0.1', port: Number(hook.port), path: '/hook/attendance', method: 'POST',
            headers: { 'content-type': 'application/json', 'x-happy-hook-secret': secret },
            timeout: ATTENDANCE_TIMEOUT_MS,
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    resolve(response.statusCode !== 200 || body.unattended !== false);
                } catch {
                    resolve(true);
                }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(true));
        request.end('{}');
    });
}

function parseArgs(argv) {
    const options = { policyFile: argv[2], dirs: [], skillLocks: null, hook: null };
    for (let i = 3; i < argv.length; i++) {
        if (argv[i] === '--dir' && i + 1 < argv.length) options.dirs.push(argv[++i]);
        else if (argv[i] === '--skill-locks' && i + 1 < argv.length) options.skillLocks = argv[++i];
        else if (argv[i] === '--hook' && i + 2 < argv.length) options.hook = { port: argv[++i], secretFile: argv[++i] };
    }
    return options;
}

/** The block reason for this payload, or null. Rejects only where the attendance check itself is needed and fails. */
async function decide(payload, options, env = { home: os.homedir(), vars: process.env, caseInsensitive: process.platform === 'darwin' || process.platform === 'win32' }) {
    if (options.policyFile && targetsPolicyFile(payload, path.resolve(options.policyFile))) return MESSAGE;
    if (options.dirs.some((dir) => dir && targetsProtectedDirectory(payload, path.resolve(dir)))) return DIRECTORY_MESSAGE;
    if (!options.skillLocks) return null;
    const lockFile = path.resolve(options.skillLocks);
    if (targetsPolicyFile(payload, lockFile)) return SKILL_LOCK_FILE_MESSAGE;
    const locks = readSkillLocks(lockFile);
    if (locks.kind === 'ok') return skillLockRefusal(payload, { dirs: locks.dirs }, env);
    if (locks.kind !== 'corrupt') return null;
    // Only a call that would touch a skill pays for the question.
    const refusal = skillLockRefusal(payload, { allSkills: true }, env);
    if (!refusal) return null;
    return (!options.hook || await askUnattended(options.hook)) ? refusal : null;
}

function main() {
    const options = parseArgs(process.argv);
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
        let payload;
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            process.exit(0);
        }
        decide(payload, options).then((reason) => {
            if (reason) {
                process.stderr.write(reason + '\n', () => process.exit(2));
                return;
            }
            process.exit(0);
        }, () => process.exit(0));
    });
    process.stdin.resume();
}

module.exports = { targetsPolicyFile, targetsProtectedDirectory, decide, parseArgs };

if (require.main === module) {
    main();
}
