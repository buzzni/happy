import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectPath } from '@/projectPath';
import { healInstallArtifacts } from './installArtifactsHeal';

// npm 12 는 allowScripts 에 허용되지 않은 설치 스크립트를 막는다. 그러면 postinstall 이
// 남겼어야 할 산출물 없이 happy 가 설치되고, 설치는 성공으로 끝난다. 이 테스트는 그
// 상태의 패키지 루트를 임시 디렉터리에 만들어 데몬 시작 복구를 실제로 돌린다.
const roots: string[] = [];

function packageRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'happy-install-heal-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@buzzni/happy-cli' }));
    return root;
}

function withShippedTools(root: string): void {
    copyFileSync(join(projectPath(), 'scripts', 'unpack-tools.cjs'), join(root, 'scripts', 'unpack-tools.cjs'));
    symlinkSync(join(projectPath(), 'tools', 'archives'), join(root, 'tools', 'archives'));
    // The copied script requires `tar`, which ships as a dependency of the package.
    symlinkSync(join(projectPath(), 'node_modules'), join(root, 'node_modules'));
}

function withNodePty(root: string, files: Record<string, number>): string {
    const nodePty = join(root, 'node_modules', 'node-pty');
    mkdirSync(nodePty, { recursive: true });
    writeFileSync(join(nodePty, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'lib/index.js' }));
    for (const [relative, mode] of Object.entries(files)) {
        const file = join(nodePty, relative);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'x');
        chmodSync(file, mode);
    }
    return nodePty;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('healInstallArtifacts', () => {
    it('unpacks the bundled tools a blocked postinstall left out, once', async () => {
        const root = packageRoot();
        withShippedTools(root);
        const log = vi.fn();

        const first = await healInstallArtifacts({ packageRoot: root, platform: process.platform, log });
        expect(first.tools).toBe('restored');
        const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
        expect(existsSync(join(root, 'tools', 'unpacked', binary))).toBe(true);
        expect(existsSync(join(root, 'tools', 'unpacked', 'ripgrep.node'))).toBe(true);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('tools'));

        const second = await healInstallArtifacts({ packageRoot: root, platform: process.platform, log: vi.fn() });
        expect(second.tools).toBe('present');
    });

    it('reports a tools restore it could not do instead of throwing', async () => {
        const root = packageRoot();
        const log = vi.fn();

        const report = await healInstallArtifacts({ packageRoot: root, platform: process.platform, log });

        expect(report.tools).toBe('failed');
        expect(log).toHaveBeenCalledWith(expect.stringContaining('--allow-scripts=@buzzni/happy-cli,node-pty'));
    });

    // 데몬 프로세스 안에서 풀기 때문에 손상된 아카이브의 스트림 오류가 새어 나가면
    // uncaughtException 으로 데몬이 종료된다.
    it('reports a corrupt tools archive as failed instead of crashing', async () => {
        const root = packageRoot();
        withShippedTools(root);
        rmSync(join(root, 'tools', 'archives'));
        mkdirSync(join(root, 'tools', 'archives'));
        for (const name of readdirSync(join(projectPath(), 'tools', 'archives'))) {
            const shipped = readFileSync(join(projectPath(), 'tools', 'archives', name));
            writeFileSync(join(root, 'tools', 'archives', name), shipped.subarray(0, 4096));
        }
        const log = vi.fn();

        const report = await healInstallArtifacts({ packageRoot: root, platform: process.platform, log });

        expect(report.tools).toBe('failed');
        expect(log).toHaveBeenCalledWith(expect.stringContaining('--allow-scripts=@buzzni/happy-cli,node-pty'));
    }, 10_000);

    it('makes the macOS node-pty spawn-helper executable again', async () => {
        const root = packageRoot();
        const nodePty = withNodePty(root, {
            'prebuilds/darwin-arm64/spawn-helper': 0o644,
            'prebuilds/darwin-arm64/pty.node': 0o644,
            'prebuilds/darwin-x64/spawn-helper': 0o755,
        });

        const report = await healInstallArtifacts({ packageRoot: root, platform: 'darwin', log: vi.fn() });

        expect(report.nodePtyHelper).toBe('restored');
        expect(statSync(join(nodePty, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o111).not.toBe(0);
        const again = await healInstallArtifacts({ packageRoot: root, platform: 'darwin', log: vi.fn() });
        expect(again.nodePtyHelper).toBe('present');
    });

    it('leaves the spawn-helper alone outside macOS', async () => {
        const root = packageRoot();
        withNodePty(root, { 'build/Release/pty.node': 0o644 });

        const report = await healInstallArtifacts({ packageRoot: root, platform: 'linux', log: vi.fn() });

        expect(report.nodePtyHelper).toBe('not-applicable');
    });

    // Linux 에는 node-pty prebuild 가 없어 설치 스크립트의 node-gyp 빌드가 유일한 출처다.
    // 데몬이 대신 빌드할 수는 없으니, 원격 터미널이 왜 안 되는지 로그에 남긴다.
    it('reports a node-pty native module that was never built', async () => {
        const root = packageRoot();
        withNodePty(root, {});
        const log = vi.fn();

        const report = await healInstallArtifacts({ packageRoot: root, platform: 'linux', log });

        expect(report.nodePtyNative).toBe('missing');
        expect(log).toHaveBeenCalledWith(expect.stringContaining('--allow-scripts=@buzzni/happy-cli,node-pty'));
    });

    it('finds a built or prebuilt node-pty native module', async () => {
        const built = packageRoot();
        withNodePty(built, { 'build/Release/pty.node': 0o644 });
        const prebuilt = packageRoot();
        withNodePty(prebuilt, { [`prebuilds/linux-${process.arch}/pty.node`]: 0o644 });

        expect((await healInstallArtifacts({ packageRoot: built, platform: 'linux', log: vi.fn() })).nodePtyNative).toBe('present');
        expect((await healInstallArtifacts({ packageRoot: prebuilt, platform: 'linux', log: vi.fn() })).nodePtyNative).toBe('present');
    });

    it('never throws, even for a package root that does not exist', async () => {
        await expect(healInstallArtifacts({
            packageRoot: join(tmpdir(), 'happy-install-heal-missing-root'),
            platform: 'darwin',
            log: vi.fn(),
        })).resolves.toMatchObject({ tools: 'failed' });
    });
});
