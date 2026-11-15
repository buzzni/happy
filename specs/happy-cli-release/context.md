# 상태 — 2026-11-15

사용자는 머지된 Happy CLI 변경의 공식 발행과 Desktop 소비를 요청했다. .419는 main의 개인 LLM·장치 중계·조직 subagent 기능 코드를 유지하고, 기존 Saycode CLI를 공개 0.9.18로 고정하는 후보이다. 기존 전역 설치·daemon·다른 checkout과 운영 기능 gate는 변경하지 않는다. Studio #6157 및 서버 선행 배포·실제 공급자 수락은 패키지 검증과 별도다.

## 공개 CLI와 후보 검증

Saycode CLI 0.9.18은 Desktop main merge d8f885f2d644f2d5537b6e0aade353fc456a66ea의 saycode-cli-v0.9.18 tag에서 공식 CI43719035275로 발행·registry 검증됐다. 별도 공개 tarball clean install·버전·orgEndpointSubagentVersion=1·--org-endpoint 도움말을 확인했다. 이 버전의 실제 integrity로 Happy dependency/lock을 갱신하며, 재생성 중 생긴 무관한 서버 Vite peer 변경은 제외했다.

최신 후보는 CLI build/typecheck, frozen lock/install, 관련11 suites/95 tests(0skip)가 통과했다. 공개 CLI를 실제 실행한 macOS sandbox의 credential 읽기 거절·trusted-host whoami도 포함한다. Happy PR의 기존 macOS 실패는 daemon preflight 테스트가 자식에 30초를 주면서 외부 기본 5초 제한을 사용한 경우였다. 외부 제한만35초로 맞췄고 자식30초·성공/상태 미생성 단언은 유지한다. 이전1270개 통과/6 conditional skip/로컬 차단7개 기록과 최신95개는 겹칠 수 있어 합산하지 않으며, 전체 회귀는 새 공식 CI로 확인한다.

동일 후보 .tgz의 guard --require-browser-hosts --install-smoke가 통과했다. 필수 bundled13파일·native3종·production dependency closure·Happy 버전·agent facade·daemon preflight/status를 확인했다. 번들 index는 공개 CLI0.9.18과 바이트 단위로 같다. 로컬 native host3종은 C 소스와 빌드 스크립트가 동일한 .418 공식 CI 산출물을 사용했으며, .419 발행 CI는 새 태그에서 다시 빌드한다. 이는 후보 패키지 검증이며 Happy registry 공개나 실제 endpoint E2E 완료를 의미하지 않는다.

다음은 승인된 release PR 통합과 CI 확인, main 병합 뒤 exact .419 tag/merge commit/외부 발행 행위의 직전 확인이다. tag는 기능이 포함된 실제 main merge commit에 붙인다. 공식 CI와 registry의 lifecycle-enabled 독립 설치·daemon status 검증을 마친 뒤에만 Desktop pin/tag/commit 및 Windows lock PR을 진행한다. Desktop base 병합·Studio 승격은 별도 승인 범위로 유지한다.


## 병행 .419 태그 확인과 .420 후속 준비

사용자는 #1268 통합·새 CI 통과 뒤 main 병합·정확한 .419 tag/공식 CI 발행을 명시 승인했다. 992d38af를 기존 release 브랜치에 정상 push했고 CI43723221727의 Linux20/24·Windows20/24·macOS가 모두 성공한 뒤 #1268을 merge1b0f3ca9에 병합했다. 구 head bot 승인과 새 head CI는 구분한다.

실제 main merge에는 #1269의 검증된 plan model 정책 변경도 포함됐다. 대상1b0f3ca9를 고정해 CLI type/build, 관련13 suites/130 tests(0fail/0skip), native3종·bundled13파일·동일 tgz guard --require-browser-hosts --install-smoke를 재검증했고 모두 통과했다. usage wire는 .418과 같다.

태그 push 직전 원격 재확인에서 다른 작업이 14:30:49Z에 ce30029b를 happy-cli-v1.1.10-aplus.419로 태그한 것을 발견했다. 이 커밋은 CLI0.9.17이며 #1268 merge14:36:16Z보다 앞선다. 공식 발행43724754046은 publish 성공·verify 진행 중이다. 우리 쪽 태그 push·로컬 publish·기존 태그 변경은 수행하지 않았다.

따라서 1b0f3ca9에서 .420 후속을 로컬 준비한다. dependency/lock과 기능은 그대로 CLI0.9.18이며 package version만 변경한다. .420 외부 PR/main/tag/공식 발행은 버전이 바뀌었으므로 사용자 별도 승인을 기다린다. Desktop 소비와 전용 daemon 교체는 새 정식 registry 검증 뒤 진행한다. Studio 승격·vendor·usage 인프라는 무변경이다.

.420 로컬 후보 검증 완료: 기존 cli-version 1 suite/6 tests와 globalSetup CLI type/build 통과. 새 .420 tgz의 guard --require-browser-hosts --install-smoke도 native3종·bundled13파일·fresh lifecycle install·daemon preflight/status까지 통과했다. 번들 CLI0.9.18/capability1과 공개 index SHA256 1e1ae6af81fe9fd152d850807bb0a5abea9af1a523cb6b9c07376d08b148113b가 같다. 추가 기능·wire·lock 변경은 없다. 패키지 SHA1은198bf3e230b01907d8a389f705be2e55e859e72b이며 registry 공개물이 아닌 로컬 후속 후보로 구분한다. 새 .420 원격 PR/main/tag/Actions 발행은 아직 수행하지 않았다.
