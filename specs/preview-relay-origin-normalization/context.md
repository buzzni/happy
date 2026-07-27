# Preview relay Origin 정규화 Context

> 마지막 갱신: 2026-07-28 / 상태: **구현 + 셀프 리뷰 2회 완료. PR #109 open.**
> T6(실기기 daemon 교체 검증)은 의도적으로 스킵, happy-cli 릴리스는 미승인 — 아래 참고.
> 목적: 다음 세션의 Claude가 이 파일 하나만 읽고 즉시 이어서 작업할 수 있게 한다.

## 현재 상태 (3~5문장)

`aplus-dev-studio-app`(별도 저장소, Expo 프로젝트)에서 프리뷰 흰 화면 버그를 조사하다가,
근본 원인이 그 프로젝트가 아니라 이 vendor/happy 저장소의 preview relay에 있다는 걸 확인했다.
relay는 dev 서버로 요청을 전달할 때 `Host`는 이미 항상 `127.0.0.1:{port}`로 재작성하는데
`Origin`은 브라우저가 보낸 프리뷰 도메인 그대로 전달한다 — 이 비대칭 때문에 Host/Origin을
비교하는 모든 dev 서버 미들웨어(Expo `CorsMiddleware` 등)가 cross-origin으로 오판해 요청을
거부한다. `specs/preview-relay-credential-passthrough/context.md`의 "남은 이슈"에 이미
발견돼 있던 갭이었다. HTTP 경로(`previewProxy.ts`, T1~T2)와 WS 업그레이드 경로
(`previewWebSocketRelay.ts`, T3~T4)에 각각 대칭적인 Origin 재작성을 TDD로 구현했고,
happy-server(typecheck + 39파일/479개 전부 통과)와 happy-cli(typecheck 통과, 유닛
스위트는 부하 의존 flake를 제외하면 통과 — 아래 "발견된 문제" 참고)로 회귀를 확인했다.
이후 셀프 코드 리뷰를 2회 돌려 발견한 6건을 반영했다(아래 "셀프 코드 리뷰 결과").
PR #109(https://github.com/buzzni/happy/pull/109) open 상태. happy-cli 릴리스는
아직 승인받지 않았다.

## 다음 세션 시작점

구현·리뷰는 끝났다. 남은 결정은 (a) PR #109 리뷰 반영/머지, (b) T6(실기기 검증)를
언제·어떻게 안전하게 할지, (c) happy-cli 릴리스(버전 bump+태그+`npm publish`,
`AGENTS.md` 정책상 별도 승인 필요)까지 진행할지. **(c)가 끝나야 실제로 흰 화면이
고쳐진다** — 아래 "배포 스큐" 항목이 이유.

## 작업 환경 — 격리된 worktree 사용 (중요)

이 저장소(`vendor/happy`)의 메인 체크아웃(`/Users/justin/workspace/aplus-dev-studio/vendor/happy`)은
**여러 동시 Claude Code 세션이 공유**하고 있다(`ps aux`로 10개 이상의 활성 happy-cli daemon/세션
프로세스 확인됨). 이번 세션 중 실제로 다른 세션이 그 메인 체크아웃에서
`git checkout fix/session-idle-mode-guard`를 실행해, 내가 만든 커밋이 순간적으로 남의
브랜치에 잘못 붙는 사고가 있었다(즉시 발견해 cherry-pick으로 옮기고 원래 브랜치 포인터를
복구함 — 작업 트리 파일은 건드리지 않아 피해 없음). 그 이후로는 메인 체크아웃을 detached
상태로 남겨두고, 실제 작업은 `git worktree add /tmp/happy-preview-origin-normalization
preview-relay-origin-normalization`로 만든 격리된 worktree에서 했다. **다음 세션도 메인
체크아웃에서 직접 커밋하지 말고, 이 worktree(있으면 재사용, 없으면 새로 생성)에서 작업할
것.** worktree는 `pnpm install`이 별도로 필요(로컬 pnpm store 캐시 덕에 약 20초).

## 결정 로그

- **재작성 지점을 `previewRoutes.ts`(happy-server, 브라우저↔relay 경계)가 아니라
  `previewProxy.ts`/`previewWebSocketRelay.ts`(relay↔dev서버 경계, 즉 이미 `Host`를
  재작성하는 바로 그 지점)로 잡았다.** 이유: `previewRoutes.ts`는
  `request.headers.origin`을 응답 CORS 헤더(`applySubdomainPreviewCorsHeaders`)에도
  쓰고 있어서, 거기서 재작성하면 "브라우저가 보낸 원본 Origin"과 "upstream에 보낼
  재작성된 Origin" 두 값을 구분해서 daemon에 넘겨야 해 프로토콜(payload 스키마)이
  늘어난다. `previewProxy.ts`는 `port`만 있으면 `Origin`을 계산할 수 있는 지점이라
  기존 시그니처를 안 건드리고 끝난다. → 재검토 조건: 만약 나중에 relay가 `kind`
  (frontend/backend)별로 다르게 처리해야 하는 요구가 생기면, 그때는 daemon↔server
  프로토콜에 `kind`를 얹는 별도 spec이 필요하고 이 결정도 같이 재검토.
- **재작성을 `kind` 무관하게 전부 적용하기로 했다(비목표에 명시).** `Host`가 이미
  오늘도 무조건 재작성되고 있어서, `Origin`만 예외적으로 유지하는 게 오히려 더
  일관성이 없다고 판단. 이론적으로 어떤 프로젝트의 백엔드가 이 relay 뒤에서 Origin
  기반 CSRF 방어를 하고 있었다면 이 변경으로 그 방어의 "실제 브라우저 Origin을
  본다"는 전제가 깨질 수 있음 — 발견되면 재검토(spec.md 비목표 참고).
- **T6(실기기 daemon 교체 검증)를 스킵했다.** 실행 중인 daemon이 여러 동시 세션을
  서빙하고 있어(바로 위 "작업 환경" 절 참고), 라이브 교체는 무관한 다른 세션의 프리뷰를
  끊을 위험이 있는 공유 인프라 변경이라 판단 — 사용자 승인 없이 하지 않음. 대신
  단위 테스트(T1~T4)가 정확히 실제 버그의 재현 조건(`aplus-dev-studio-app`에서 실측한
  `curl -H "Origin: <preview-url>" <bundle-url>` 200/500 분기)을 assert하도록 작성해
  간접 검증으로 대체했다.

## 셀프 코드 리뷰 결과 (사이드 이펙트 분석)

구현 후 자체 리뷰에서 확인한 것들. **결론: 회귀 없음.** 근거를 남긴다.

- **응답 CORS는 영향받지 않는다 (가장 중요).** 상위 spec이 "CORS preflight 응답에
  영향이 있어 단순 치환은 위험"이라고 우려했던 부분을 실제로 추적했다:
  1. **preflight는 upstream에 도달조차 하지 않는다.** `previewRoutes.ts:446`이
     `OPTIONS` + `access-control-request-method`를 relay에서 단락 처리하고 204를
     직접 응답한다. 요청 Origin 재작성은 preflight 경로와 무관.
  2. **실제 요청의 응답 ACAO는 relay가 덮어쓴다.** `applySubdomainPreviewCorsHeaders`가
     **원본** `request.headers.origin`(재작성 전 값)으로 ACAO를 다시 세팅한다.
     upstream이 loopback ACAO를 반사해도 지워지고 실제 프리뷰 origin으로 교체된다.
     → 이 안전 속성을 `previewRoutesStripHeaders.spec.ts`에 회귀 테스트로 고정했다
     ("replaces an upstream loopback ACAO with the real preview origin").
  즉 outbound(relay→dev서버) 방향만 재작성한 설계가 정확히 이 이유로 안전하다.
- **잔여 위험(낮음): path-prefix 모드.** 이 모드에선 `parsePreviewHost(host)`가 null이라
  `applySubdomainPreviewCorsHeaders`가 헤더를 그대로 통과시키므로, upstream의 loopback
  ACAO가 브라우저까지 샐 수 있다. 다만 path-prefix 모드는 iframe이 relay 호스트에서
  서빙되어 프리뷰 요청이 **same-origin**이고, 브라우저는 same-origin 응답의 ACAO를
  무시하므로 실사용 영향이 없다고 판단. → 재검토 조건: path-prefix 모드에서 진짜
  cross-origin 요청을 하는 구성이 생기면 다시 볼 것.
- **`Origin: null`(sandboxed iframe의 opaque origin)도 loopback으로 정규화된다.**
  의도한 동작 — opaque origin은 어떤 same-origin 검사도 통과하지 못하므로 오히려
  개선이다. 테스트로 고정.
- **테스트가 프로덕션 형태를 놓치고 있었다(수정함).** happy-server는 Fastify의
  `request.headers`(소문자화됨)로 전달 헤더를 만들기 때문에 daemon에 실제로 도착하는
  건 소문자 `origin`인데, 최초 테스트는 대문자 `Origin`만 검증하고 있었다. 소문자
  케이스를 추가했다. (WS 경로는 `req.rawHeaders`라 와이어 원본 대소문자 `Origin`이
  맞으므로 기존 테스트가 이미 현실적.)
- **함수 이름이 동작을 감추고 있었다(수정함).** `stripHopByHop`이 이제 재작성도
  하므로 `buildUpstreamHeaders`로 개명(구조적 커밋 분리).
- **호출부 확인.** `proxyHttp`는 `controlServer.ts:538`, `apiMachine.ts:820` 두 곳에서
  호출되며 둘 다 `req.port`를 그대로 넘기므로 loopback origin 계산이 항상 일관된다.

### 2차 리뷰에서 추가로 찾은 것

- **배포 스큐 — 두 수정의 릴리스 경로가 다르다 (운영상 가장 중요).**
  HTTP 경로 수정은 `packages/happy-cli`(사용자 머신의 daemon), WS 경로 수정은
  `packages/happy-server`(서버 배포)에 있다. 프로토콜 호환성은 서로 독립이라 깨지지
  않지만(spec.md 제약 참고), **사용자에게 보이는 효과는 각각 따로 도착한다**:
  | 조합 | 결과 |
  |---|---|
  | 신 server + 구 daemon | WS(HMR)만 고쳐짐. **Expo 번들 500/흰 화면은 그대로** |
  | 구 server + 신 daemon | HTTP(흰 화면) 고쳐짐, WS는 그대로 |
  | 둘 다 신규 | 완전 해결 |
  즉 **이 PR 머지만으로는 흰 화면이 안 고쳐진다** — 흰 화면을 고치는 건 daemon 쪽이고,
  그건 `AGENTS.md`의 "Happy CLI Release Publisher" 절차(버전 bump → 태그 → CI publish,
  사용자 명시 승인 필요)를 거쳐 각 머신의 daemon 이 갱신돼야 반영된다. 따라서
  `aplus-dev-studio-app` 의 `app.config.js` 워크어라운드는 **happy-cli 릴리스가 실제로
  배포되고 대상 머신의 daemon 이 갱신될 때까지** 반드시 유지해야 한다.
- **live WS 테스트의 "faithful mirror" 가 실제로 드리프트해 있었다(수정함).**
  `previewWsRelay.live.test.ts` 는 cross-package import 가 안 돼서
  `serializeUpgradeRequest` 의 헤더 직렬화를 인라인으로 복제하는데, 이번 변경 이후
  그 복제본은 `Host` 만 재작성하고 `Origin` 은 안 하고 있었다. 테스트의 목적 자체는
  전송 계층(socket.io `destroyUpgrade:false` + 바이트 파이핑)이라 기능적 결함은
  아니지만, "faithful mirror" 라는 주석 때문에 **Origin 재작성이 end-to-end 로 검증된다는
  착시**를 준다. 복제본도 Origin 을 재작성하도록 맞추고, 실제 구현과 동기화를 유지해야
  한다는 경고를 주석에 명시했다.
- **`filterForwardedHeaders` 의 문서가 부정확해졌다(수정함).** "the relay is otherwise
  transparent" 라고 적혀 있었는데 `Origin` 은 더 이상 투명하지 않다(daemon 에서 재작성).
  그 함수만 읽는 사람이 알 수 없으므로, 어디서 재작성되는지와 이 계층에서 원본을
  남겨두는 이유(응답 CORS 가 브라우저의 실제 origin 을 필요로 함)를 doc 에 추가했다.

### 검토했으나 손대지 않은 것

- **`Referer` 헤더는 재작성하지 않았다.** 여전히 프리뷰 도메인을 가리킨다. Expo/Vite/
  webpack/Next dev 서버 중 `Referer`로 origin 검사를 하는 사례를 찾지 못했고, 추측성
  변경은 하지 않는다는 원칙(Simplicity First)에 따라 보류. → 재검토 조건: `Referer`
  기반으로 요청을 거부하는 dev 서버가 보고되면.
- **`Sec-Fetch-Site: cross-site`는 그대로 남는다.** 재작성한 Origin(same-origin 의미)과
  형식상 불일치하지만, 이걸 맞추려면 브라우저 fetch metadata 전반을 위조해야 해서
  범위를 넘는다. 이걸로 차단하는 dev 서버가 나오면 별도 안건.

## 시도했으나 기각한 접근

- happy-server의 `previewRoutes.ts` 응답 CORS 로직 쪽에서 재작성 — 위 결정 로그 참고,
  daemon 프로토콜 확장이 필요해 기각.
- Origin 헤더를 아예 제거(delete) — 기각. "Origin 없음"과 "same-origin"을 다르게
  다루는 미들웨어가 있을 수 있어, loopback 값으로 채우는 쪽이 의미상 더 정확
  (dev 서버 입장에서 실제로 자기 자신에게 오는 요청이 맞음).

## 발견된 문제 (이번 범위 밖)

- `specs/preview-relay-credential-passthrough/context.md`의 "남은 이슈" 중
  third-party cookie phase-out(CHIPS/Partitioned 필요성)은 이 spec과 무관, 별도.
- `aplus-dev-studio-app`의 `app.config.js`+`.env`(`EXPO_PREVIEW_ORIGIN`) 워크어라운드는
  이 spec이 릴리스되어 실제로 그 프로젝트에 반영되기 전까지 계속 필요 — 되돌리는 건
  별도 승인 필요한 다른 저장소 작업이라 이번 스코프에 포함 안 함.
- **happy-cli 유닛 스위트가 부하에 따라 간헐 실패한다 — main 에서도 재현되는 기존 문제.**
  **검증 방법**: `origin/main`(이 spec 의 변경이 전혀 없는 상태)을 별도 worktree 로
  체크아웃해 full suite 를 돌린 결과 **3개 파일 실패**
  (`broadKillShims.test.ts`, `difftastic/index.test.ts`, `ripgrep/index.test.ts`).
  같은 시점 이 브랜치는 1개 실패였다 — 즉 이 spec 이 flake 를 늘리지 않았고,
  오히려 main 이 이미 더 불안정하다.
  실행마다 실패 파일이 바뀌고(`runAcp` → `cli-version` → `sessionScanner` →
  main 에선 또 다른 3개), 각각 격리 실행하면 전부 통과한다. 원인은 타임아웃 마진
  부족으로 보인다 — `cli-version.test.ts` 의 "initializes and closes the packaged
  control-server runtime" 은 **격리 실행에서도 4797ms / 5000ms** 로 여유가 200ms뿐이라
  전체 스위트 동시 실행의 CPU 경합에서 바로 넘어간다.
  이 spec 과 무관하지만 CI 신뢰도를 갉아먹으므로 별도 안건으로 `testTimeout` 상향
  또는 무거운 테스트의 격리 실행 분리를 검토할 가치가 있다.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `packages/happy-cli/src/daemon/previewProxy.ts` | `buildUpstreamHeaders`(구 `stripHopByHop`)가 `Origin`을 `http://127.0.0.1:{port}`로 재작성 |
| `packages/happy-cli/src/daemon/previewProxy.test.ts` | Origin 재작성 케이스 5개(소문자/대문자/`null`/없음 등) |
| `packages/happy-server/sources/modules/preview/previewWebSocketRelay.ts` | `serializeUpgradeRequest`가 `Host`와 대칭으로 `Origin` 재작성 |
| `packages/happy-server/sources/modules/preview/previewWebSocketRelay.spec.ts` | Origin 재작성 케이스 2개(있음/없음) |
| `packages/happy-server/sources/app/api/routes/previewRoutesStripHeaders.spec.ts` | upstream loopback ACAO를 실제 프리뷰 origin으로 교체하는 안전 속성 회귀 테스트 |
| `packages/happy-server/sources/app/api/routes/previewRoutes.ts` | `filterForwardedHeaders` doc에 Origin이 downstream에서 재작성된다는 사실 명시(코드 변경 아님) |
| `packages/happy-cli/src/daemon/previewWsRelay.live.test.ts` | 드리프트한 mirror를 실제 구현에 맞춤 + 동기화 경고 주석 |
| `specs/preview-relay-credential-passthrough/context.md` | "남은 이슈"의 Origin 항목에 이 spec으로의 각주 링크 |

검증: happy-server typecheck 통과 + 전체 39파일/479개 통과. happy-cli typecheck 통과.
happy-cli 유닛 스위트의 간헐 실패는 main 에서도 재현되는 기존 flake로 확인
(아래 "발견된 문제" 참고).

커밋: 14ab6b6d(T1-T2), 7ff62423(T3-T4), da7db079(T7 문서),
06a2deab(테스트 보강), 9603012b(구조적 개명), 12cbf8bd(ACAO 회귀 테스트 + 1차 리뷰),
cd4ab34b(2차 리뷰: mirror 드리프트 + 문서).
