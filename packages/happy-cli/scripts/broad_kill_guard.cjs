#!/usr/bin/env node
/**
 * Broad Kill Guard
 *
 * PreToolUse hook for Claude Code Bash tool. Blocks broad process-kill
 * commands (`killall node`, `pkill -f node`, ...) that would take down the
 * happy daemon and every agent session on the machine — all of which run
 * on Node.js. A real incident: an agent ran `killall node` to clean up its
 * dev server and killed the daemon, every session, and itself.
 *
 * Reads the hook payload JSON from stdin. Exits 2 with a message on stderr
 * to block the tool call (the message is fed back to the agent), exits 0
 * to allow. Any parse/read failure exits 0 — this guard must never break
 * a session.
 *
 * Usage: echo '{"tool_name":"Bash","tool_input":{"command":"..."}}' | node broad_kill_guard.cjs
 */

// Process names that must never be pattern-killed: the agent runtime itself
// (node), the desktop app under development (electron), the happy CLI, and
// the daemon's sleep-prevention child.
const PROTECTED = '(?:node(?:\\.exe)?|electron|happy(?:-cli)?|caffeinate)';

// `killall [-flags ...] <protected>` — matches anywhere in a compound
// command (`a && killall node`, `killall node 2>/dev/null; echo ok`).
const KILLALL_RE = new RegExp(
    `(?:^|[;&|]|\\$\\()\\s*killall\\b(?:\\s+-\\S+)*\\s+(?:--\\s+)?['"]?${PROTECTED}['"]?(?=$|[\\s;&|)])`,
    'im'
);

// `pkill [-flags ...] <protected>` where the pattern is bare enough to match
// far more than the caller's own children (`pkill node`, `pkill -f '^node$'`).
// Narrow patterns like `pkill -f vitest` or `pkill -f 'happy-server serve'`
// are allowed — they are the recommended alternative.
const PKILL_RE = new RegExp(
    `(?:^|[;&|]|\\$\\()\\s*pkill\\b(?:\\s+-\\S+)*\\s+(?:--\\s+)?['"]?\\^?${PROTECTED}\\$?['"]?(?=$|[\\s;&|)])`,
    'im'
);

function isBroadKillCommand(command) {
    if (typeof command !== 'string' || command.length === 0) return false;
    return KILLALL_RE.test(command) || PKILL_RE.test(command);
}

const BLOCK_MESSAGE = [
    'happy-guard: this command is blocked because it would kill the happy daemon and every agent session on this machine (they all run on node).',
    'Clean up background processes narrowly instead:',
    '  - kill the specific PID you started (e.g. `npm run dev & echo $!` then `kill <PID>`)',
    '  - or use a narrow pattern (e.g. `pkill -f vitest`)',
    'Never use `killall node`, `pkill node`, or `pkill -f node`.'
].join('\n');

function main() {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
        let command;
        try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            command = payload && payload.tool_input && payload.tool_input.command;
        } catch {
            process.exit(0);
        }
        if (isBroadKillCommand(command)) {
            process.stderr.write(BLOCK_MESSAGE + '\n');
            process.exit(2);
        }
        process.exit(0);
    });
    process.stdin.resume();
}

module.exports = { isBroadKillCommand, BLOCK_MESSAGE };

if (require.main === module) {
    main();
}
