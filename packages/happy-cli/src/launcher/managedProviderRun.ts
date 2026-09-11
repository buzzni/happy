/**
 * specs/managed-cloud-byos P4 — 도구 경계를 세운 채 **provider 를 실제로 띄운다**.
 *
 * 지금까지는 세션(broker·executor·grant)과 supervisor(세대·격리 실행)가 각각
 * 있었다. 이 파일이 둘을 한 번의 실행으로 잇는다:
 *
 *   ① 세션이 broker 를 열고 provider 계획을 만든다
 *   ② 계획이 요구하는 파일을 **release 전에** 쓴다 (root 소유, 읽기 전용)
 *   ③ supervisor 가 세대에서 provider 를 park → 등록 → release
 *   ④ 정지: 세대를 먼저 죽이고 그 다음 broker 를 닫는다
 *
 * ②가 release 전인 것이 중요하다. `environments.toml` 이 없는 채로 놓아주면
 * provider 는 정책 없이 도구를 광고한다 — 그 창이 곧 경계의 구멍이다.
 *
 * ④의 순서도 뒤집으면 안 된다. broker 를 먼저 닫으면 아직 도는 도구가 자기
 * 호출을 잃을 뿐 계속 살아 있고, 세대를 먼저 죽이면 도구와 provider 가 함께
 * 끝난 뒤 문이 닫힌다.
 */
import { logger } from '@/ui/logger';
import {
    MANAGED_CONTROL_CHILD_FD,
    MANAGED_STOP_CLEAN,
    managedStopRequest,
    readManagedControlChannel,
} from '@/managed/managedControlChannel';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generationCgroupPath } from './supervisor';
import { resolve, sep } from 'node:path';

import {
    type ManagedProvisioningDeps,
    trustedPathRefusal,
} from '@/daemon/managedRuntimeIdentity';

import type { GenerationKey } from './generationManifest';
import type { ExecOutcome, StopOutcome } from './supervisor';
import type { ManagedToolSession } from './managedToolSession';

/**
 * 제품이 채우는 supervisor 설정.
 *
 * 호출자가 완성된 supervisor 를 건네면 그 안의 `envAllowlist` 가 계획과 다를 수
 * 있고, 바깥에서 그것을 "같다" 고 **주장**하는 것으로는 아무것도 보장되지 않는다.
 * 그래서 설정은 여기서 만들고, 호출자는 그 설정으로 supervisor 를 **만들어 주는
 * 일만** 한다.
 */
export type ProviderSupervisorConfig = {
    cgroupRoot: string;
    helperPath: string;
    workloadPath: string;
    envAllowlist: Record<string, string>;
    resolveGenerationCredentials: () => { uid: number; gid: number };
};

export type ProviderRunSupervisor = {
    execGeneration: (input: {
        key: GenerationKey;
        inherit?: Array<{ childFd: number; parentFd: number }>;
        statusFd: number;
        releaseFd: number;
        leaseExpiresMonotonic: number;
        controlFds?: number[];
        onAcquired?: (pid: number) => Promise<void>;
        onExit?: (exit: { code: number | null; signal: string | null }) => void;
        /** 이 세대의 제어 통로 쓰기 쪽. supervisor 만 쥔다. */
        onControlWriters?: (writers: Map<number, { write: (text: string) => void }>) => void;
    }) => Promise<ExecOutcome>;
    stopGeneration: (key: GenerationKey) => StopOutcome;
};

/**
 * 실행에 실패했을 때 호출자에게 남는 것.
 *
 * 실패를 던지면서 정리 결과까지 버리면, 세대가 남았는지도 모르고 다시 치울
 * 손잡이도 없다. 그래서 오류에 **정지 결과와 재시도 수단과 세대 식별자**를 싣는다.
 */
export class ManagedProviderLaunchError extends Error {
    readonly stopOutcome: StopOutcome;
    readonly stop: () => Promise<StopOutcome>;
    readonly key: GenerationKey;

    constructor(cause: Error, context: {
        stopOutcome: StopOutcome;
        stop: () => Promise<StopOutcome>;
        key: GenerationKey;
    }) {
        super(cause.message, { cause });
        this.name = 'ManagedProviderLaunchError';
        this.stopOutcome = context.stopOutcome;
        this.stop = context.stop;
        this.key = context.key;
    }
}

/** 커널이 보고한 provider 자신의 종료. */
export type ObservedProviderExit = { code: number | null; signal: string | null };

export type ManagedProviderRun = {
    outcome: ExecOutcome;
    /**
     * 이 세대 provider 의 관측된 종료. 아직 관측되지 않았으면 `null`.
     *
     * **기다리지 않는다.** checkpoint 가 여기서 막히면 끝나지 않는 provider 하나가
     * runtime 전체를 멈춘다. 기다림에 예산을 매기는 것은 부르는 쪽 일이고, 이
     * 함수의 일은 '보았는가' 에 사실대로 답하는 것뿐이다.
     *
     * `null` 은 '정상 종료가 아니다' 가 아니라 **'모른다'** 이다. provider 상태를
     * 보관해도 되는지 판정하는 쪽에서 그 둘은 같은 결론(보관 불가)으로 가지만,
     * 이유가 다르므로 여기서 섞지 않는다.
     */
    observedExit: () => ObservedProviderExit | null;
    /**
     * 이 세대에게 **죽이지 않고** 입력을 끝내라고 청한다.
     *
     * 통로가 없으면 `false`. 그것은 실패가 아니라 "이 runtime 은 우아한 정지를
     * 할 수 없다" 이고, 그러면 quiescence gate 가 `eof-unverified` 로 거절한다.
     */
    requestGracefulStop: () => boolean;
    /**
     * 정지를 청하고, **자식이 답할 때까지** 기다린다.
     *
     * 세 가지가 모두 있어야 한다:
     *  1. 자식의 ack `exhausted-clean` — iterator 가 abort 가 아니라 소진으로
     *     끝났고 SDK 자신의 프로세스가 code 0·무신호·강제 아님으로 나갔다.
     *     이것만 자식이 알 수 있다.
     *  2. 관측된 자식 종료. ack 는 "곧 나갈 것" 이지 "나갔다" 가 아니다.
     *  3. 빈 cgroup. 종료한 자식이 손자를 남겼으면 아직 쓰고 있다.
     *
     * 예산이 지나면 `timeout` 이다. 그것을 깨끗한 정지로 접는 것이 아직 쓰고
     * 있는 provider 를 보관하는 길이다.
     */
    awaitGracefulStop: (budgetMs: number) => Promise<{
        stopped: boolean;
        detail: 'stopped' | 'no-channel' | 'timeout' | 'exit-unobserved' | string;
        /**
         * 이 세대가 실제로 쓴 native session. 자식이 말하지 않았거나(구 peer,
         * 세션을 얻기 전 종료) 충돌했으면 없다. **정지 판정의 조건이 아니다.**
         */
        nativeId?: string;
        /** 자식이 한 세대에 두 개의 다른 신원을 주장했다. 신원은 버려진다. */
        identity?: 'conflict';
    }>;
    /**
     * 세대를 정지시키고 도구 경계를 거둔다.
     *
     * **정지가 증명될 때까지 끝난 것이 아니다.** 첫 시도가 비었음을 관측하지
     * 못하면 그 실패를 그대로 돌려주고, 다시 부르면 다시 시도한다. 실패를
     * 성공으로 접거나 `observedEmptyAt: 0` 같은 값을 지어내면, 남아 있는
     * 프로세스가 정지된 것으로 원장에 남는다.
     */
    stop: () => Promise<StopOutcome>;
};

/**
 * 계획을 실제 실행으로 옮기는 스크립트.
 *
 * 신뢰 helper 는 **인자 없이** workload 하나만 execve 한다(§5.36). 그래서
 * provider 의 인자는 이 파일이 싣는다. root 소유·읽기 전용으로 두어 provider 가
 * 자기 실행 정의를 다시 쓰지 못하게 한다.
 */
export function providerWorkloadScript(input: {
    path: string;
    execPath: string;
    args: string[];
    /** 계획이 정한 실행 디렉터리. 들어가지 못하면 실행하지 않는다. */
    cwd: string;
}): { path: string; contents: string; mode: number } {
    /*
     * 접두어 비교만으로는 `/usr/local/lib/saycode/../../tmp/x` 가 통과한다.
     * 정규화한 뒤 신뢰 루트 **안**인지 본다.
     */
    const canonical = resolve(input.path);
    if (canonical !== input.path
        || !canonical.startsWith(`${TRUSTED_LAUNCH_ROOT}${sep}`)
        || canonical.slice(TRUSTED_LAUNCH_ROOT.length + 1).includes(sep)) {
        throw new Error('provider workload must live directly in the trusted directory');
    }
    if (!input.execPath.startsWith('/')) {
        throw new Error('provider exec path must be absolute');
    }
    if (!input.cwd.startsWith('/')) {
        throw new Error('provider cwd must be absolute');
    }
    const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
    const quoted = input.args.map(quote).join(' ');
    /*
     * `cd` 가 실패하면 **실행하지 않는다**. 신뢰 helper 도 supervisor 의 기본
     * 실행기도 chdir 하지 않으므로, 여기서 하지 않으면 provider 는 물려받은 아무
     * 디렉터리에서 돌면서 workspace 안에 있다고 보고한다.
     */
    return {
        path: input.path,
        contents: [
            '#!/bin/sh',
            '# managed runtime: generated launch definition. Do not edit.',
            'cd ' + quote(input.cwd) + ' || exit 70',
            'exec ' + quote(input.execPath) + ' ' + quoted,
            '',
        ].join('\n'),
        mode: 0o555,
    };
}

/** workload 가 살 수 있는 유일한 디렉터리. 경로 문자열이 아니라 정규화로 판정한다. */
export const TRUSTED_LAUNCH_ROOT = '/usr/local/lib/saycode';

/*
 * The image's exec targets, named again here rather than imported from
 * `managedImagePackaging`.
 *
 * That module belongs to the image's runtime entry, which is bundled into
 * **one** read-only CommonJS file. A module shared with the launcher's graph
 * makes the bundler emit a sibling chunk, and the image installs one file — so
 * the file it installs fails to load, at image build time if the layout check
 * runs and at tool-call time if it does not. `managedImagePathsAgree` in
 * `managedRunConfig.test.ts` is what keeps the two copies from drifting.
 */
export const TRUSTED_TOOL_WORKLOAD_PATH = `${TRUSTED_LAUNCH_ROOT}/tool-workload`;
export const TRUSTED_PROVIDER_EXEC_PATH = `${TRUSTED_LAUNCH_ROOT}/provider-workload`;

/**
 * 신뢰 경로 판정.
 *
 * **잎만 보면 안 된다** — 쓰기 가능한 조상 아래의 root 소유 파일은 rename 으로
 * 갈아치울 수 있다. 조상 검사는 이미 있는 규칙을 그대로 쓴다
 * (`managedRuntimeIdentity.trustedPathRefusal`: 모든 조상이 실제 디렉터리이고,
 * 심볼릭 링크가 아니며, root/daemon 소유이고, 그룹·기타 쓰기가 없어야 한다).
 * 여기서는 그 위에 **잎 파일** 규칙만 더한다.
 */
function assertTrustedExecutable(
    path: string,
    lstatPath: (path: string) => {
        uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean;
    },
): void {
    const canonical = resolve(path);
    if (canonical !== path) throw new Error('provider exec path must already be canonical');
    // 조상 전체. 여기서 쓰기 가능한 칸이 하나라도 있으면 잎의 소유권은 의미가 없다.
    const deps = {
        getuid: () => 0,
        platform: 'linux' as NodeJS.Platform,
        lstatDir: lstatPath,
    } as unknown as ManagedProvisioningDeps;
    const parent = canonical.slice(0, canonical.lastIndexOf(sep)) || sep;
    const refused = trustedPathRefusal(parent, 0, 'state-dir-unsafe', deps);
    if (refused) throw new Error(`provider exec path is not trusted: ${refused.detail}`);
    // 잎은 디렉터리가 아니므로 위 규칙이 보지 못한다. 같은 기준으로 직접 본다.
    const leaf = lstatPath(canonical);
    if (leaf.isSymbolicLink) throw new Error('provider exec path must not be a symlink');
    if (!leaf.isFile) throw new Error('provider exec path must be a regular file');
    if (leaf.uid !== 0) throw new Error('provider exec path must be owned by root');
    // 0o022 = 그룹/기타 쓰기. 하나라도 있으면 남이 실행 내용을 갈아치울 수 있다.
    if ((leaf.mode & 0o022) !== 0) throw new Error('provider exec path must not be writable by others');
}

/**
 * 실제로 실행된 프로세스의 환경 검사.
 *
 * `sh` 가 `cd` 하면서 더하는 것들(`PWD`·`SHLVL`·`_`·`OLDPWD`)은 허용한다 —
 * 그것들은 계획을 바꾸지 않는다. 그 밖의 추가나 계획 값의 변경은 거부한다.
 */
const SHELL_ADDED_ENV = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

function assertLaunchedEnvironment(
    planned: Record<string, string>,
    actual: Record<string, string>,
): void {
    const missing = Object.keys(planned).filter((key) => actual[key] !== planned[key]);
    const extra = Object.keys(actual).filter((key) => !(key in planned) && !SHELL_ADDED_ENV.has(key));
    if (missing.length > 0 || extra.length > 0) {
        // 값은 자격을 담을 수 있으므로 이름만 말한다.
        throw new Error(
            `the launched process environment is not the plan’s: missing/changed=${missing.join(',')} extra=${extra.join(',')}`,
        );
    }
}

export async function startManagedProviderRun(input: {
    /** 제품이 만든 설정으로 supervisor 를 만든다. 설정을 바꿔 넘길 자리는 없다. */
    createSupervisor: (config: ProviderSupervisorConfig) => ProviderRunSupervisor;
    session: ManagedToolSession;
    key: GenerationKey;
    statusFd: number;
    releaseFd: number;
    leaseExpiresMonotonic: number;
    /** 계획이 요구하는 파일을 쓴다. supervisor 권한으로만 쓰인다. */
    writeFile: (file: { path: string; contents: string; mode: number }) => void;
    /**
     * provider **세대**가 정지되지 않았을 때 알린다. 도구 쪽은 세션이 이미
     * 보고하지만, 세대가 남은 것은 여기서만 알 수 있다.
     */
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    /**
     * 띄운 프로세스의 실제 환경을 읽는다(`/proc/<pid>/environ`).
     *
     * 설정을 제품이 만들어도, 그 설정으로 supervisor 를 **만들어 주는** 것은
     * 호출자다. 그래서 마지막에는 주장이 아니라 실제로 도는 프로세스에서 확인한다.
     */
    readProcEnviron: (pid: number) => Record<string, string>;
    /**
     * 자식에게 물려줄 신뢰 fd. **우리가 만들지 않고 그대로 넘긴다** — B2 부트
     * 봉투처럼 호출자가 이미 신뢰 경계 안에서 연 것들이고, 여기서 해석하거나
     * 늘리지 않는다(§5.36 의 fd 정책 그대로).
     */
    inherit?: Array<{ childFd: number; parentFd: number }>;
    /** 세대 cgroup 루트와 신뢰 helper. supervisor 설정에 그대로 들어간다. */
    cgroupRoot: string;
    helperPath: string;
    /** provider 프로세스가 돌 신원. supervisor 설정에 그대로 들어간다. */
    identity: { provider: { uid: number; gid: number } };
    /**
     * park 된 pid 로 등록을 마친다. **선택 인자가 아니다** — prepare → 등록 →
     * release 계약에서 등록을 건너뛸 수 있으면 그 계약이 아니다. 여기서 던지면
     * 실행되지 않는다.
     */
    register: (pid: number) => Promise<void>;
    /** 생성할 workload 스크립트 경로. helper 가 이것을 execve 한다. */
    workloadPath: string;
    /** provider 실행 파일. 계획의 인자가 여기에 붙는다. */
    execPath: string;
    /**
     * 신뢰 파일인지 확인한다. 절대 경로라는 것만으로는 아무것도 보장되지 않는다 —
     * 링크이거나, root 소유가 아니거나, 남이 쓸 수 있는 파일이면 그 실행은
     * 계획이 정한 것이 아니다. helper 는 자기가 execve 하는 workload 만 보고,
     * 그 workload 가 다시 부르는 이 파일은 보지 못한다.
     */
    lstatPath: (path: string) => {
        uid: number; mode: number; isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean;
    };
}): Promise<ManagedProviderRun> {
    /**
     * 정지는 **양쪽**이다: provider 세대와 그 도구들. 한쪽만 증명된 상태를
     * 캐시하면, 남은 쪽이 살아 있는데 정지로 보고된다.
     */
    let supervisorRef: ProviderRunSupervisor | null = null;
    let provenGeneration: StopOutcome | null = null;
    let provenTools = false;
    let cached: StopOutcome | null = null;
    const stop = async (): Promise<StopOutcome> => {
        if (cached) return cached;
        // 세대가 먼저다. 도구와 provider 가 끝난 뒤에 문을 닫는다.
        // supervisor 를 만들지 못했다면 정지시킬 세대도 없다.
        const generation = provenGeneration
            ?? (supervisor ? supervisor.stopGeneration(input.key) : { stopped: true as const, observedEmptyAt: 0 });
        if (generation.stopped) provenGeneration = generation;
        if (!provenTools) {
            const tools = await input.session.close();
            provenTools = tools.proven;
            if (!tools.proven) {
                // 세대가 정지됐어도 도구가 남아 있으면 정지가 아니다.
                return { stopped: false, detail: 'tools-still-populated' };
            }
        }
        if (!generation.stopped) {
            // 세대가 남았다. 콜백으로 알리고, 실패를 그대로 돌려준다.
            input.onUnprovenTermination({ tool: 'provider-generation', detail: generation.detail });
            return generation;
        }
        cached = generation;
        return generation;
    };

    /*
     * 정책 파일과 실행 정의는 **prepare 보다 먼저** 쓴다. 신뢰 helper 는 인자
     * 검사 단계에서 workload 파일 자체를 확인하므로(§5.36), park 이후에 쓰면
     * 그 검사가 없는 파일을 보고 거부한다. 그리고 어차피 release 보다 앞이다.
     */
    /*
     * supervisor 는 **계획에서** 만든다. 실행 환경·workload·신원이 계획과
     * 갈라질 자리를 남기지 않는다. 만드는 것 자체가 실패할 수 있으므로 정리
     * 범위 안에 둔다 — 밖에 두면 이미 연 broker 와 grant 가 남는다.
     */
    /** 실패를 던지되 정리 결과와 재시도 수단을 함께 남긴다. */
    const failWith = async (error: unknown): Promise<never> => {
        const stopOutcome = await stop();
        throw new ManagedProviderLaunchError(
            error instanceof Error ? error : new Error(String(error)),
            { stopOutcome, stop, key: input.key },
        );
    };

    let supervisor: ProviderRunSupervisor;
    try {
        supervisor = input.createSupervisor({
            cgroupRoot: input.cgroupRoot,
            helperPath: input.helperPath,
            workloadPath: input.workloadPath,
            envAllowlist: input.session.providerPlan.env,
            resolveGenerationCredentials: () => input.identity.provider,
        });
        assertTrustedExecutable(input.execPath, input.lstatPath);
        for (const file of input.session.providerPlan.files) input.writeFile(file);
        input.writeFile(providerWorkloadScript({
            path: input.workloadPath,
            execPath: input.execPath,
            args: input.session.providerPlan.args,
            cwd: input.session.providerPlan.cwd,
        }));
    } catch (error) {
        // 파일을 쓰지 못했으면 실행은 없다. 열어 둔 broker 와 grant 도 없어야 한다.
        return failWith(error);
    }

    let envRefusal: Error | null = null;
    let outcome: ExecOutcome;
    /*
     * 한 번만 기록한다. 세대는 하나이고 프로세스는 한 번 끝난다 — 뒤에 오는
     * 무엇이 첫 관측을 덮으면, 기록은 커널이 말한 것이 아니게 된다.
     */
    let observed: ObservedProviderExit | null = null;
    /** 통로가 열렸으면 그 쓰기 쪽. 없으면 우아한 정지는 불가능하다. */
    let controlWriter: { write: (text: string) => void } | null = null;
    /**
     * 세대 cgroup 을 **건드리지 않고** 읽는다.
     *
     * `unreadable` 은 `populated` 와 같은 결론(거절)으로 가지만 이유가 다르다.
     * 읽지 못한 것을 비었다고 접는 것이 아무도 안 본 정적을 보고하는 길이다.
     */
    const observeGenerationPopulation = (): 'empty' | 'populated' | 'events-unreadable' => {
        try {
            const events = readFileSync(
                join(generationCgroupPath(input.cgroupRoot, input.key), 'cgroup.events'),
                'utf8',
            );
            return /^populated 0$/m.test(events) ? 'empty' : 'populated';
        } catch (error) {
            // 커널이 지운 cgroup 은 비어 있었다는 뜻이다. 그것만 관측이다.
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'empty';
            return 'events-unreadable';
        }
    };
    /** 자식이 말한 결말. `null` 은 '아직 말하지 않았다' 이다. */
    let ackVerdict: string | null = null;
    /**
     * The native session this generation said it wrote, once.
     *
     * Separate from `ackVerdict` because the two can disagree across frames and
     * each disagreement means something different: a second verdict is a peer
     * repeating itself, a second *identity* is a peer claiming this generation
     * wrote two sessions. `identityConflict` remembers the latter so nothing
     * downstream reads a first-come id as authoritative.
     */
    let ackNativeId: string | null = null;
    let identityConflict = false;
    try {
        outcome = await supervisor.execGeneration({
            key: input.key,
            inherit: input.inherit,
            statusFd: input.statusFd,
            releaseFd: input.releaseFd,
            leaseExpiresMonotonic: input.leaseExpiresMonotonic,
            /*
             * park 된 뒤, **놓아주기 전에** 확인하고 등록한다.
             *
             * 환경 검사가 release 뒤에 있으면 잘못된 env 를 사후에 알게 되고 그
             * 사이 사용자 코드가 이미 돈다. park 상태의 자식은 아직 execve 전이지만
             * 그 environ 이 곧 실행될 환경이다(execve 는 환경을 물려준다).
             */
            controlFds: [MANAGED_CONTROL_CHILD_FD],
            onControlWriters: (writers) => {
                const writer = writers.get(MANAGED_CONTROL_CHILD_FD) ?? null;
                controlWriter = writer;
                // 같은 descriptor 가 양방향이다(Node 의 추가 stdio pipe 는
                // socketpair). 답이 오면 여기서 받는다.
                const readable = writer as unknown as {
                    on?: (event: string, handler: (chunk: Buffer | string) => void) => unknown;
                } | null;
                /*
                 * 프레이밍은 reader 에게 맡긴다. 여기서 chunk 를 직접 자르면
                 * 두 번째 파서가 되고, 그 파서는 `ended exhausted-cle` 처럼
                 * **잘린 토큰도 통과시킨다** — 그리고 첫 답이 이기므로 그
                 * 잘린 값이 영구히 남는다. 프레임 하나가 두 chunk 에 걸리면
                 * 답 자체가 사라지기도 한다.
                 */
                if (readable?.on) {
                    readManagedControlChannel({
                        source: readable as never,
                        // supervisor 쪽 끝이다. 여기로 오는 `stop` 은 자식이
                        // 보낸 것이 아니므로 아무것도 하지 않는다.
                        onStop: () => undefined,
                        onAck: (ack) => {
                            /*
                             * 첫 답만. 뒤에 오는 것이 첫 답을 덮으면 기록은
                             * 자식이 말한 것이 아니게 된다.
                             *
                             * 같은 프레임이 다시 오는 것(중복)은 무해하므로
                             * 무시한다. 다른 native ID 가 오는 것(충돌)은
                             * 다르다 — 한 세대가 두 세션을 썼다는 주장이고,
                             * 둘 중 어느 쪽도 믿을 수 없다. 그래서 신원을
                             * 버리고 충돌을 기억한다. verdict 는 첫 답 그대로
                             * 두어 종료 판정이 신원 때문에 바뀌지 않게 한다.
                             */
                            if (ackVerdict === null) {
                                ackVerdict = ack.verdict;
                                ackNativeId = ack.nativeId;
                                return;
                            }
                            /*
                             * 충돌은 되돌릴 수 없다. 한 번 모순된 쌍을 말한
                             * 자식이 그 뒤에 어느 한쪽을 다시 말해도 그것이
                             * 맞다는 증거가 되지 않는다 — 마지막 프레임을
                             * 채택하면 순서만 바꿔도 결론이 바뀐다.
                             */
                            if (identityConflict) return;
                            /*
                             * 프레임 하나가 관측 하나다. 그러니 **같은 세션에
                             * 다른 verdict** 도 다른 세션만큼이나 모순이다 —
                             * 신원을 남겨 두면 자식 스스로 동의하지 않는 쌍이
                             * 승인한 세션을 아래로 넘기게 된다.
                             */
                            // 아무도 신원을 말하지 않았다면 오염시킬 신원이
                            // 없다. 모순된 verdict 는 '첫 답만' 규칙이 이미
                            // 처리하며, 없는 주장을 충돌로 적지 않는다.
                            if (ack.nativeId === null && ackNativeId === null) return;
                            /*
                             * 철자까지 같아야 같은 세션이다.
                             *
                             * 예전에는 대소문자를 접었다 — "case is not
                             * identity" 는 UUID 를 **숫자로** 볼 때의 이야기이고,
                             * provider 가 디스크에 무엇을 쓰는지에 대한 증거가
                             * 아니다. Claude 가 `ABCDEF…` 와 `abcdef…` 를 한
                             * 세션으로 취급한다는 근거는 없고, 아래쪽은 전부
                             * 정확히 비교한다: derivation 은 참조 경로를 문자
                             * 단위로 맞추고, transcript 는 한 가지 철자로 적힌
                             * 경로에 있다.
                             *
                             * 그래서 두 층이 어긋나 있었다 — ack 는 "같은 세션"
                             * 이라고 하고 경로 층은 없는 파일을 찾는다. 다른
                             * 철자는 자식이 어느 세션을 썼는지에 대해 스스로
                             * 모순된 것이며, 그것은 충돌이다.
                             */
                            const sameSession = ack.nativeId === null || ackNativeId === null
                                ? false
                                : ack.nativeId === ackNativeId;
                            if (ack.verdict !== ackVerdict || !sameSession) {
                                identityConflict = true;
                                ackNativeId = null;
                            }
                        },
                    });
                }
            },
            onExit: (exit) => {
                if (observed === null) observed = exit;
            },
            onAcquired: async (pid) => {
                try {
                    assertLaunchedEnvironment(
                        input.session.providerPlan.env,
                        input.readProcEnviron(pid),
                    );
                } catch (error) {
                    /*
                     * supervisor 는 여기서 던진 것을 붙잡아 park 를 abort 하고
                     * 실행하지 않는다(그게 우리가 원하는 것이다). 다만 그러면
                     * 이유가 outcome 에 남지 않으므로 붙들어 두었다가 아래에서
                     * 그대로 올린다.
                     */
                    envRefusal = error as Error;
                    throw error;
                }
                await input.register(pid);
            },
        });
    } catch (error) {
        return failWith(envRefusal ?? error);
    }
    if (envRefusal) {
        // 계획과 다른 환경이었다. 실행되지 않았고, 이유를 그대로 올린다.
        return failWith(envRefusal);
    }
    if (outcome.kind !== 'exec-attempted') {
        // 실행되지 않았다. 열어 둔 broker 와 grant 를 그대로 두지 않는다.
        await stop();
    }
    return {
        outcome,
        stop,
        observedExit: () => observed,
        async awaitGracefulStop(budgetMs) {
            if (!controlWriter) return { stopped: false, detail: 'no-channel' };
            try {
                controlWriter.write(managedStopRequest());
            } catch {
                return { stopped: false, detail: 'no-channel' };
            }
            const deadline = Date.now() + budgetMs;
            while (Date.now() < deadline) {
                if (ackVerdict !== null && observed !== null) break;
                await new Promise((resolve) => { setTimeout(resolve, 25).unref?.(); });
            }
            // 답이 없으면 timeout 이다. 없는 답을 깨끗하다고 읽지 않는다.
            if (ackVerdict === null) return { stopped: false, detail: 'timeout' };
            if (ackVerdict !== MANAGED_STOP_CLEAN) return { stopped: false, detail: ackVerdict };
            // ack 는 '곧 나간다' 이고, 이것이 '나갔다' 이다.
            if (observed === null) return { stopped: false, detail: 'exit-unobserved' };
            if (observed.signal !== null || observed.code !== 0) {
                /*
                 * The kernel's own two values, recorded as they are.
                 *
                 * `exit-unclean` says the exit was not a flush; it does not
                 * say whether something signalled the generation or whether it
                 * chose a non-zero status, and those have different causes.
                 * Both are kernel facts — a number and a signal name — so
                 * neither carries anything of the provider's.
                 */
                logger.debug(
                    `[managed] generation exit code=${observed.code ?? 'null'} `
                    + `signal=${observed.signal ?? 'none'}`,
                );
                return { stopped: false, detail: 'exit-unclean' };
            }
            /*
             * 마지막으로 빈 cgroup — **읽기만 한다.**
             *
             * `stop()` 은 `cgroup.kill` 로 비움을 만들어 내고 도구 경계까지
             * 거둔다. 그것으로 증명을 만들면 "아직 쓰고 있는 손자를 죽여서
             * 조용해졌으니 조용하다" 가 된다. 살아 있는 writer 는 거절해야 할
             * 사실이지, 없애야 할 장애물이 아니다.
             */
            const population = observeGenerationPopulation();
            if (population !== 'empty') return { stopped: false, detail: population };
            /*
             * 신원은 **성공의 조건이 아니다.**
             *
             * 이 증분은 무엇이 저장될 수 있는지를 넓히지 않는다. 신원이 없거나
             * 충돌해도 이 세대는 여전히 깨끗하게 끝난 것이고, 그 판정은 EOF ·
             * exit code · signal · writer 관측이 그대로 결정한다. 신원은 그
             * 판정에 **동반되는 관측**이며, 없으면 없다고 말한다.
             */
            return {
                stopped: true,
                detail: 'stopped',
                ...(ackNativeId === null ? {} : { nativeId: ackNativeId }),
                ...(identityConflict ? { identity: 'conflict' as const } : {}),
            };
        },
        requestGracefulStop: () => {
            if (!controlWriter) return false;
            try {
                controlWriter.write(managedStopRequest());
                return true;
            } catch {
                // 통로가 끊겼다. 청하지 못한 것을 청했다고 말하지 않는다.
                return false;
            }
        },
    };
}
