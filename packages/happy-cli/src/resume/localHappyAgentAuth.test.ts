import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hasLocalHappyAgentAuth, readLocalHappyAgentCredentials } from './localHappyAgentAuth';

const createdDirs: string[] = [];

function makeHomeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'happy-agent-auth-'));
    createdDirs.push(dir);
    return dir;
}

function writeCredentials(homeDir: string, fileName: string, token: string) {
    writeFileSync(
        join(homeDir, fileName),
        JSON.stringify({ token, secret: Buffer.alloc(32, 7).toString('base64') }),
    );
}

afterEach(() => {
    while (createdDirs.length > 0) {
        rmSync(createdDirs.pop()!, { recursive: true, force: true });
    }
});

describe('readLocalHappyAgentCredentials', () => {
    it('reads agent.key when happy-agent auth login was used', () => {
        const homeDir = makeHomeDir();
        writeCredentials(homeDir, 'agent.key', 'agent-token');

        expect(readLocalHappyAgentCredentials(homeDir)?.token).toBe('agent-token');
    });

    // A+ machines are provisioned without the interactive `happy-agent auth
    // login` QR flow, so agent.key never exists there. The daemon's own
    // access.key holds the same {token, secret} pair for the same account, and
    // upstream 8735f817 already established that resume must not require
    // agent.key.
    it('falls back to the daemon access.key when agent.key is absent', () => {
        const homeDir = makeHomeDir();
        writeCredentials(homeDir, 'access.key', 'daemon-token');

        expect(readLocalHappyAgentCredentials(homeDir)?.token).toBe('daemon-token');
    });

    it('prefers agent.key over access.key when both exist', () => {
        const homeDir = makeHomeDir();
        writeCredentials(homeDir, 'agent.key', 'agent-token');
        writeCredentials(homeDir, 'access.key', 'daemon-token');

        expect(readLocalHappyAgentCredentials(homeDir)?.token).toBe('agent-token');
    });

    it('falls back to access.key when agent.key is unreadable', () => {
        const homeDir = makeHomeDir();
        writeFileSync(join(homeDir, 'agent.key'), 'not json');
        writeCredentials(homeDir, 'access.key', 'daemon-token');

        expect(readLocalHappyAgentCredentials(homeDir)?.token).toBe('daemon-token');
    });

    it('returns null when neither credential file exists', () => {
        expect(readLocalHappyAgentCredentials(makeHomeDir())).toBeNull();
        expect(hasLocalHappyAgentAuth(makeHomeDir())).toBe(false);
    });
});
