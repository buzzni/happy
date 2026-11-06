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
 * Any other `pkill` is checked before it runs: options after the pattern
 * are blocked (macOS reads them as more patterns), and a pgrep preview
 * blocks a pattern that would match agent processes. Claude Code's Bash
 * shell puts /usr/bin ahead of the broad-kill PATH shims, so this hook is
 * the guard that applies there.
 *
 * Reads the hook payload JSON from stdin. Exits 2 with a message on stderr
 * to block the tool call (the message is fed back to the agent), exits 0
 * to allow. Any parse/read failure exits 0 — this guard must never break
 * a session.
 *
 * Usage: echo '{"tool_name":"Bash","tool_input":{"command":"..."}}' | node broad_kill_guard.cjs
 */

const { spawnSync } = require('node:child_process');

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
// Other patterns are not blocked by name; findKillHazard previews what they
// would match.
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
    '  - or use a pattern only your own processes match, options first (e.g. `pkill -U "$(id -u)" -f "<your worktree>/node_modules/.bin/vitest"`)',
    'Never use `killall node`, `pkill node`, or `pkill -f node`.'
].join('\n');

// pkill/pgrep options (BSD and procps) that take the next word as their value.
const VALUE_OPTIONS = new Set(['-F', '-G', '-M', '-N', '-P', '-U', '-g', '-j', '-s', '-t', '-u', '--signal',
    '--uid', '--euid', '--group', '--pgroup', '--parent', '--session', '--terminal', '--pidfile', '--ns', '--nslist',
    '--runstates', '--env', '--cgroup']);
// pkill-only options that pick the signal or the output, not the processes; left out of the pgrep preview.
const NON_SELECTING_OPTION = /^-(?:\d+|[A-Z][A-Z0-9]+|e|I|l|q|c|-echo|-count|-signal=.*)$/;
const PREFIX_WORDS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env']);

// Command lines of the agent runtime: the installed happy CLI (daemon, sessions, MCP proxies), the Claude
// Code child it drives, and the Codex app server.
const AGENT_PROCESS_RE = /@buzzni\/happy-cli\/|happy-coder\/|claude-agent-sdk|@anthropic-ai\/claude-code\/|--output-format[= ]stream-json|\bcodex\b.*\bapp-server\b/;

/**
 * Splits a shell command into simple commands of words. Enough of sh to find pkill's arguments: quotes,
 * escapes, `;`/`&`/`|`/newline/parentheses, redirections (dropped), and expansions (`$…`, `` `…` ``),
 * which mark a word `dynamic` because its value is only known when the shell runs it.
 */
function commandSegments(command) {
    const segments = [[]];
    let word = null;
    let dropNextWord = false;
    const start = () => { if (word === null) word = { text: '', dynamic: false }; };
    const finish = () => {
        if (word === null) return;
        if (dropNextWord) dropNextWord = false;
        else segments[segments.length - 1].push(word);
        word = null;
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (c === '\\') {
            // A backslash-newline continues the line; any other escaped character is literal.
            if (command[i + 1] !== '\n') { start(); word.text += command[i + 1] ?? ''; }
            i++;
            continue;
        }
        if (c === '#' && word === null) {
            while (i + 1 < command.length && command[i + 1] !== '\n') i++;
            continue;
        }
        if (c === "'") {
            start();
            const end = command.indexOf("'", i + 1);
            const stop = end === -1 ? command.length : end;
            word.text += command.slice(i + 1, stop);
            i = stop;
            continue;
        }
        if (c === '"') {
            start();
            let j = i + 1;
            for (; j < command.length && command[j] !== '"'; j++) {
                if (command[j] === '\\') { word.text += command[j + 1] ?? ''; j++; continue; }
                if (command[j] === '$' || command[j] === '`') word.dynamic = true;
                word.text += command[j];
            }
            i = j;
            continue;
        }
        if (c === '$' && command[i + 1] === '(') {
            start();
            word.dynamic = true;
            let depth = 0;
            let j = i + 1;
            for (; j < command.length; j++) {
                if (command[j] === '(') depth++;
                else if (command[j] === ')' && --depth === 0) break;
            }
            word.text += command.slice(i, j + 1);
            i = j;
            continue;
        }
        if (c === '`') {
            start();
            word.dynamic = true;
            const end = command.indexOf('`', i + 1);
            const stop = end === -1 ? command.length : end;
            word.text += command.slice(i, stop + 1);
            i = stop;
            continue;
        }
        if (c === '$') { start(); word.dynamic = true; word.text += c; continue; }
        if (c === '>' || c === '<') {
            if (word !== null && /^\d*$/.test(word.text)) word = null;
            else finish();
            let j = i + 1;
            if (command[j] === c) j++;
            if (command[j] === '&') {
                j++;
                while (/[\d-]/.test(command[j] ?? '')) j++;
            } else {
                dropNextWord = true;
            }
            i = j - 1;
            continue;
        }
        if (c !== '\n' && /\s/.test(c)) { finish(); continue; }
        if (';&|()\n'.includes(c)) {
            finish();
            if (segments[segments.length - 1].length > 0) segments.push([]);
            continue;
        }
        start();
        word.text += c;
    }
    finish();
    return segments.filter(words => words.length > 0);
}

function pkillArguments(command) {
    return commandSegments(command).flatMap(words => {
        let i = 0;
        while (i < words.length && (PREFIX_WORDS.has(words[i].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text))) i++;
        return words[i] && !words[i].dynamic && /(?:^|\/)pkill$/.test(words[i].text) ? [words.slice(i + 1)] : [];
    });
}

const isOption = text => text.length > 1 && text.startsWith('-');

// BSD getopt (macOS) stops at the first pattern, so later options become more patterns.
function optionAfterPattern(args) {
    let seenPattern = false;
    for (let i = 0; i < args.length; i++) {
        const text = args[i].text;
        // `--` ends the options only before the pattern; after it, it is one more pattern.
        if (text === '--' && !seenPattern) return null;
        if (seenPattern) {
            if (isOption(text)) return text;
        } else if (!isOption(text)) {
            seenPattern = true;
        } else if (VALUE_OPTIONS.has(text)) {
            i++;
        }
    }
    return null;
}

/**
 * The pgrep arguments that select what this pkill would. A filter whose value is an expansion is
 * dropped, which can only widen the preview; an expanded pattern or flag cannot be previewed (null).
 */
function previewArguments(args) {
    const probe = [];
    for (let i = 0; i < args.length; i++) {
        const { text, dynamic } = args[i];
        if (text === '--') {
            const patterns = args.slice(i + 1);
            if (patterns.some(pattern => pattern.dynamic)) return null;
            return [...probe, '--', ...patterns.map(pattern => pattern.text)];
        }
        if (!isOption(text)) {
            if (dynamic) return null;
            probe.push(text);
            continue;
        }
        if (VALUE_OPTIONS.has(text)) {
            const value = args[++i];
            if (value && !value.dynamic && text !== '--signal') probe.push(text, value.text);
            continue;
        }
        if (VALUE_OPTIONS.has(text.slice(0, 2))) {
            if (!dynamic) probe.push(text);
            continue;
        }
        if (dynamic) return null;
        if (!NON_SELECTING_OPTION.test(text)) probe.push(text);
    }
    return probe;
}

/** What `pgrep <probe>` matches right now, with each command line; null when it cannot tell. */
function listMatches(probe) {
    if (process.platform === 'win32') return null;
    const found = spawnSync('pgrep', probe, { encoding: 'utf8', timeout: 2000 });
    if (found.status === 1) return [];
    if (found.status !== 0) return null;
    const pids = found.stdout.split('\n').map(line => line.trim()).filter(pid => /^\d+$/.test(pid) && Number(pid) !== process.pid);
    if (pids.length === 0) return [];
    const listed = spawnSync('ps', ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000 });
    if (typeof listed.stdout !== 'string') return null;
    return listed.stdout.split('\n')
        .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter(Boolean)
        .map(match => ({ pid: Number(match[1]), command: match[2] }));
}

function optionAfterPatternMessage(option) {
    return [
        `happy-guard: this pkill is blocked because \`${option}\` comes after the pattern. On macOS an option after the pattern is read as another pattern, which can match and stop unrelated processes, including other agent sessions.`,
        'Put every option before the pattern, e.g. `pkill -U "$(id -u)" -f \'<pattern>\'`.',
    ].join('\n');
}

function agentMatchMessage(agents) {
    return [
        `happy-guard: this pkill is blocked because it would also stop agent processes on this machine (PID ${agents.map(agent => agent.pid).join(', ')}), ending other conversations.`,
        'Kill only the PID you started (`kill <PID>`), or narrow the pattern to your own processes (for example include your worktree path).',
    ].join('\n');
}

/** Why this Bash command must not run, or null. Never throws: a guard failure must not break a session. */
function findKillHazard(command, deps = { listMatches }) {
    try {
        if (isBroadKillCommand(command)) return BLOCK_MESSAGE;
        if (typeof command !== 'string') return null;
        const invocations = pkillArguments(command);
        for (const args of invocations) {
            const option = optionAfterPattern(args);
            if (option) return optionAfterPatternMessage(option);
        }
        for (const args of invocations) {
            const probe = previewArguments(args);
            if (!probe) continue;
            const agents = (deps.listMatches(probe) ?? []).filter(match => AGENT_PROCESS_RE.test(match.command));
            if (agents.length > 0) return agentMatchMessage(agents);
        }
        return null;
    } catch {
        return null;
    }
}

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
        const hazard = findKillHazard(command);
        if (hazard) {
            process.stderr.write(hazard + '\n');
            process.exit(2);
        }
        process.exit(0);
    });
    process.stdin.resume();
}

module.exports = { isBroadKillCommand, findKillHazard, BLOCK_MESSAGE };

if (require.main === module) {
    main();
}
