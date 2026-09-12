/**
 * 이 머신에서 샌드박스가 "실제로 명령을 실행할 수 있는지" 확인한다.
 *
 * `SandboxManager.checkDependencies()` 는 바이너리 존재만 본다. 비특권 컨테이너
 * (기본 Docker)에서는 그 검사와 `initialize()` 가 모두 통과하고, 감싼 자식이
 * `bwrap: Creating new namespace failed: Operation not permitted` 로 죽는다.
 * 즉 초기화 성공은 격리 성공의 증거가 아니다.
 *
 * 그래서 세션이 쓸 그 래퍼로 사소한 명령 하나를 실제로 돌려 본다. 실패를 이 자리
 * 에서 이름 붙이면(namespace 거부인지 그 외인지) 몇 분 뒤 엉뚱한 증상으로
 * 나타나는 것을 막고, mandatory 머신에서 비격리로 물러날 근거가 사라진다.
 */
import { exec } from 'node:child_process';
import { wrapCommand } from './manager';

/** 부작용 없고 어디에나 있는 명령. 종료 코드만 본다. */
const PROBE_COMMAND = 'true';

const NAMESPACE_DENIAL_MARKERS = [
    'Creating new namespace failed',
    'setting up uid map',
    'Operation not permitted (bwrap)',
];

export type SandboxExecutionCapability =
    | { ok: true }
    | { ok: false; reason: 'namespace-denied' | 'unknown'; detail: string };

export type SandboxExecutionCapabilityDeps = {
    wrap: (command: string) => Promise<string>;
    run: (command: string) => Promise<{ code: number; stderr: string }>;
};

const defaultDeps: SandboxExecutionCapabilityDeps = {
    wrap: (command) => wrapCommand(command),
    run: (command) => new Promise((resolve) => {
        exec(command, { timeout: 15_000 }, (error, _stdout, stderr) => {
            const code = error && typeof (error as { code?: number }).code === 'number'
                ? (error as { code: number }).code
                : (error ? 1 : 0);
            resolve({ code, stderr: stderr ?? '' });
        });
    }),
};

export async function verifySandboxExecutionCapability(
    deps: SandboxExecutionCapabilityDeps = defaultDeps,
): Promise<SandboxExecutionCapability> {
    let wrapped: string;
    try {
        wrapped = await deps.wrap(PROBE_COMMAND);
    } catch (error) {
        return {
            ok: false,
            reason: 'unknown',
            detail: error instanceof Error ? error.message : String(error),
        };
    }

    let outcome: { code: number; stderr: string };
    try {
        outcome = await deps.run(wrapped);
    } catch (error) {
        return {
            ok: false,
            reason: 'unknown',
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    if (outcome.code === 0) return { ok: true };

    const stderr = outcome.stderr.trim();
    const namespaceDenied = NAMESPACE_DENIAL_MARKERS.some((marker) => stderr.includes(marker));
    return {
        ok: false,
        reason: namespaceDenied ? 'namespace-denied' : 'unknown',
        detail: stderr || `probe exited ${outcome.code}`,
    };
}

export function describeSandboxCapabilityFailure(result: SandboxExecutionCapability): string {
    if (result.ok) return 'sandbox execution verified';
    if (result.reason === 'namespace-denied') {
        return `이 머신의 커널/컨테이너가 샌드박스 namespace 생성을 허용하지 않습니다: ${result.detail}`;
    }
    return `샌드박스 실행 확인이 실패했습니다: ${result.detail}`;
}
