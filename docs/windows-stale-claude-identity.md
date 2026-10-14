# Windows stale Claude identity recovery

Status: source implemented and locally verified; runtime release and Desktop adoption pending.
Updated: 2026-10-14

## Scope and decision

Core: credential preservation and organization account application already belong to the Happy daemon.
An installer must not delete the user's Claude configuration merely because an identity looks stale.
The existing additive organization apply path can instead skip personal capture when Windows secure
storage is demonstrably absent. This also covers retries after installation without a reinstall.

No public protocol, stored schema or Desktop UI changes. The optional platform dependency is for
deterministic tests; production defaults to process.platform. Revert the runtime change to restore
the previous capture behavior; no configuration migration needs rollback.

## Implemented behavior

- Resolve the secure store from CLAUDE_SECURESTORAGE_CONFIG_DIR when defined, otherwise CLAUDE_CONFIG_DIR.
  An empty value selects the default ~/.claude store, matching the provider's capture behavior.
- On Windows only, an ENOENT credential store and no explicit API/auth/OAuth token environment
  credential allow stale identity metadata to bypass personal capture.
- Existing stores, malformed JSON and access errors never count as absence. macOS retains the
  capture path because a missing plaintext file does not prove absence from Keychain.
- Keep configuration and stored personal accounts intact; use the normal organization import,
  verification and receipt flow. Do not turn arbitrary COMMAND_FAILED errors into success.

Reconsider the absence test if Windows Claude starts storing OAuth outside this file or the provider
changes secure-store resolution. Broader recovery needs provider-authoritative presence diagnostics.

## Validation

- Regression first failed on the old implementation with AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED.
- Related Vitest suites: aiCredentialSetupToken, aiCredentialRuntime, aiCredentialGroupAdapters,
  aiCredentialGroups: 330 passed, 2 existing skipped.
- happy-wire build and happy-cli build (including tsc --noEmit) passed.
- Tests cover successful orphan recovery without settings deletion, personal capture protection,
  macOS, existing empty stores, explicit environment credentials, redirected and explicitly default
  secure stores, malformed JSON, EACCES and EPERM.
- Tests used the repository unit setup and alias with a temporary focused Vitest config, after
  explicitly building the CLI; no integration suites or full repository test run.
- Installed Windows app was not patched. End-to-end startup recovery on the released artifact remains
  unverified.

## Release follow-up

Publish through the existing Happy release process with the required release authorization, then
update Desktop's runtime pin and Windows lock together and add its release note. Do not point the
pin at an unpublished version. Verify the installed Windows startup retry with an isolated stale
identity fixture before claiming shipped recovery.

Suggested release note: Windows 시작 준비에서 Claude 계정 이름만 남고 인증 파일이 없는 경우에도
조직 AI 계정 연결을 계속합니다. 설정 파일을 직접 삭제하거나 다시 설치할 필요가 없습니다.
