#!/usr/bin/env node
/**
 * Tool Policy Hook Forwarder
 *
 * Claude PreToolUse hook for `mcp__*` tools (aplus-dev-studio specs/agent-tool-policy). Forwards
 * the hook payload to the session's hook server, which decides `allow | ask | blocked` and, for
 * `ask`, holds the response until a person answers in Saycode.
 *
 * Fail closed. Claude Code treats a hook that crashes or times out as a non-blocking error and runs
 * the tool anyway, and the Claude build Happy pins ignores `onFailure: "block"` (measured
 * 2026-10-22, specs/agent-tool-policy/context.md). So every path out of this script that is not
 * an explicit verdict is `deny` + exit 2 — including our own deadline, which stays below the hook
 * `timeout` so Claude never reaches its own.
 *
 * Usage: node policy_hook_forwarder.cjs <port> <secret-file> [deadline-ms]
 */

const http = require('http');
const fs = require('fs');

const SECRET_HEADER = 'x-happy-hook-secret';
// Hook `timeout` is 1900 s; the approval wait is 1800 s. This sits between them.
const DEFAULT_DEADLINE_MS = 1850 * 1000;
const NO_BYPASS = '이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

let finished = false;

function failClosed(why) {
    if (finished) return;
    finished = true;
    const reason = `도구 정책으로 막힘: 정책 확인을 끝내지 못해 이 호출을 실행하지 않았다 (${why}). 대신: 잠시 뒤 다시 시도하거나 사용자에게 알려라. ${NO_BYPASS}`;
    try {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
        process.stderr.write(reason + '\n');
    } finally {
        process.exit(2);
    }
}

/** Exits only after stdout has flushed: pipes are asynchronous on macOS, and a lost deny is a pass. */
function emit(decision, reason) {
    finished = true;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }), () => process.exit(0));
}

function respond(verdict) {
    if (finished) return;
    if (verdict && verdict.kind === 'pass') {
        finished = true;
        return process.exit(0);
    }
    if (verdict && verdict.kind === 'allow') return emit('allow', 'Saycode에서 사용자가 승인했다.');
    if (verdict && verdict.kind === 'deny' && typeof verdict.reason === 'string') return emit('deny', verdict.reason);
    failClosed('unknown verdict');
}

function main() {
    process.on('uncaughtException', (error) => failClosed(`hook error: ${error && error.message}`));
    // The event loop drained without a verdict (the deadline timer is unref'd): a silent exit 0 is a pass.
    process.on('beforeExit', () => failClosed('no decision'));
    const port = parseInt(process.argv[2], 10);
    const secretFile = process.argv[3];
    const deadlineMs = parseInt(process.argv[4], 10) || DEFAULT_DEADLINE_MS;
    setTimeout(() => failClosed('timed out waiting for a decision'), deadlineMs).unref();
    if (!port || !secretFile) return failClosed('missing hook arguments');

    let secret;
    try {
        secret = fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
        return failClosed('hook secret unavailable');
    }

    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('error', () => failClosed('stdin error'));
    process.stdin.on('end', () => {
        const body = Buffer.concat(chunks);
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/hook/pre-tool-use',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, [SECRET_HEADER]: secret },
        }, (res) => {
            const parts = [];
            res.on('data', (part) => parts.push(part));
            res.on('error', () => failClosed('response error'));
            res.on('end', () => {
                if (res.statusCode !== 200) return failClosed(`policy server answered ${res.statusCode}`);
                let verdict;
                try {
                    verdict = JSON.parse(Buffer.concat(parts).toString('utf8'));
                } catch {
                    return failClosed('unreadable verdict');
                }
                respond(verdict);
            });
        });
        req.on('error', (error) => failClosed(`policy server unreachable: ${error.code || error.message}`));
        req.end(body);
    });
    process.stdin.resume();
}

if (require.main === module) {
    main();
}
