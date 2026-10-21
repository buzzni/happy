import { confirmDeviceOrganization, getDeviceApprovalStatus, useDeviceAsShared } from '@/daemon/controlClient';

type Status = { machineId: string; companyId: string; enrollment: null | { digest: string; expiresAt: number; locallyConfirmed: boolean; administratorApproved: boolean }; pin: null | { policy: string } };
type Deps = { status: (companyId: string) => Promise<Status>; confirm: (input: { companyId: string; machineId: string; enrollmentDigest: string }) => Promise<{ locallyConfirmed: boolean }>; print: (text: string) => void;
    useAsShared?: (companyId: string) => Promise<{ accepted: true; confirmed: boolean }> };
const usage = 'happy device status --company-id ID | happy device confirm --company-id ID --machine-id ID --digest FULL_SHA256 | happy device use-as-shared --company-id ID';
export async function handleDeviceCommand(args: string[], deps: Deps = { status: getDeviceApprovalStatus, confirm: confirmDeviceOrganization, print: console.log, useAsShared: useDeviceAsShared }): Promise<void> {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) { deps.print(usage); return; }
    const command = args[0];
    if (command !== 'status' && command !== 'confirm' && command !== 'use-as-shared') throw new Error(usage);
    const allowed = command === 'confirm' ? ['--company-id', '--machine-id', '--digest'] : ['--company-id'];
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
        const key = args[i], value = args[i + 1];
        if (!allowed.includes(key) || values.has(key) || !value || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(usage);
        values.set(key, value);
    }
    if (values.size !== allowed.length) throw new Error(usage);
    const companyId = values.get('--company-id')!;
    if (command === 'use-as-shared') {
        // aplus specs/shared-machine-server-signing S6b — the PC still pins only the key its trusted Studio origin serves.
        let result: { accepted: true; confirmed: boolean };
        try { result = await (deps.useAsShared ?? useDeviceAsShared)(companyId); } catch (error) {
            if (error instanceof Error && error.message === 'DEVICE_USE_AS_SHARED_REFUSED')
                throw new Error('이미 공용·전용으로 표시된 PC이거나, 이 PC를 기다리는 공용 기기 승인이 없습니다. status로 상태를 확인하세요.');
            throw new Error('DEVICE_CONTROL_UNAVAILABLE');
        }
        deps.print(result.confirmed
            ? '이 PC를 조직 공용 PC로 사용합니다. 조직 키가 저장되었습니다.'
            : '이 PC를 조직 공용 PC로 표시했습니다. 서버 승인이 오면 자동으로 확인됩니다.');
        return;
    }
    if (command === 'confirm') {
        const enrollmentDigest = values.get('--digest')!;
        if (!/^[a-f0-9]{64}$/.test(enrollmentDigest)) throw new Error(usage);
        try {
            const result = await deps.confirm({ companyId, machineId: values.get('--machine-id')!, enrollmentDigest });
            if (result.locallyConfirmed !== true) throw new Error('not confirmed');
        } catch { throw new Error('DEVICE_CONTROL_UNAVAILABLE'); }
        deps.print('로컬 확인이 완료되었습니다. 관리자 승인과 영속 정책 적용 상태는 status로 확인하세요.');
        return;
    }
    let status: Status;
    try { status = await deps.status(companyId); } catch { throw new Error('DEVICE_CONTROL_UNAVAILABLE'); }
    deps.print(`조직: ${status.companyId}\n머신: ${status.machineId}`);
    if (status.pin) { deps.print('조직 키와 signed-required 정책이 저장되어 있습니다.'); return; }
    if (!status.enrollment) { deps.print('유효한 기기 등록 요청이 없습니다.'); return; }
    const enrollment = status.enrollment;
    if (!/^[a-f0-9]{64}$/.test(enrollment.digest)) throw new Error('DEVICE_CONTROL_UNAVAILABLE');
    deps.print(`전체 확인 지문: ${enrollment.digest.match(/.{4}/g)!.join(' ')}\n만료: ${new Date(enrollment.expiresAt).toISOString()}`);
    deps.print(enrollment.administratorApproved ? '관리자 승인 확인됨' : '관리자 승인 대기');
    deps.print(enrollment.locallyConfirmed ? '로컬 확인됨' : '로컬 확인 대기');
    deps.print('관리자와 별도의 신뢰할 수 있는 경로로 지문 전체를 대조한 뒤 confirm을 실행하세요.');
}
