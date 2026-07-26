# context — preview relay credential pass-through

상태: 완료 (2026-07-26)

## 증상

데스크탑 "PROJECT PREVIEW" 패널에서 앱 첫 화면은 정상 렌더되는데, **로그인하거나 API를
쓰는 순간** 화면에 `<!DOCTYPE html><html lang="en"><head><base href="/"><script>…rwPath…`
같은 **HTML 원문이 텍스트로** 표시됐다.

그 HTML은 relay가 주입하는 `rewriteHtml` shim이 박힌 dev server의 `index.html`이다.
즉 앱이 `res.json()`을 기대한 자리에 SPA history fallback HTML이 온 것이고,
화면의 분홍 박스는 앱 자신의 에러 표시였다.

## 근본 원인 — relay가 credential-transparent 하지 않았다

relay(`/v1/preview/:machineId/:port/*`)는 dev server 앞의 투명한 reverse proxy여야
하는데, 자격증명을 **세 지점에서** 잘라먹고 있었다. 셋 다 고쳐야 로그인이 왕복한다.

1. **요청 `Authorization` 제거** — `previewRoutes.ts:filterForwardedHeaders`가
   hop-by-hop 목록에 `authorization`을 끼워 넣고 있었다. Bearer 토큰을 쓰는 앱의
   모든 API 호출이 익명으로 도착 → 401/redirect → dev server의 history fallback →
   `index.html`. **이것이 스크린샷의 직접 원인.**

2. **요청 `Cookie` 통째로 제거** — 같은 목록에 `cookie`도 있었다. 세션 쿠키 방식
   앱은 로그인 자체가 불가능. 원래 의도는 relay 자신의 ptoken(`happy_preview_*`)이
   사용자 코드로 새는 걸 막는 것이었는데, 헤더를 통째로 버리는 방식이었다.
   → `filterUpstreamCookieHeader`로 **`happy_preview_*` 접두사만** 걸러내고
   나머지는 그대로 전달한다. 접두사 매칭인 이유: 스튜디오 origin에 여러 preview의
   쿠키가 동시에 있을 수 있어, exact name 매칭이면 *다른* preview의 토큰이 샌다.

3. **응답 `Set-Cookie` 덮어쓰기** — 가장 찾기 어려웠던 지점.
   ```ts
   outHeaders['Set-Cookie'] = buildPreviewCookie(...)   // 예전 코드
   ```
   upstream 값은 daemon이 소문자 `set-cookie`로 넣어두는데, Node의 `writeHead`가
   키를 소문자로 정규화하면서 **나중에 대입된 `Set-Cookie`가 앱 쿠키를 지웠다.**
   1·2를 고쳐도 쿠키 로그인은 여전히 안 됐을 것.
   → upstream 쿠키를 모아 relay 쿠키와 함께 **배열(multi-value)** 로 내보낸다.

## 비자명한 사실 (다음 세션이 반복하지 말아야 할 것)

- **단위 테스트로는 3번을 절대 못 잡는다.** `filterForwardedHeaders` /
  `stripResponseHeaders`를 아무리 정밀하게 테스트해도 통과한다. 결함이 순수 함수가
  아니라 `writeHead`의 키 대소문자 정규화라는 *통합* 지점에 있기 때문.
  그래서 `previewRoutesCredentials.spec.ts`(실제 route + `app.inject` + daemon
  socket stub)를 뒀다. 수정 전 코드에 돌리면 10개 중 9개가 실패하는 걸 확인했다 —
  회귀 핀으로 유효하다는 증거.

- **앱 쿠키는 그냥 통과시키면 브라우저가 버린다.** preview iframe은 데스크탑
  top-level 문서(`file://` 또는 스튜디오 origin) 기준 **third-party 컨텍스트**라,
  `rewriteSetCookieForPreview`가 세 가지를 손봐야 저장된다:
  - `Domain=` 제거 — upstream이 말하는 `localhost` 등은 relay 호스트와
    domain-match가 안 돼서 **쿠키 전체가 거부된다**.
  - path-prefix 모드에서 `Path=` 를 prefix 아래로 이동 (subdomain 모드는 prefix가
    `''`이라 no-op). 안 하면 쿠키가 relay 루트에 묶여 preview 요청에 안 실린다.
  - HTTPS일 때 `SameSite=None; Secure` 강제. `Lax`/미지정이면 third-party
    프레임에서 드롭.
  `Path` 속성이 아예 없는 쿠키는 **일부러 합성하지 않는다** — 브라우저의 default-path
  알고리즘이 요청 URI의 디렉터리를 쓰는데 그건 이미 prefix 안쪽이라 상대 의미가 맞다.

- **`set-cookie`만은 join하면 안 된다.** daemon의 `flattenResponseHeaders`가
  배열을 `', '`로 합치고 있었는데, 쿠키 값에는 `Expires=Wed, 21 Oct 2015 …`처럼
  **쉼표가 원래 들어있어서** 되돌릴 수 없다. daemon이 배열로 보내도록 고쳤고,
  구버전 daemon 호환을 위해 서버의 `splitSetCookieValues`가 join된 문자열도
  토큰 인식 정규식(`,\s*(?=<token>=)`)으로 되쪼갠다. daemon은 사용자 머신에서
  서버와 **독립적으로 업데이트**되므로 두 형태 모두 계속 지원해야 한다.

- `Authorization`을 전달해도 relay 인증이 약해지지 않는다. relay는 ptoken(쿼리
  또는 쿠키)으로만 인증하고 `Authorization`은 보지 않는다. 게다가 iframe `src`는
  `Authorization`을 실을 수 없으므로, 이 헤더는 **앱 JS가 명시적으로 붙인 것뿐**이다.

- happy-server는 자기 origin에 preview 쿠키 말고는 아무 쿠키도 굽지 않는다(확인함).
  그래서 path-prefix 모드에서 `saycode.ai`의 non-preview 쿠키를 전달해도 서버 쪽
  비밀이 새지 않는다. 그래도 origin 격리가 필요한 이유는 여전히 유효 —
  path-prefix 모드는 preview들이 storage/쿠키 항아리를 공유한다.

## 남은 이슈 (이번 범위 밖, 발견만 기록)

- **`Origin` 헤더 그대로 전달.** 앱이 `POST /api/login`을 하면 브라우저는
  same-origin이어도 `Origin: https://<mid>-<port>.preview.…`를 붙인다. 백엔드가
  엄격한 CSRF origin 검사를 하면 403이 날 수 있다. relay가 upstream origin으로
  다시 쓸지는 결정 필요 — CORS preflight 응답에 영향이 있어 단순 치환은 위험.
- **third-party cookie phase-out.** 현재 Electron/Chromium 기본값에선
  `SameSite=None; Secure`면 통과한다. 차단이 기본이 되면 CHIPS(`Partitioned`)가
  필요해지는데, 그러면 top-level site별로 파티션되므로 별도 검토가 필요하다.
- **preview는 포트 하나만 relay한다** (`PREVIEW_SERVICE_KINDS = ['frontend',
  'electron-gui']`, 데스크탑 `src/domain/workspace.ts`). 백엔드가 별도 포트에 있고
  frontend dev server가 `/api`를 proxy하지 않는 프로젝트라면, 이번 수정과 무관하게
  같은 "HTML이 왔다" 증상이 난다. 그 경우는 앱의 dev server proxy 설정 문제다.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `packages/happy-server/sources/modules/preview/previewCredentials.ts` | 신규 — 순수 헬퍼 3종 |
| `packages/happy-server/sources/app/api/routes/previewRoutes.ts` | 헤더 전달/Set-Cookie 병합, 타입 확장 |
| `packages/happy-cli/src/daemon/previewProxy.ts` | `set-cookie` 배열 유지 |
| `packages/happy-cli/src/daemon/controlServer.ts` | 위 타입 변경에 맞춘 zod 스키마 |
| `…/previewCredentials.spec.ts`, `…/previewRoutesCredentials.spec.ts`, `…/previewRoutesStripHeaders.spec.ts` | 테스트 |

검증: happy-server preview 스위트 307 passed, happy-cli previewProxy 19 passed,
양쪽 `typecheck` 통과.
