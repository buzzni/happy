import { describe, it, expect, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const GUARD_SCRIPT = join(__dirname, '..', 'broad_kill_guard.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isBroadKillCommand, findKillHazard } = require(GUARD_SCRIPT);

describe('broad_kill_guard pattern matching', () => {
    it('blocks the exact command from the real incident', () => {
        expect(isBroadKillCommand('killall node 2>/dev/null; echo "Stopped background processes"')).toBe(true);
    });

    it.each([
        'killall node',
        'killall -9 node',
        'killall -- node',
        'killall Electron',
        'killall electron',
        'killall caffeinate',
        'killall node.exe',
        'sleep 1 && killall node',
        'echo done; killall node',
        'pkill node',
        'pkill -f node',
        'pkill -9 -f node',
        "pkill -f '^node$'",
        'pkill -f "node"',
        'pkill -f happy',
        'pkill electron',
        'npm test && pkill -f node',
    ])('blocks: %s', (command) => {
        expect(isBroadKillCommand(command)).toBe(true);
    });

    it.each([
        'pkill -f vitest',
        "pkill -f 'happy-server-runtime/happy-server serve'",
        'pkill -f "vite dev"',
        'pkill -f node_backup_script.sh',
        'kill 1234',
        'kill -9 1234',
        'killall Safari',
        'echo killall node is dangerous',   // no command position match
        'npm run dev',
        'ps aux | grep node',
        '',
    ])('allows: %s', (command) => {
        expect(isBroadKillCommand(command)).toBe(false);
    });

    it('handles non-string input', () => {
        expect(isBroadKillCommand(undefined)).toBe(false);
        expect(isBroadKillCommand(null)).toBe(false);
    });
});

// 2026-11-06: `pkill -f "vitest run" -U $(id -u)` — on macOS `-U` and the uid became extra patterns,
// `-U` matched `X-Aplus-User-Id` in every Claude child's argv, and idle sessions across the machine died.
describe('findKillHazard: pkill options after the pattern', () => {
    const noMatches = () => [];

    it.each([
        'pkill -f "vitest run" -U $(id -u) 2>/dev/null',
        "pkill -f 'vitest run' -9",
        'npm test; pkill -f vitest -u me',
        'cd /repo\npkill -f vitest -U 504',
        'pkill -f vitest \\\n  -U 504',
        'pkill -f vitest -- extra',
    ])('blocks: %s', (command) => {
        expect(findKillHazard(command, { listMatches: noMatches })).toMatch(/happy-guard.*before the pattern/s);
    });

    it.each([
        'pkill -U $(id -u) -f "vitest run"',
        'pkill -9 -f vitest 2>&1 | head',
        'pkill -f -- -U',
        'pkill -f vitest > /dev/null',
        'echo pkill -f a -U b',
        'pkill -f vitest # stop tests -U later',
        'pkill -f "`printf vitest | head -1`"',
    ])('allows: %s', (command) => {
        expect(findKillHazard(command, { listMatches: noMatches })).toBeNull();
    });
});

describe('findKillHazard: preview of what pkill would match', () => {
    it('blocks when a match is an agent runtime and names it', () => {
        const message = findKillHazard('pkill -f "vitest run"', {
            listMatches: () => [
                { pid: 2315, command: '/x/node_modules/@buzzni/happy-cli/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json' },
                { pid: 15137, command: '/bin/zsh -c npx vitest run src/a.test.ts' },
            ],
        });
        expect(message).toContain('2315');
        expect(message).not.toContain('15137');
    });

    it('allows when no match is an agent runtime', () => {
        expect(findKillHazard('pkill -f "vitest run"', { listMatches: () => [{ pid: 15137, command: '/bin/zsh -c npx vitest run' }] })).toBeNull();
    });

    it('previews with selection options only, widening past values it cannot expand', () => {
        const calls: string[][] = [];
        findKillHazard('pkill -9 -U $(id -u) -f "vitest run"', { listMatches: (args: string[]) => { calls.push(args); return []; } });
        expect(calls).toEqual([['-f', 'vitest run']]);
    });

    it('does not guess a pattern it cannot expand', () => {
        const listMatches = vi.fn(() => []);
        expect(findKillHazard('pkill -f "$PATTERN"', { listMatches })).toBeNull();
        expect(listMatches).not.toHaveBeenCalled();
    });

    it('previews a pkill on a later line and joins a continued line', () => {
        const calls: string[][] = [];
        const listMatches = (args: string[]) => { calls.push(args); return []; };
        findKillHazard('cd /repo\npkill -f vitest', { listMatches });
        findKillHazard('pkill -x \\\n  vitest', { listMatches });
        expect(calls).toEqual([['-f', 'vitest'], ['-x', 'vitest']]);
    });

    it('allows when the preview cannot run', () => {
        expect(findKillHazard('pkill -f vitest', { listMatches: () => null })).toBeNull();
    });
});

describe('broad_kill_guard hook process behavior', () => {
    function runGuard(payload: string): { status: number | null; stderr: string } {
        const result = spawnSync('node', [GUARD_SCRIPT], { input: payload, encoding: 'utf8' });
        return { status: result.status, stderr: result.stderr };
    }

    it('exits 2 with guidance on a broad kill', () => {
        const { status, stderr } = runGuard(JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'killall node 2>/dev/null; echo ok' }
        }));
        expect(status).toBe(2);
        expect(stderr).toContain('happy-guard');
        expect(stderr).toContain('kill <PID>');
        // A bare `pkill -f vitest` also stops other sessions' test runs, so it is no longer the advice.
        expect(stderr).not.toContain('pkill -f vitest');
    });

    it('exits 2 when an option follows the pattern', () => {
        const { status, stderr } = runGuard(JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'pkill -f "vitest run" -U 504 2>/dev/null' }
        }));
        expect(status).toBe(2);
        expect(stderr).toContain('-U');
    });

    it.skipIf(process.platform === 'win32')('exits 2 when the pattern matches a running agent process', async () => {
        const marker = `guard-test-${process.pid}-${Date.now()}`;
        // An argv that looks like an installed happy-cli runtime and carries a unique marker.
        const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `/opt/lib/node_modules/@buzzni/happy-cli/${marker}`], { stdio: 'ignore' });
        try {
            await new Promise(resolve => setTimeout(resolve, 300));
            const { status, stderr } = runGuard(JSON.stringify({
                tool_name: 'Bash',
                tool_input: { command: `pkill -f ${marker}` }
            }));
            expect(status).toBe(2);
            expect(stderr).toContain(String(fake.pid));
        } finally {
            fake.kill();
        }
    });

    it('exits 0 on a safe command', () => {
        const { status } = runGuard(JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'pkill -f happy-guard-test-no-such-process' }
        }));
        expect(status).toBe(0);
    });

    it('exits 0 on malformed payload (never breaks a session)', () => {
        expect(runGuard('not json').status).toBe(0);
        expect(runGuard('{}').status).toBe(0);
        expect(runGuard('').status).toBe(0);
    });
});
