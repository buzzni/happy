/**
 * 설치 스크립트가 남겼어야 할 산출물을 데몬 시작 때 다시 만든다.
 *
 * npm 12 부터 설치 스크립트는 allowScripts 에 허용된 패키지만 실행된다(11 이하는 경고만).
 * 허용 없이 `npm i -g @buzzni/happy-cli` 하면 postinstall 과 node-pty 빌드가 조용히
 * 빠지는데 설치는 성공으로 끝나고 `happy` 도 뜬다. 깨지는 것은 나중에 쓰는 기능이다:
 *
 * - `tools/unpacked` 가 없어 ripgrep·difftastic RPC 가 실패한다.
 * - macOS 에서 node-pty `spawn-helper` 에 실행 권한이 없어 원격 터미널이
 *   `posix_spawnp failed.` 로 실패한다.
 * - Linux 는 node-pty prebuild 가 없어 네이티브 모듈 자체가 없다. 빌드 도구가 필요해
 *   데몬이 대신 만들 수 없으므로 원인과 복구 명령을 로그에 남긴다.
 *
 * 복구는 멱등이다. 이미 있으면 아무것도 하지 않는다. 어떤 실패도 데몬 시작을 막지 않는다.
 */
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';

export type InstallArtifactsHealReport = {
    tools: 'present' | 'restored' | 'failed';
    nodePtyHelper: 'present' | 'restored' | 'failed' | 'not-applicable';
    nodePtyNative: 'present' | 'missing' | 'unknown';
};

type HealOptions = {
    packageRoot?: string;
    platform?: NodeJS.Platform;
    log?: (message: string) => void;
};

const REINSTALL_HINT = 'reinstall with `npm i -g @buzzni/happy-cli@latest --allow-scripts=@buzzni/happy-cli,node-pty`';

export async function healInstallArtifacts(options: HealOptions = {}): Promise<InstallArtifactsHealReport> {
    const packageRoot = options.packageRoot ?? projectPath();
    const platform = options.platform ?? process.platform;
    const log = options.log ?? ((message: string) => logger.debug(`[install-heal] ${message}`));
    const nodePtyRoot = resolveNodePtyRoot(packageRoot);
    return {
        tools: await healTools(packageRoot, log),
        nodePtyHelper: platform === 'darwin' ? healSpawnHelper(nodePtyRoot, log) : 'not-applicable',
        nodePtyNative: checkNodePtyNative(nodePtyRoot, platform, log),
    };
}

// The postinstall script is the single definition of how tools are unpacked; it
// exports `unpackTools` and only runs itself when executed directly.
async function healTools(packageRoot: string, log: (message: string) => void): Promise<InstallArtifactsHealReport['tools']> {
    try {
        const script = join(packageRoot, 'scripts', 'unpack-tools.cjs');
        const { unpackTools } = createRequire(import.meta.url)(script) as {
            unpackTools: () => Promise<{ alreadyUnpacked: boolean }>;
        };
        const result = await unpackTools();
        if (result.alreadyUnpacked) return 'present';
        log('restored tools/unpacked (the install script did not run)');
        return 'restored';
    } catch (error) {
        log(`could not restore tools/unpacked: ${errorMessage(error)}; ${REINSTALL_HINT}`);
        return 'failed';
    }
}

function resolveNodePtyRoot(packageRoot: string): string | null {
    try {
        return dirname(createRequire(join(packageRoot, 'package.json')).resolve('node-pty/package.json'));
    } catch {
        return null;
    }
}

// The npm tarball ships prebuilds/darwin-*/spawn-helper without the execute bit.
function healSpawnHelper(nodePtyRoot: string | null, log: (message: string) => void): InstallArtifactsHealReport['nodePtyHelper'] {
    if (!nodePtyRoot) return 'failed';
    let restored = false;
    for (const arch of ['arm64', 'x64']) {
        const helper = join(nodePtyRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
        if (!existsSync(helper)) continue;
        try {
            if ((statSync(helper).mode & 0o111) !== 0) continue;
            chmodSync(helper, 0o755);
            restored = true;
        } catch (error) {
            log(`could not make ${helper} executable: ${errorMessage(error)}; ${REINSTALL_HINT}`);
            return 'failed';
        }
    }
    if (restored) log('restored node-pty spawn-helper execute bit (the install script did not run)');
    return restored ? 'restored' : 'present';
}

// Mirrors node-pty's loadNativeModule search order.
function checkNodePtyNative(
    nodePtyRoot: string | null,
    platform: NodeJS.Platform,
    log: (message: string) => void,
): InstallArtifactsHealReport['nodePtyNative'] {
    if (!nodePtyRoot) return 'unknown';
    const name = platform === 'win32' ? 'conpty.node' : 'pty.node';
    const found = ['build/Release', 'build/Debug', `prebuilds/${platform}-${process.arch}`]
        .some((dir) => existsSync(join(nodePtyRoot, dir, name)));
    if (found) return 'present';
    log(`node-pty native module ${name} is missing, so the remote terminal is unavailable; ${REINSTALL_HINT}`);
    return 'missing';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
