import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GUARD_SCRIPT = join(__dirname, '..', 'guard-publish-artifact.cjs');
const temporaryDirectories: string[] = [];

function writeFixtureFile(packageRoot: string, relativePath: string, contents: string): void {
    const filePath = join(packageRoot, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, contents);
}

function createPublishTarball(packageVersion: string, cliVersion: string): string {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'happy-cli-guard-test-'));
    temporaryDirectories.push(fixtureRoot);
    const packageRoot = join(fixtureRoot, 'package');

    writeFixtureFile(packageRoot, 'package.json', JSON.stringify({
        name: '@namsangboy/happy-cli',
        version: packageVersion,
        bin: { happy: 'bin/happy.mjs' },
        dependencies: {
            '@slopus/happy-wire': '0.0.0-test',
            zod: '0.0.0-test',
            '@paralleldrive/cuid2': '0.0.0-test'
        },
        bundledDependencies: [
            '@slopus/happy-wire',
            'zod',
            '@paralleldrive/cuid2'
        ]
    }));
    writeFixtureFile(
        packageRoot,
        'bin/happy.mjs',
        `if (process.argv.includes('--version')) console.log(${JSON.stringify(cliVersion)});\n`
    );
    writeFixtureFile(packageRoot, 'node_modules/@slopus/happy-wire/package.json', JSON.stringify({ name: '@slopus/happy-wire', version: '0.0.0-test' }));
    writeFixtureFile(packageRoot, 'node_modules/@slopus/happy-wire/dist/index.mjs', 'export {};\n');
    writeFixtureFile(packageRoot, 'node_modules/zod/package.json', JSON.stringify({ name: 'zod', version: '0.0.0-test' }));
    writeFixtureFile(packageRoot, 'node_modules/@paralleldrive/cuid2/package.json', JSON.stringify({ name: '@paralleldrive/cuid2', version: '0.0.0-test' }));
    writeFixtureFile(packageRoot, 'node_modules/@paralleldrive/cuid2/node_modules/@noble/hashes/package.json', JSON.stringify({ name: '@noble/hashes', version: '0.0.0-test' }));

    const tarball = join(fixtureRoot, 'happy-cli.tgz');
    const tarResult = spawnSync('tar', ['-czf', tarball, '-C', fixtureRoot, 'package'], { encoding: 'utf8' });
    expect(tarResult.status, tarResult.stderr).toBe(0);
    return tarball;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe('guard-publish-artifact', () => {
    it('rejects an installed CLI whose runtime version differs from package metadata', () => {
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.55');
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('CLI version mismatch: expected 1.1.10-aplus.56, got 1.1.10-aplus.55');
    }, 40_000);
});
