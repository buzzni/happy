#!/usr/bin/env node
/**
 * macOS-only postinstall fix for node-pty's spawn-helper.
 *
 * The npm tarball ships prebuilds/darwin-{arm64,x64}/spawn-helper with
 * 0o644 (no execute bit). At runtime node-pty's posix_spawnp on macOS
 * fails with "posix_spawnp failed." because the kernel refuses to
 * execve() a non-executable file. This script flips the bit back
 * during postinstall so users don't have to rebuild from source.
 *
 * No-op on Linux / Windows — those platforms don't use spawn-helper.
 *
 * See specs/remote-terminal/ Phase 6 closure notes (2026-05-03).
 */

const fs = require('node:fs');
const path = require('node:path');

function resolveNodePtyRoot() {
    try {
        const entry = require.resolve('node-pty', { paths: [path.dirname(__dirname)] });
        const entryDirectory = path.dirname(entry);
        return path.basename(entryDirectory) === 'lib'
            ? path.dirname(entryDirectory)
            : entryDirectory;
    } catch (_e) {
        const candidates = [
            path.join(__dirname, '..', 'node_modules', 'node-pty'),
            path.join(__dirname, '..', '..', 'node-pty'),
        ];
        const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
        if (!root) throw new Error('node-pty package could not be resolved');
        return root;
    }
}

function repairNodePtyPermissions({
    platform = process.platform,
    arch = process.arch,
    nodePtyRoot,
} = {}) {
    if (platform !== 'darwin') return [];

    const resolvedNodePtyRoot = nodePtyRoot || resolveNodePtyRoot();
    const currentHelper = path.join(resolvedNodePtyRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (!fs.existsSync(currentHelper)) {
        throw new Error(`node-pty spawn-helper is missing for darwin-${arch}: ${currentHelper}`);
    }

    if ((fs.statSync(currentHelper).mode & 0o111) !== 0) return [];

    fs.chmodSync(currentHelper, 0o755);
    console.log(`[happy-cli postinstall] chmod +x ${currentHelper}`);
    if ((fs.statSync(currentHelper).mode & 0o111) === 0) {
        throw new Error(`node-pty spawn-helper is not executable: ${currentHelper}`);
    }

    return [currentHelper];
}

if (require.main === module) {
    try {
        repairNodePtyPermissions();
    } catch (error) {
        console.error(`[happy-cli postinstall] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { repairNodePtyPermissions };
