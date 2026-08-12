import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { repairNodePtyPermissions } = require('../fix-node-pty-perms.cjs') as {
    repairNodePtyPermissions: (options: {
        platform: string;
        arch: string;
        nodePtyRoot: string;
    }) => string[];
};

describe('fix-node-pty-perms', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
    });

    it('makes the current macOS architecture spawn-helper executable', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-node-pty-'));
        tempDirs.push(root);
        const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
        mkdirSync(join(helper, '..'), { recursive: true });
        writeFileSync(helper, '#!/bin/sh\nexit 0\n');
        chmodSync(helper, 0o644);

        expect(repairNodePtyPermissions({
            platform: 'darwin',
            arch: 'arm64',
            nodePtyRoot: root,
        })).toContain(helper);
        expect(statSync(helper).mode & 0o111).not.toBe(0);
    });

    it('fails when the current macOS architecture spawn-helper is missing', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-node-pty-'));
        tempDirs.push(root);

        expect(() => repairNodePtyPermissions({
            platform: 'darwin',
            arch: 'arm64',
            nodePtyRoot: root,
        })).toThrow('node-pty spawn-helper is missing');
    });

    it('does not require or modify a spawn-helper for the other macOS architecture', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-node-pty-'));
        tempDirs.push(root);
        const currentHelper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
        const otherHelper = join(root, 'prebuilds', 'darwin-x64', 'spawn-helper');
        mkdirSync(join(currentHelper, '..'), { recursive: true });
        mkdirSync(join(otherHelper, '..'), { recursive: true });
        writeFileSync(currentHelper, '#!/bin/sh\nexit 0\n');
        writeFileSync(otherHelper, '#!/bin/sh\nexit 0\n');
        chmodSync(currentHelper, 0o755);
        chmodSync(otherHelper, 0o644);

        expect(repairNodePtyPermissions({
            platform: 'darwin',
            arch: 'arm64',
            nodePtyRoot: root,
        })).toEqual([]);
        expect(statSync(otherHelper).mode & 0o111).toBe(0);
    });
});
