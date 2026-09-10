/**
 * 이 머신에서 샌드박스가 "선택"인지 "필수"인지 정하는 머신 단위 정책.
 *
 * 개인 머신은 owner-choice 다 — 소유자가 자기 코드를 격리 없이 돌리는 것은
 * 결함이 아니라 의도된 사용이고, 이 정책의 부재가 그 의도를 뜻한다.
 * 공유(회사) 머신은 mandatory 다 — 서로 다른 사용자의 비신뢰 코드가 같은 UID
 * 로 돌기 때문에, 격리 해제는 그 자리에서 실패해야 한다.
 *
 * 정책 값이 있는데 해석되지 않으면 mandatory 로 닫는다. owner-choice 로 열면
 * 정책 파일 한 글자를 망치는 것이 격리 해제 수단이 된다.
 *
 * 이 파일이 보장하지 않는 것 (과장 금지):
 * - 사용자 간 OS 격리. sandbox-runtime 0.0.37 의 읽기 제한은 denyOnly 뿐이고
 *   (allowRead 없음) 같은 UID 의 홈·/tmp 는 기본 읽기 가능하다. 공유 머신의
 *   완전한 사용자 분리는 UID/마운트/컨테이너 같은 실제 경계가 필요하다.
 * - 이 정책 파일 자체의 무결성. 같은 UID 로 샌드박스 밖에서 도는 행위자는
 *   이 값을 고칠 수 있고 로컬에서 그것을 탐지할 수단은 없다.
 * - 세션이 샌드박스를 벗을 수 없다는 것. bwrap/seatbelt 가 자식까지 감싸는지는
 *   머신별 실측 대상이며 이 파일은 그 증거가 아니다.
 *
 * 이 파일이 하는 일은 하나다: "격리 없이 진행" 경로를 정책이 필수인 머신에서
 * 제거한다. 그 위의 실제 경계는 별도 작업이다.
 */

export type SandboxPolicyMode = 'mandatory' | 'owner-choice';

export type MandatorySandboxRefusalReason =
    | 'no-sandbox-flag'
    | 'disabled-config'
    | 'malformed-injection'
    | 'missing-config'
    | 'unsafe-write-scope'
    | 'init-failed';

/** 격리 없이 진행하지 않고 멈춘 이유를 사용자에게 그대로 전달한다. */
export class MandatorySandboxError extends Error {
    readonly reason: MandatorySandboxRefusalReason;

    constructor(reason: MandatorySandboxRefusalReason, detail?: string) {
        super(
            `이 머신은 샌드박스 격리가 필수입니다 (${reason}). 격리 없이 세션을 시작하지 않습니다.`
            + (detail ? ` 원인: ${detail}` : ''),
        );
        this.name = 'MandatorySandboxError';
        this.reason = reason;
    }
}

export function resolveSandboxPolicyMode(
    settings: { sandboxPolicy?: unknown } | undefined,
): SandboxPolicyMode {
    const policy = settings?.sandboxPolicy;
    if (policy === undefined) return 'owner-choice';
    if (typeof policy === 'object' && policy !== null) {
        const mode = (policy as { mode?: unknown }).mode;
        if (mode === 'owner-choice') return 'owner-choice';
        if (mode === 'mandatory') return 'mandatory';
    }
    return 'mandatory';
}

/**
 * 샌드박스 초기화가 실패했을 때 child 를 그래도 띄울지 판정한다.
 * mandatory 머신에서 'continue' 는 요청받은 격리가 조용히 사라지는 경로다.
 */
export function resolveSandboxInitFailureAction(
    policyMode: SandboxPolicyMode,
): 'abort' | 'continue' {
    return policyMode === 'mandatory' ? 'abort' : 'continue';
}

/**
 * 세션 config 가 낮출 수 없는 최소 경계. 값이 사용자·프로젝트에서 오기 때문에
 * enabled 만 확인하면 denyReadPaths:[] 로 그대로 벗을 수 있다.
 *
 * Linux 에서 디렉터리 denyRead 는 그 자리에 tmpfs 를 덮는 방식이라, wrap 시점에
 * 존재하는 디렉터리라면 이후 그 안에 생기는 경로까지 함께 가려진다. 반대로 wrap
 * 시점에 없는 경로는 조용히 건너뛴다 — floor 는 반드시 존재하는 상위 디렉터리를
 * 가리켜야 한다.
 */
export function sandboxTrustFloorPaths(happyHomeDir: string): string[] {
    return [happyHomeDir];
}

export function isUnsafeMandatoryWriteScope(paths: string[], homeDir: string): boolean {
    const home = homeDir.replace(/\/+$/, '');
    return paths.some((candidate) => {
        const normalized = candidate.replace(/\/+$/, '');
        return normalized === '' || normalized === home;
    });
}
