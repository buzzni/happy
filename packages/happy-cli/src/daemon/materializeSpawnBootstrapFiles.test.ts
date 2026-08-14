import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeSpawnBootstrapFiles } from './materializeSpawnBootstrapFiles';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'spawn-bootstrap-files-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('materializeSpawnBootstrapFiles', () => {
    it('creates the managed root and .aplus agent files', async () => {
        await materializeSpawnBootstrapFiles(workspace, [
            { relativePath: 'AGENTS.md', content: '# Project Agent Instructions\n' },
            {
                relativePath: '.aplus/agent/project-template.md',
                content: '# A+ Project Template\n',
            },
            {
                relativePath: '.aplus/agent/common-base.md',
                content: '# A+ Common Base Fallback\n',
            },
        ]);

        expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
            .toBe('# Project Agent Instructions\n');
        expect(await readFile(
            join(workspace, '.aplus', 'agent', 'project-template.md'),
            'utf8',
        )).toBe('# A+ Project Template\n');
        expect(await readFile(
            join(workspace, '.aplus', 'agent', 'common-base.md'),
            'utf8',
        )).toBe('# A+ Common Base Fallback\n');
    });

    it('preserves user-authored root instruction files', async () => {
        await writeFile(join(workspace, 'AGENTS.md'), '# My Instructions\n');

        await materializeSpawnBootstrapFiles(workspace, [
            { relativePath: 'AGENTS.md', content: '# Project Agent Instructions\n' },
        ]);

        expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
            .toBe('# My Instructions\n');
    });

    it('updates root instruction files previously managed by A+', async () => {
        await writeFile(
            join(workspace, 'AGENTS.md'),
            '# Project Agent Instructions\n\nold\n',
        );

        await materializeSpawnBootstrapFiles(workspace, [
            {
                relativePath: 'AGENTS.md',
                content: '# Project Agent Instructions\n\nnew\n',
            },
        ]);

        expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
            .toBe('# Project Agent Instructions\n\nnew\n');
    });

    it('rejects bootstrap paths outside the managed allowlist', async () => {
        await expect(materializeSpawnBootstrapFiles(workspace, [
            { relativePath: '../outside.md', content: 'nope' },
        ])).rejects.toThrow('Unsupported spawn bootstrap path');
    });
});
