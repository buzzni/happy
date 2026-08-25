/**
 * aplus §6-1 dataKey 온보딩 (specs/e2ee-datakey-onboarding).
 *
 * 신규 머신(로컬 세션 이력 0)의 dataKey 계정 credential 을 auth 시점에
 * dataKey-활성으로 자동 승격한다 — §6-1 의 보안 이득을 실사용자에게
 * 전달하는 배선. 전환 spec 의 "자동 전환 금지"는 **기존 세션 보유 머신**
 * 을 겨냥한 것이고, 세션 0 인 신규 머신은 그 위험(기존 세션과 활성 키
 * 분리)이 없다.
 *
 * planDataKeyOnboarding 은 순수하다 — 파일을 쓰지 않고 산출물만 반환하므로
 * 게이트 미충족 시 credential 무변경(best-effort no-op)이 구조적으로
 * 성립한다. 실제 쓰기는 auth 계층이 ok 결과에서만 수행한다.
 */
import type { Credentials } from '@/persistence'
import { serializeProvisionedLegacyCredentials } from '@/persistence'
import { encodeBase64 } from '@/api/encryption'

export type OnboardingSkipReason =
  | 'not-provisioned'
  | 'no-account-key'
  | 'already-datakey'
  | 'has-local-sessions'
  | 'account-key-mismatch'

export type SerializedDataKeyCredentials = {
  token: string
  encryption: { publicKey: string; machineKey: string }
}

export type OnboardingResult =
  | { ok: true; serialized: SerializedDataKeyCredentials; backup: unknown }
  | { ok: false; reason: OnboardingSkipReason }

export function planDataKeyOnboarding(input: {
  credentials: Credentials
  accountPublicKey: string | null
  hasLocalSessions: boolean
}): OnboardingResult {
  const enc = input.credentials.encryption
  if (enc.type === 'dataKey') return { ok: false, reason: 'already-datakey' }
  if (!enc.provisioned) return { ok: false, reason: 'not-provisioned' }
  if (!input.accountPublicKey) return { ok: false, reason: 'no-account-key' }
  // 기존 세션이 있는 머신은 전환하지 않는다 — 그 세션들은 legacy 로
  // 만들어졌고, 활성 키가 갈라지면 혼동이 생긴다(전환 spec D1 의 위험).
  if (input.hasLocalSessions) return { ok: false, reason: 'has-local-sessions' }
  // settings 의 accountPublicKey 와 병기 재료의 공개키가 어긋나면 승격하지
  // 않는다 — 재인증/계정 교체 잔재로 엉뚱한 수신자에게 wrap 되는 것 방지.
  if (encodeBase64(enc.provisioned.publicKey) !== input.accountPublicKey) {
    return { ok: false, reason: 'account-key-mismatch' }
  }

  return {
    ok: true,
    serialized: {
      token: input.credentials.token,
      encryption: {
        publicKey: encodeBase64(enc.provisioned.publicKey),
        machineKey: encodeBase64(enc.provisioned.machineKey),
      },
    },
    // 원본 legacy(+병기) 를 그대로 백업해 deactivate 가 바이트 동일 복원.
    backup: serializeProvisionedLegacyCredentials({
      token: input.credentials.token,
      secret: enc.secret,
      publicKey: enc.provisioned.publicKey,
      machineKey: enc.provisioned.machineKey,
    }),
  }
}
