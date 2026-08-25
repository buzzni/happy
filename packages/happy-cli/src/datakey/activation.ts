/**
 * aplus §6-1 CLI dataKey-활성 전환 로직 (specs/e2ee-cli-datakey-activation).
 *
 * 활성 판별은 access.key 의 파싱 결과다(persistence.parseCredentials —
 * secret-first): secret 이 있으면 legacy-활성, 없이 encryption 만 있으면
 * dataKey-활성. 전환은 "secret 을 제거한 dataKey 포맷으로 재작성"이고,
 * 원본은 백업 파일로 보존해 deactivate 가 바이트 동일 상태로 복원한다.
 *
 * 이 모듈의 plan 함수들은 순수하다 — 어떤 파일도 쓰지 않고 "무엇을 쓸지"
 * 만 반환한다. 게이트가 하나라도 실패하면 ok:false 만 반환하므로
 * credential 무변경(fail-closed, AC3)이 구조적으로 성립하고, 실제 쓰기는
 * command 계층(commands/datakey.ts)이 ok 결과에서만 수행한다.
 *
 * 기존 세션은 안전하다: PersistedSession 이 세션별 encryptionKey/variant 를
 * 로컬 보존하므로 전환 후에도 legacy 세션 resume 은 자기 키로 동작한다.
 */
import { parseCredentials } from '@/persistence'
import { encodeBase64 } from '@/api/encryption'

export type ActivationGateFailure =
  | 'no-credentials'
  | 'already-datakey'
  | 'not-provisioned'
  | 'no-machine-id'
  | 'server-envelope-missing'
  | 'server-unreachable'

export type SerializedDataKeyCredentials = {
  token: string
  encryption: { publicKey: string; machineKey: string }
}

export type ActivateResult =
  | { ok: true; serialized: SerializedDataKeyCredentials; backup: unknown }
  | { ok: false; reason: ActivationGateFailure }

/**
 * D2 검증 게이트를 전부 통과했을 때만 전환 산출물을 반환한다.
 *
 * 서버 봉투 확인의 한계(문서화): 봉투는 계정 공개키 수신자라 CLI 는
 * 내용을 열어 로컬 machineKey 와 대조할 수 없다 — 존재 확인까지가
 * "가능한 범위"다. 서버 확인이 실패(네트워크·5xx)하면 전환하지 않는다.
 */
export async function planDataKeyActivation(input: {
  rawCredentials: unknown | null
  machineId: string | null
  /** 서버 machine 레코드의 dataEncryptionKey(base64) 또는 null. throw = 확인 불가. */
  fetchServerEnvelope: (machineId: string) => Promise<string | null>
}): Promise<ActivateResult> {
  const credentials = input.rawCredentials === null ? null : parseCredentials(input.rawCredentials)
  if (!credentials) return { ok: false, reason: 'no-credentials' }
  if (credentials.encryption.type === 'dataKey') return { ok: false, reason: 'already-datakey' }
  const provisioned = credentials.encryption.provisioned
  if (!provisioned) return { ok: false, reason: 'not-provisioned' }
  if (!input.machineId) return { ok: false, reason: 'no-machine-id' }

  let envelope: string | null
  try {
    envelope = await input.fetchServerEnvelope(input.machineId)
  } catch {
    return { ok: false, reason: 'server-unreachable' }
  }
  if (!envelope) return { ok: false, reason: 'server-envelope-missing' }

  return {
    ok: true,
    serialized: {
      token: credentials.token,
      encryption: {
        publicKey: encodeBase64(provisioned.publicKey),
        machineKey: encodeBase64(provisioned.machineKey),
      },
    },
    backup: input.rawCredentials,
  }
}

export type DeactivateResult =
  | { ok: true; restored: unknown }
  | { ok: false; reason: 'not-datakey' | 'no-backup' | 'backup-invalid' }

/** 백업(legacy 포맷)이 있고 현재가 dataKey-활성일 때만 복원 산출물을 반환. */
export function planDataKeyDeactivation(input: {
  rawCredentials: unknown | null
  rawBackup: unknown | null
}): DeactivateResult {
  const current = input.rawCredentials === null ? null : parseCredentials(input.rawCredentials)
  if (!current || current.encryption.type !== 'dataKey') {
    return { ok: false, reason: 'not-datakey' }
  }
  if (input.rawBackup === null) return { ok: false, reason: 'no-backup' }
  const backup = parseCredentials(input.rawBackup)
  if (!backup || backup.encryption.type !== 'legacy') {
    return { ok: false, reason: 'backup-invalid' }
  }
  return { ok: true, restored: input.rawBackup }
}

export type DataKeyStatus = {
  variant: 'none' | 'legacy' | 'legacy-provisioned' | 'dataKey'
  hasBackup: boolean
}

export function describeDataKeyStatus(input: {
  rawCredentials: unknown | null
  rawBackup: unknown | null
}): DataKeyStatus {
  const credentials = input.rawCredentials === null ? null : parseCredentials(input.rawCredentials)
  const hasBackup = input.rawBackup !== null
  if (!credentials) return { variant: 'none', hasBackup }
  if (credentials.encryption.type === 'dataKey') return { variant: 'dataKey', hasBackup }
  return {
    variant: credentials.encryption.provisioned ? 'legacy-provisioned' : 'legacy',
    hasBackup,
  }
}
