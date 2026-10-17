/**
 * AgentTask 워커가 프로토콜 요청을 보낼 때 쓰는 POSIX sh 클라이언트.
 *
 * 2026-10-17 프로덕션 — 지시문에 "POST /complete with version=1, token=…" 라고
 * 적어 두었는데도 워커 4건이 curl 을 손으로 짜며 결과 JSON 만 본문으로 보냈다.
 * /complete 는 400 UNSUPPORTED_VERSION 으로 거절됐고, 4xx 는 재시도하지 않는
 * 규칙대로 끝낸 리뷰가 그대로 버려졌다. 토큰을 실은 방식도 실행마다 달랐다.
 * 봉투를 매 실행 모델의 즉흥 구현에 맡긴 구조가 원인이라, 봉투(version·token·
 * agentRunId·idempotencyKey)는 이 스크립트가 채우고 워커는 result 파일만 만든다.
 *
 * 데몬은 이 본문을 APLUS_AGENT_TASK_CLIENT 로 넘기고 워커는
 * `sh -c "$APLUS_AGENT_TASK_CLIENT" agent-task <action> …` 로 실행한다. 파일로
 * 두지 않는 이유: pr_review 샌드박스는 데몬 홈을 읽지 못하고, 공용 /tmp 의 파일은
 * 다른 사용자가 바꿔치기할 수 있으며, 세션보다 먼저 지울 시점도 없다.
 *
 * 전송은 기존 지시가 검증해 온 curl --data-binary 그대로다. 샌드박스는
 * HTTP(S)_PROXY 로 네트워크를 내보내는데 curl 은 그것을 따르고 Node fetch 는
 * 따르지 않는다. 본문은 stdin 으로 흘려 보낸다 — 명령행 인자에 실으면 토큰이 ps 로
 * 보이고, 임시 파일은 쓰기 가능한 TMPDIR 이 없는 샌드박스에서 제출 자체를 막는다.
 *
 * run.ts 의 spawnSession 이 env 값의 `${VAR}` 를 데몬 환경으로 확장하므로 이
 * 스크립트는 그 문법을 쓰지 않는다 (테스트가 고정한다).
 */
export const AGENT_TASK_CLIENT_SCRIPT = `
usage() { printf 'agent-task: %s\\n' "$1" >&2; exit 2; }
[ "$#" -ge 1 ] || usage 'usage: start | heartbeat | complete <result.json> | fail <reason>'
for name in APLUS_AGENT_TASK_URL APLUS_AGENT_TASK_ID APLUS_AGENT_TASK_RUN_ID APLUS_AGENT_TASK_CLAIM_TOKEN APLUS_AGENT_TASK_COMPLETE_TOKEN; do
  eval "value=\\$$name"
  [ -n "$value" ] || usage "$name is not set"
  [ "$name" = APLUS_AGENT_TASK_URL ] && continue
  case $value in *[!A-Za-z0-9._~:-]*) usage "$name has characters this client cannot send verbatim" ;; esac
done
action=$1
token=$APLUS_AGENT_TASK_CLAIM_TOKEN
fields=''
case $action in
  start|heartbeat) ;;
  complete)
    [ "$#" -eq 2 ] || usage 'complete needs the path of the result JSON file'
    [ -s "$2" ] && [ -r "$2" ] || usage "result file is missing, empty, or unreadable: $2"
    result_file=$2
    token=$APLUS_AGENT_TASK_COMPLETE_TOKEN ;;
  fail)
    [ "$#" -eq 2 ] && [ -n "$2" ] || usage 'fail needs a reason'
    token=$APLUS_AGENT_TASK_COMPLETE_TOKEN
    reason=$(printf '%s' "$2" | LC_ALL=C tr '[:cntrl:]' ' ' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
    fields=",\\"reason\\":\\"$reason\\"" ;;
  *) usage "unknown action: $action" ;;
esac
body() {
  printf '{"version":1,"token":"%s","agentRunId":"%s","idempotencyKey":"%s:%s"%s' \\
    "$token" "$APLUS_AGENT_TASK_RUN_ID" "$APLUS_AGENT_TASK_RUN_ID" "$action" "$fields"
  if [ "$action" = complete ]; then printf ',"result":'; cat "$result_file"; fi
  printf '}'
}
url="$APLUS_AGENT_TASK_URL/$APLUS_AGENT_TASK_ID/$action"
attempt=1
while :; do
  output=$(body | curl -sS --max-time 30 -w '\\n%{http_code}' -H 'Content-Type: application/json' --data-binary @- "$url")
  status=$(printf '%s\\n' "$output" | tail -n 1)
  response=$(printf '%s\\n' "$output" | sed '$d')
  case $status in
    2??) printf 'HTTP %s\\n%s\\n' "$status" "$response"; exit 0 ;;
    4??) printf 'HTTP %s (not retried)\\n%s\\n' "$status" "$response"; exit 1 ;;
  esac
  if [ "$attempt" -ge 3 ]; then
    printf 'agent-task: %s failed after %s attempts (last HTTP status %s)\\n%s\\n' "$action" "$attempt" "$status" "$response"
    exit 1
  fi
  sleep $((attempt * 2))
  attempt=$((attempt + 1))
done
`
