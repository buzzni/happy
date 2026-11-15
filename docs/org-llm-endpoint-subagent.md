# 사내 LLM subagent 계약

aplus-dev-studio `specs/org-llm-endpoint-subagent`의 승인된 계약을 구현한다. UI/CLI/서버가 소유한 기존 값은 복사한 env를 권한 근거로 삼지 않는다.

## 지원 전제

같은 dedicated PC의 새 Claude 자식, customer machine key(dataKey), 현재 승인된 기기 키와 사용자 actor, Happy의 immutable session execution binding이 필요하다. 일반 Claude/Codex 부모도 사용자 게이트에서 새로 시작해 proof를 받아야 한다. 이전 부모나 legacy account secret만 있는 PC를 자동 승격하지 않는다. strict+none은 기존 자격 저장소의 현재 generation만 사용하며 HTTP sync로 새 설정을 넣지 않는다. strict+static-token은 기존 미지원 정책을 유지한다.

## 버전과 경로

- saycode CLI manifest/host/daemon: 별도 `orgEndpointSubagentVersion:1`. broker protocol은 1 유지. 옛 CLI 번들은 org spawn 거절 유지.
- Happy Server: account 인증 `GET /v1/org-endpoint-subagent/capabilities` → version1/proof1/relay630000. 새 생성 두 RPC만 relay 상한630초, 나머지는 기존600초 유지.
- machine-key RPC: `org-endpoint-subagent-capabilities/context`, `spawn-org-endpoint-subagent`, `org-endpoint-subagent-status`, `org-endpoint-subagent-root-prepare/start/status`. server/delegation lane에 추가하지 않는다.
- root: daemon prepare의 공개 nonce/hashes → Studio 사용자 인증 `POST /api/companies/:id/llm-endpoints/subagent-launch` → exact ticket으로 daemon start. 암호화 create/snapshot/키는 daemon에만 둔다.
- child: signed Studio prepare → 기존 sync/probe/env → immutable child execution create → durable launching claim → fresh native start → strong started report. sourceSessionId를 parentSessionId/native resume로 변환하지 않는다.

## 중복 방지와 복구

daemon 보호 journal을 fsync하며 root start는 별도 exclusive claim을 쓴다. server `(machineId,operationId)`와 digest, binding을 고정한다. reserved/preparing/prepared/launching 경계가 불명확하면 새 provider를 실행하지 않는다. 620초 observer가 pending을 반환해도 이미 제출한 작업의 늦은 성공은 같은 operation에 보고한다. status는 새 prepare·create·provider 제출을 하지 않는다. CLI는 별도 projection을 통해 `happy agent spawn --resume-op <id>`로 조회한다.

강한 시작 보고 유실은 providerConfirmed 기록으로 다음 spawn 전에 재전송한다. 강한 resume 성공은 Studio operation projection도 정산한다. 기존 약한 /owner 기반 시작/resume 경로는 subagent binding을 승인할 수 없다.

## 검증·릴리스

실제 HTTP/서명/암호화 root→child→grandchild, strict 저장소 유실/현재 generation, marker 유실, durable CAS/unknown/expiry, CLI/broker source 결정과 sandbox credential denial을 검증한다. SIGKILL checkpoint 검증은 임시 홈과 fake external provider를 쓰며 실제 LLM 수락과 구분한다.

Happy Server 먼저 → Studio migration/auth → 승인된 saycode-cli tag/CI → 새 CLI를 번들한 happy-cli tag/CI → 승인된 vendor/Desktop pin 순서다. `docs/happy-cli-release.md`대로 CI만 publish하며 로컬 publish는 금지한다. 이 개발 변경은 release/pin 승인을 포함하지 않는다.
