# Preview relay Origin 정규화 Context

> 마지막 갱신: 2026-07-28 / 상태: **구현 완료(T1~T5, T7). T6(실기기 daemon 교체 검증)만
> 의도적으로 스킵 — 아래 참고. PR/릴리스는 아직.**
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
happy-cli(typecheck+test 145/147 파일, 실패 2개는 무관한 기존 flake)와 happy-server
(typecheck+test 39/39 파일 478/478 전부 통과)로 회귀를 확인했다(T5). 브랜치
`preview-relay-origin-normalization`에 커밋 2개(14ab6b6d, 7ff62423). PR 생성 및
happy-cli 릴리스는 아직 하지 않음 — 둘 다 사용자 승인 필요.

## 다음 세션 시작점

구현은 끝났다. 다음 단계는 (a) 이 브랜치를 push하고 PR을 만들지, (b) T6(실기기 검증)를
언제·어떻게 안전하게 할지, (c) happy-cli 릴리스(버전 bump+태그+`npm publish`, `AGENTS.md`
정책상 별도 승인 필요)까지 진행할지를 사용자와 정하는 것. 셋 다 이 세션에서는 승인받지
않았다.

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
- **happy-cli 유닛 스위트에 타임아웃 마진이 부족한 테스트가 있다.**
  `scripts/__tests__/cli-version.test.ts`의 "initializes and closes the packaged
  control-server runtime"은 격리 실행에서도 4797ms/5000ms로 여유가 200ms뿐이라,
  전체 스위트를 동시 실행하면 CPU 경합으로 간헐 실패한다. `runAcp.test.ts`의 몇몇
  케이스도 같은 성질. 이 spec과 무관하지만 CI 신뢰도를 갉아먹으므로 별도로
  `testTimeout` 상향 또는 해당 테스트의 격리 실행 분리를 검토할 가치가 있다.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `packages/happy-cli/src/daemon/previewProxy.ts` | `buildUpstreamHeaders`(구 `stripHopByHop`)가 `Origin`을 `http://127.0.0.1:{port}`로 재작성 |
| `packages/happy-cli/src/daemon/previewProxy.test.ts` | Origin 재작성 케이스 5개(소문자/대문자/`null`/없음 등) |
| `packages/happy-server/sources/modules/preview/previewWebSocketRelay.ts` | `serializeUpgradeRequest`가 `Host`와 대칭으로 `Origin` 재작성 |
| `packages/happy-server/sources/modules/preview/previewWebSocketRelay.spec.ts` | Origin 재작성 케이스 2개(있음/없음) |
| `packages/happy-server/sources/app/api/routes/previewRoutesStripHeaders.spec.ts` | upstream loopback ACAO를 실제 프리뷰 origin으로 교체하는 안전 속성 회귀 테스트 |
| `specs/preview-relay-credential-passthrough/context.md` | "남은 이슈"의 Origin 항목에 이 spec으로의 각주 링크 |

검증: happy-server typecheck 통과 + 전체 39파일/479개 통과. happy-cli typecheck 통과 +
146/147 파일, 1343/1344개 통과.

**happy-cli의 1개 실패는 무관한 기존 flake다.** 실행마다 실패 파일이 바뀌며
(`runAcp.test.ts` → `scripts/__tests__/cli-version.test.ts`), 후자는 격리 실행 시
**4797ms / 5000ms 타임아웃**으로 여유가 200ms뿐이라 전체 스위트 동시 실행의 CPU
경합에서 초과한다. 이 spec의 변경은 순수 헤더 조립 함수라 daemon 초기화 시간에
영향을 줄 수 없다. → 별도 이슈로 다룰 가치가 있음(아래 "발견된 문제" 참고).

커밋: 14ab6b6d(T1-T2), 7ff62423(T3-T4), da7db079(T7 문서),
06a2deab(테스트 보강), 9603012b(구조적 개명), + ACAO 회귀 테스트.
