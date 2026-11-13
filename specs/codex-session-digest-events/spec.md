# Codex 대화 digest MCP 이벤트

2026-11-11 사용자 승인: Codex read/search 요청이 Desktop에서 조용히 무시되는 이벤트 불일치를 보완한다.

- raw item/started·completed의 Common MCP read_project_sessions와 search_project_sessions를 live envelope로 전달한다.
- 원래 server/tool/arguments를 보존한 McpTool 형태로 이력과 일치시킨다.
- aplus-common/aplus_common의 두 도구만 추가하며 browser_task_*의 기존 quota 처리·이벤트 모양을 유지한다.
- functions.exec 코드·결과 문자열을 파싱해 MCP 실행을 추정하지 않는다. 구조화된 내부 호출 이벤트가 전제다.
- wire schema·인증·권한·CLI 버전·설치본은 바꾸지 않는다. 실제 provider가 내부 MCP 이벤트를 제공하지 않는 경로는 별도로 관측해야 한다.
