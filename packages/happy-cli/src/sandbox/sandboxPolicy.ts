/**
 * 이 머신에서 샌드박스가 "선택"인지 "필수"인지 정하는 머신 단위 정책.
 *
 * 개인 머신은 owner-choice 다 — 소유자가 자기 코드를 격리 없이 돌리는 것은
 * 결함이 아니라 의도된 사용이고, 정책 파일의 부재가 그 의도를 뜻한다.
 * 공유(회사) 머신은 mandatory 다 — 서로 다른 사용자의 비신뢰 코드가 같은 UID
 * 로 돌기 때문에, 격리 해제는 그 자리에서 실패해야 한다.
 *
 * 정책 소스는 왜 settings.json 이 아닌가:
 * - settings.json 은 HAPPY_HOME_DIR 상대다. 데몬은 사용자별 자격증명을
 *   /tmp/happy-session-* 에 staging 하고 그 경로를 자식의 HAPPY_HOME_DIR 로
 *   준다. 거기에는 머신 정책이 없어 모든 공유 세션이 owner-choice 로 읽혔다.
 * - HAPPY_HOME_DIR 은 spawn 페이로드로 올 수 있는 값이다(SAFE_ENV_ALLOWLIST).
 *   정책의 기준을 그 값에 두면 정책 자체가 호출자 손에 있다.
 * - readSettings() 는 깨진 JSON 을 기본값으로 흡수한다. 정책이 거기 있으면
 *   파일을 한 글자 망치는 것이 격리 해제 수단이 된다.
 *
 * 그래서 정책은 같은 UID 사용자가 고칠 수 없는 root 소유 경로에서 읽는다.
 * ENOENT 만 "정책 없음"이고, 그 밖의 실패(권한·깨진 JSON·모르는 값)는 전부
 * mandatory 로 닫는다. env 는 신뢰 소스가 아니므로 올리는 방향으로만 반영한다.
 *
 * 이 파일이 보장하지 않는 것 (과장 금지):
 * - 사용자 간 OS 격리. sandbox-runtime 0.0.37 의 읽기 제한은 denyOnly 뿐이고
 *   (allowRead 없음) 같은 UID 의 홈·/tmp 는 기본 읽기 가능하다. 공유 머신의
 *   완전한 사용자 분리는 UID/마운트/컨테이너 같은 실제 경계가 필요하다.
 * - 세션이 샌드박스를 벗을 수 없다는 것. bwrap/seatbelt 가 자식까지 감싸는지는
 *   머신별 실측 대상이며 이 파일은 그 증거가 아니다.
 * - staged 자격증명(daemon.state.json 사본의 controlSecret 포함)의 비밀성.
 *   그 경로는 floor 로 가릴 수 없다 — /tmp 를 가리면 세션 자신의 자격증명과
 *   빌드가 함께 죽는다. 파일 대신 env 전달이나 실제 UID 분리가 필요하다.
 *
 * 이 파일이 하는 일은 하나다: "격리 없이 진행" 경로를 정책이 필수인 머신에서
 * 제거한다. 그 위의 실제 경계는 별도 작업이다.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type SandboxPolicyMode = 'mandatory' | 'owner-choice';

export type MandatorySandboxRefusalReason =
    | 'no-sandbox-flag'
    | 'disabled-config'
    | 'malformed-injection'
    | 'missing-config'
    | 'unsafe-write-scope'
    | 'capability-unavailable'
    | 'init-failed';

/** 같은 UID 사용자가 고칠 수 없어야 하므로 root 소유 경로에 둔다. */
export const MACHINE_SANDBOX_POLICY_FILE = '/etc/aplus/sandbox-policy.json';

/** 신뢰 소스가 아니다 — mandatory 로 올리는 데만 쓴다. */
export const SANDBOX_POLICY_ENV_VAR = 'HAPPY_SANDBOX_POLICY_MODE';

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

export function readMachineSandboxPolicyMode(deps: {
    readFile?: (path: string) => string;
} = {}): SandboxPolicyMode {
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    let raw: string;
    try {
        raw = readFile(MACHINE_SANDBOX_POLICY_FILE);
    } catch (error) {
        // 파일이 없는 것만 "정책 없음"이다. 권한 거부처럼 읽을 수 없는 상태를
        // 없는 것으로 취급하면 읽기를 막는 것이 격리 해제가 된다.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'owner-choice';
        return 'mandatory';
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        const mode = (parsed as { mode?: unknown } | null)?.mode;
        if (mode === 'owner-choice') return 'owner-choice';
        return 'mandatory';
    } catch {
        return 'mandatory';
    }
}

export function resolveEffectiveSandboxPolicyMode(input: {
    machineMode: SandboxPolicyMode;
    envValue: string | undefined;
}): SandboxPolicyMode {
    if (input.machineMode === 'mandatory') return 'mandatory';
    return input.envValue === 'mandatory' ? 'mandatory' : 'owner-choice';
}

/** 세션 시작 시 한 번 판정한다. env 는 올리는 방향으로만 반영된다. */
export function resolveSessionSandboxPolicyMode(
    env: Record<string, string | undefined> = process.env,
): SandboxPolicyMode {
    return resolveEffectiveSandboxPolicyMode({
        machineMode: readMachineSandboxPolicyMode(),
        envValue: env[SANDBOX_POLICY_ENV_VAR],
    });
}

/**
 * 세션 config 가 낮출 수 없는 최소 경계. 값이 사용자·프로젝트에서 오기 때문에
 * enabled 만 확인하면 denyReadPaths:[] 로 그대로 벗을 수 있다.
 *
 * Linux 에서 디렉터리 denyRead 는 그 자리에 tmpfs 를 덮는 방식이라, wrap 시점에
 * 존재하는 디렉터리라면 이후 그 안에 생기는 경로까지 함께 가려진다. 반대로 wrap
 * 시점에 없는 경로는 조용히 건너뛴다 — floor 는 반드시 존재하는 상위 디렉터리를
 * 가리켜야 한다.
 *
 * 데몬은 `--home` 으로 .happy_remote / .happy-dev 를 쓰므로 ~/.happy 하나를
 * 막는 것으로는 실제 데몬 홈이 남는다. 홈 디렉터리의 .happy* 를 전부 덮는다.
 *
 * homeDir 은 반드시 passwd 기준(os.userInfo)이어야 한다. os.homedir() 는 $HOME
 * 을 먼저 보고 그 값은 spawn 페이로드로 올 수 있다 — floor 기준을 호출자가
 * 옮길 수 있으면 floor 가 아니다. daemonHappyHomeDir 도 같은 이유로 env 가
 * 아니라 이 프로세스가 실제로 쓰는 값에서만 받고, tmp 아래(staged 세션 홈)면
 * 세션 자신의 것이므로 제외한다.
 */
export function sandboxTrustFloorPaths(input: {
    homeDir: string;
    daemonHappyHomeDir?: string;
    listHomeEntries?: (homeDir: string) => string[];
}): string[] {
    const listHomeEntries = input.listHomeEntries
        ?? ((homeDir: string) => readdirSync(homeDir));
    let happyHomes: string[] = [];
    try {
        happyHomes = listHomeEntries(input.homeDir)
            .filter((entry) => entry === '.happy' || entry.startsWith('.happy'))
            .map((entry) => join(input.homeDir, entry));
    } catch {
        // 홈을 못 읽어도 floor 는 최소한 실행 중 데몬 홈을 덮는다.
        happyHomes = [];
    }
    return [...new Set([...happyHomes, ...(input.daemonHappyHomeDir ? [input.daemonHappyHomeDir] : [])])];
}

export function isUnsafeMandatoryWriteScope(paths: string[], homeDir: string): boolean {
    const home = homeDir.replace(/\/+$/, '');
    return paths.some((candidate) => {
        const normalized = candidate.replace(/\/+$/, '');
        return normalized === '' || normalized === home;
    });
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
