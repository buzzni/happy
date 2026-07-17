import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const GUARD_SCRIPT = join(__dirname, '..', 'broad_kill_guard.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isBroadKillCommand } = require(GUARD_SCRIPT);

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
        expect(stderr).toContain('pkill -f vitest');
    });

    it('exits 0 on a safe command', () => {
        const { status } = runGuard(JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'pkill -f vitest' }
        }));
        expect(status).toBe(0);
    });

    it('exits 0 on malformed payload (never breaks a session)', () => {
        expect(runGuard('not json').status).toBe(0);
        expect(runGuard('{}').status).toBe(0);
        expect(runGuard('').status).toBe(0);
    });
});
