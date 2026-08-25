/**
 * 자동화의 서버 왕복이 거절당했을 때, 응답 본문의 사유만 뽑아 로그에 붙인다.
 *
 * 서버는 같은 상태 코드를 여러 이유로 낸다(예: `/api/automation/github-credential`
 * 의 403 은 claim·머신 접근·프로젝트 접근·저장소 미연결·credential 접근 다섯
 * 가지). status 만 남기면 운영자가 어느 검사에서 막혔는지 좁힐 수 없다.
 *
 * 성공 응답은 PAT 을 담으므로 이 함수는 **거절 응답에만** 쓰고, 본문에서 `error`
 * 문자열 외에는 아무것도 읽지 않는다.
 */
const REASON_MAX_CHARS = 200

export async function describeHttpFailure(response: Response): Promise<string> {
  try {
    return describeHttpFailureBody(await response.json())
  } catch {
    return ''
  }
}

/**
 * 본문을 이미 읽은 호출부용. Response 는 한 번만 읽을 수 있으므로, 상태 코드 분기
 * 등으로 본문을 먼저 파싱했다면 그 값을 그대로 넘긴다.
 */
export function describeHttpFailureBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const reason = (body as { error?: unknown }).error
  if (typeof reason !== 'string') return ''
  const collapsed = reason.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > REASON_MAX_CHARS
    ? `: ${collapsed.slice(0, REASON_MAX_CHARS)}…`
    : `: ${collapsed}`
}
