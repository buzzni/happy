# T1c-b2 H2 owner contact — 부분 구현, 미완료

2026-10-30. H1의 wire/codec과 Desktop p0a-contract §2.3/4.4–4.6/7.1을 사용한다.
Core의 기존 인증·세션 제어 경계이며 계약 변경은 하지 않았다. 이 문서는 H2 완료 기록이 아니다.

## 구현한 범위

- `daemon/agentCallerBinding.ts`: 신뢰한 내부 호출자가 실제 runtimeId를 전달할 수 있다.
  기존 owned-spawn 호출의 생성을 바꾸지 않도록 생략 시 기존 UUID 동작을 유지한다.
  H1 codec으로 서명하는 `signRelay`는 키를 반환하지 않으며 비동기 서명 뒤에도 현재 binding을 검사한다.
  `revokeBinding`은 이전 host의 close가 재개된 새 binding을 폐기하지 않도록 한다.
- `daemon/sessionOwnerContact.ts`: source를 고정한 내부 typed port. `enabled`는 기본 false다.
  OFF 호출은 lookup/전송 없이 거부한다. shell/provider env는 읽지 않는다.
  machine/source/account 제한 lookup, pinned issuer/audience/key의 contact 서명·기한·전체 caller 결속,
  현재 등록/철회 조회, H1 request 서명과 reply 검증을 사용한다. 새 nonce는 32 random bytes다.
  source binding은 await 경계마다 검사한다. 원격 오류 내용은 CLI에 반환하지 않는다.
  요청/응답 snapshot 및 H1 크기 제한, 20초 deadline, 종료 취소를 적용한다.
  같은 요청에서 다른 main으로 재시도하지 않으며 유효 후보는 desktopInstanceId 순서로 고정한다.
- `commands/agentHostProcess.ts`와 `sessionAgentBroker.ts`: 선택적으로 주입한 port를 bundled CLI의
  private Node IPC `owner-contact-v1`에 연결한다. envelope는 `{type,requestId,request}`이고 request는
  H1 `OwnerContactRequestSchema`다. 결과는 `{type:'owner-contact-v1-result',requestId,reply}` 또는
  동일 envelope의 `error:'owner-contact-unavailable'`다. 기존 `{version:1,argv}` protocol은 변경하지 않는다.

A+/Desktop 동작은 `lookup`, `currentContact`, `exchange` 주입 port로 테스트한다.
`exchange`의 구현은 source DEK에 결속된 Happy RPC여야 한다. 현재 실제 네트워크 adapter는 없다.
비밀키는 기존 registry closure에 남는다. 서버 trust root나 source authority를 요청에서 받지 않는다.

## 남은 H2 — 완료로 처리하지 말 것

1. 실제 생성/재개 시점에서 daemon과 broker/직접 host를 잇는 private bootstrap. 현재
   `ownedSpawnRuntime.callerBinding`은 owned journal에만 한정된다. 일반 source를 그 journal에
   가짜로 추가하거나 webhook metadata/env/workspace ledger를 authority로 승격하지 않았다.
2. `api/apiSession.ts`의 실제 session/runtime 수명주기와 위 registry/port의 연결. `runtimeId` 입력을
   지원한다는 사실은 실제 launch에서 공급된다는 뜻이 아니다. 현재 production에서 새 port를 생성하는 호출부는 없다.
3. Gemini/opencode/grok 직접 runtime의 별도 local transport와 CLI discovery, source/entry 정책 연결.
   broker private IPC만으로 직접 경로의 지원을 주장하지 않는다. 아래 후속 local transport 모듈은 추가됐지만
   실제 runtime 연결과 실소켓 수락은 아직 남아 있다.
4. trust 설정·machine 인증 lookup·source-DEK RPC의 host assembly와 default-off rollout switch 연결.
   현재 `enabled`는 내부 주입 옵션이며 제품 설정/env 스위치가 아니다.
5. 실제 생성/재개 bootstrap, 제한 lookup의 read ACL/depth 정책, 키 비노출 경계, 기존 read/후손
   통합 회귀 및 관련 provider 소비자 테스트. 현재 테스트는 내부 port와 기존 broker만 다룬다.

D1/A1/H3는 구현하지 않았다. 위 미완료를 그 작업들로 떠넘기거나 계약의 공백으로 단정하지 않는다.
계약 변경 필요성이 확인된 항목은 없다. 남은 사항은 H2 구현 작업이다.

## 검증

- 신규 모듈/actual runtime 입력 없는 상태의 타입 검사 실패를 먼저 확인했다.
- 내부 contact 실행 회귀에서 4 실패/18 통과/1 skip을 확인한 뒤 nonce 생성과 obsolete close를 수정했다.
- private IPC 회귀는 연결 전 timeout으로 실패했고 연결 후 재검증한다.
- 전체 테스트는 실행하지 않았다. 기존 Vitest global setup은 CLI build/tsc를 실행한다.
- 설치는 최초 전체 설치 시도가 전역 store EROFS로 실패했고, 이후 전체 local-store 설치가 진행됐다.
  사용자의 필터 설치 추가 지시 후 node_modules를 제거하고 지정 worktree 안의 store로
  `CI=true pnpm install --frozen-lockfile --prefer-offline --filter '@buzzni/happy-cli...' --store-dir node_modules/.pnpm-store`
  를 완료했다(2 workspace packages). happy-app의 postinstall이 복사했던 canvaskit.wasm은 H1 checkout과
  SHA-256이 동일하다. manifest/lockfile/wire는 의도적으로 변경하지 않았다.
- 커밋/push/PR/자식 세션 생성 없음. 부분 작업 파일은 지휘 세션에 넘긴다.

최종 부분 검증: 표준 `vitest run --project unit`에 `sessionOwnerContact`, `agentCallerBinding`,
`sessionAgentBroker`, `agentBroker`의 `.test.ts`만 지정하여 **4 파일 / 23 passed / 1 skipped**.
신규 테스트는 contact 10건 + private IPC 1건 = 11건이다. skip은 기존 macOS sandbox 실환경 테스트다.
별도 `NODE_OPTIONS=--max-old-space-size=8192 pnpm -C packages/happy-cli exec tsc --noEmit` 통과.
수정 역검증은 `revokeBinding(binding)`을 기존 `revoke(sessionId)`로 되돌렸을 때 새 contact 테스트
**1 failed / 9 passed**를 확인한 뒤 원본을 복원했다. 역검증용 임시 Vitest config는 global build를
생략하여 해당 테스트만 실행했고 제거했다. 관련 소스 공백 검사 통과. manifest/lockfile과 기존
sessionOwnership.ts는 H1 checkout과 바이트가 같다. Git metadata는 사용하지 않았다.


## 63195d7b 이후: 직접 경로 local transport (미커밋·부분 검증)

추가 파일은 `daemon/sessionOwnerContactLocal.ts`와 대응 테스트뿐이다. 새 외부 의존성이나 wire 변경은 없다.
`startSessionOwnerContactLocal({ enabled, contact })`는 기본 off이며 off에서는 소켓 생성/host 호출/폐기를 하지 않는다.
ON은 POSIX owner-only Unix socket으로 `/owner-contact-v1` POST만 받고 H1 local DTO를 검증한다.
source/scope/depth/authority/argv 주입은 거부하며 기존 broker와 listener·protocol을 공유하지 않는다.
반환 discovery는 `SAYCODE_OWNER_CONTACT_SOCKET` 주소 하나다. 주소는 owner 증명이 아니고,
소유 권위는 공급받은 고정 host contact가 검증한다. 함수가 process.env를 읽거나 쓰지 않는다.

- private 디렉터리 0700, socket 0600. TCP fallback과 새 bearer/key export 없음.
- 요청 64KiB, fatal UTF-8 decoding, H1 응답 128KiB, 동시 요청 8개, 20초 socket deadline.
- Origin·미지 URL·GET 거부. adapter exception/유효하지 않은 reply는 상세 없이 503.
- close는 contact를 폐기하고 연결을 닫고 디렉터리를 삭제한다. adapter promise가 취소를 무시해도 기다리지 않는다.
- Windows pipe ACL 구현·검증은 없으며 활성화하면 unsupported다. host/provider sandbox에 이 소켓의 접근을
  전달하는 정책과 실제 runtime discovery 연결도 아직 구현하지 않았다.

테스트 15건은 default off, 권한, DTO 필드 주입 6건, URL/verb/크기/lookup 제한, UTF-8, deadline,
오류 비노출, pending close, concurrency, 기존 broker와의 병행 동작을 대상으로 한다.
마지막 병행 테스트는 기존 broker **dispatch**가 read/wait/search/prompt/steer/stop을 계속 전달하는지 확인한다.
실제 Desktop 후손 인가/원장 통합을 검증한다고 해석하지 않는다.

초기 실패는 신규 모듈 부재로 타입 검사가 거부했다. 구현 뒤 표준 Vitest에서 local 테스트는
**1 passed / 14 failed**이며 14건 모두 socket listen 전제에서 멈췄다. 이 세션의 환경에서
Node Unix socket `listen`이 `/tmp`와 작업트리 상대 경로 모두 `EPERM`을 반환함을 최소 Node probe로 확인했다.
TCP broker는 실행 가능했다. 이 환경 실패를 skip이나 통과로 바꾸지 않았다. 실소켓 실행이 가능한 환경에서
15건을 다시 실행해야 하며, 실패가 환경뿐이라는 가정으로 나머지 assertion을 통과 처리하지 않는다.

남은 H2는 실제 launch/resume private bootstrap, ApiSession 수명주기 배선, 이 transport의 runtime 연결,
운영 host adapter assembly, read/후손 인가 통합 회귀다. local transport의 Unix 실검증과 Windows 지원도 남는다.
계약 변경 필요성은 확인하지 않았다. 이번 후속에서는 의존성을 추가 설치하지 않았고 커밋하지 않았다.

후속 검증 결과: 별도 CLI `tsc --noEmit`(8GiB NODE_OPTIONS) 통과. 기존 관련 4개 파일
(`sessionOwnerContact`, `agentCallerBinding`, `sessionAgentBroker`, `agentBroker`)은 **23 passed / 1 skipped**.
새 local transport의 default-off gate를 제거하면 해당 테스트가 실패하고 복원하면 통과했다.
이 역검증은 임시 Vitest config와 `-t 'default off'`로 1건만 선택했으며 나머지 14건의 미선택을
실행 통과로 세지 않는다. 임시 config는 제거하고 소스를 복원했다. Unix listen 제약은 해결하지 못했다.
