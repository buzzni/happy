import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: sdkQuery,
}));

import { query } from './query';

describe('query adapter', () => {
    const originalPath = process.env.PATH;
    const originalExecutable = process.env.HAPPY_CLAUDE_PATH;
    const tempDirs: string[] = [];

    beforeEach(() => {
        sdkQuery.mockClear();
        delete process.env.HAPPY_CLAUDE_PATH;
    });

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalExecutable === undefined) delete process.env.HAPPY_CLAUDE_PATH;
        else process.env.HAPPY_CLAUDE_PATH = originalExecutable;
        for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
    });

    it('forwards prompt suggestion enablement to the Claude Agent SDK', () => {
        query({
            prompt: 'continue',
            options: { promptSuggestions: true },
        });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                promptSuggestions: true,
            }),
        }));
    });

    it('uses the machine-installed Claude executable from PATH', () => {
        const binDir = mkdtempSync(join(tmpdir(), 'happy-claude-path-'));
        tempDirs.push(binDir);
        const executable = join(binDir, 'claude');
        writeFileSync(executable, '#!/bin/sh\nexit 0\n');
        chmodSync(executable, 0o755);
        process.env.PATH = binDir;

        query({ prompt: 'continue' });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                pathToClaudeCodeExecutable: executable,
            }),
        }));
    });

    it('normalizes a relative PATH entry to an absolute Claude executable path', () => {
        const binDir = mkdtempSync(join(process.cwd(), 'happy-claude-relative-'));
        tempDirs.push(binDir);
        const executable = join(binDir, 'claude');
        writeFileSync(executable, '#!/bin/sh\nexit 0\n');
        chmodSync(executable, 0o755);
        process.env.PATH = relative(process.cwd(), binDir);

        query({ prompt: 'continue' });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                pathToClaudeCodeExecutable: executable,
            }),
        }));
    });

    it('keeps the SDK fallback when no machine Claude executable is available', () => {
        process.env.PATH = '';

        query({ prompt: 'continue' });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                pathToClaudeCodeExecutable: undefined,
            }),
        }));
    });

    it('rejects an invalid explicit Claude executable instead of silently using the SDK bundle', () => {
        process.env.HAPPY_CLAUDE_PATH = '/missing/happy-claude';

        expect(() => query({ prompt: 'continue' })).toThrow(
            'HAPPY_CLAUDE_PATH is not executable',
        );
        expect(sdkQuery).not.toHaveBeenCalled();
    });
});
