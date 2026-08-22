# context — daemon-rpc-ack-guard

## 현재 상태

Phase 1~5 완료. 브랜치 `fix/rpc-request-ack-guard`.

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `src/api/rpc/rpcRequestListener.ts` | 신규 | 가드가 들어간 공통 `rpc-request` 리스너 |
| `src/api/rpc/rpcRequestListener.test.ts` | 신규 | 재현 + 회귀 테스트 7건 |
| `src/api/apiMachine.ts` | 동작 | 공통 리스너 사용, 이벤트 타입 `callback?` |
| `src/api/apiSession.ts` | 동작 | 공통 리스너 사용 |
| `src/api/types.ts` | 동작 | `ServerToClientEvents` 의 `callback?` |

## 검증 기준선 (이 환경)

워크트리 테스트는 `node_modules` 를 소스 저장소에서 심볼릭 링크해 돌렸다.
`@slopus/happy-wire` 가 미빌드라 tsc 에 사전 오류 45건이 존재한다 —
origin/main detached 워크트리와 1:1 대조해 **신규 오류 0** 을 확인했다.

- tsc: 45 errors (기준선 45, 차이는 import 추가로 인한 줄번호 이동뿐)
- unit: 38 failed / 1813 passed (기준선과 실패 목록 완전 동일, 대부분 ripgrep/dist 환경 이슈)

## 남은 것 / 후속 판단거리

- ack 누락의 서버측 원인은 미규명. 재현되면 happy-server `rpcHandler` 로그 필요.
- 재연결 직후 RPC 폭주(1초 633 bash) 자체는 그대로다. 이번 가드는 그로 인한
  daemon 사망만 막는다. 백프레셔는 별도 판단거리.
- `daemon/run.ts` 의 unhandledRejection 정책은 의도적으로 두었다 (spec 비목표).
