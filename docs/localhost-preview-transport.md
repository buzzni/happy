# Desktop localhost 전달 계약

Desktop에서 현재 PC의 개발 서버는 직접 열고, 다른 머신의 서버는 인증된 preview relay를 통해 localhost로 전달한다. 이때 웹 미리보기용 HTML/JS/CSS 재작성과 script 주입을 적용하면 SPA 경로와 OAuth callback 주소에 relay prefix가 노출된다.

## 응답 선택과 권한

- HTTP 요청의 `x-happy-preview-transport: localhost-v1`은 응답 표현만 선택한다. 기존 preview token의 서명·machine/port 범위, ACL, runtime binding 검사는 동일하게 수행한다.
- 성공적으로 인가된 RPC 응답에는 같은 확인 헤더를 붙인다. 본문 bytes와 앱의 Location·Set-Cookie·CSP·Link·Content-Encoding을 유지하고 transport hop 헤더와 기존 Content-Length만 다시 계산한다.
- localhost 전달의 OPTIONS는 인증된 route에서 개발 서버까지 전달한다. 다른 API와 웹 미리보기의 CORS allowlist/preflight 처리는 유지한다.
- 헤더가 없는 기존 웹 클라이언트는 기존 재작성 경로를 사용한다. WS는 기존 인증/소켓 전달 경로를 유지한다.
- transport 표식은 개발 서버로 전달하지 않고 개발 서버가 확인 응답을 위조할 수도 없다. 표식만으로 인가되지 않는다.

## 적용 순서와 복구

1. Happy 서버 변경을 먼저 배포한다. 기존 웹 preview와 유효 token으로 요청한 localhost-v1의 확인 응답 및 원문 응답을 점검한다.
2. 확인 후 Desktop 변경을 배포한다. 새 Desktop은 확인 헤더가 없는 응답을 차단하므로 구서버와 연결하면 원격 포워딩이 실패한다.
3. 내 PC 직접 개발과 공용 Linux → 내 PC 포워딩에서 SPA·OAuth callback·WS를 확인한다. 포트 점유 시 대체된 실제 localhost 포트를 callback 등록에 사용한다.

복구는 Desktop을 먼저 이전 버전으로 되돌린 뒤 서버 변경을 되돌린다. DB migration, CLI 릴리스, 개발 서버 설정 변경은 없다. 서버만 먼저 되돌리면 새 Desktop의 원격 전달이 차단된다.

## 관련 검증

`packages/happy-server`에서 관련 다섯 파일을 실행한다.

```sh
node node_modules/vitest/vitest.mjs run sources/app/api/routes/previewRoutesLocalhost.spec.ts sources/app/api/routes/previewRoutesCredentials.spec.ts sources/app/api/routes/previewRoutesRuntimeBinding.spec.ts sources/app/api/routes/previewRoutesRelay.spec.ts sources/app/api/cors.spec.ts
```

133개 사례는 raw/웹 응답 구분, gzip 원문과 헤더, redirect/cookie/security 헤더, OPTIONS, token 범위·runtime binding 및 CORS 회귀를 검증한다. 실제 Linux 머신과 외부 OAuth 제공자의 로그인 수락은 별도 배포 후 확인이 필요하다.

재검토 조건: 새로운 preview transport 또는 token 정책을 도입하거나 최소 Desktop 버전을 올릴 때 이 헤더 계약과 구클라이언트 호환을 함께 검토한다.
