# Local application access to an Agent Browser task space

Source candidate based on Happy CLI `1.1.10-aplus.353` (`8876df8c`). This requires the updated broker and runtime as well as the CLI. Installing only the CLI does not enable it. Chrome extension Browser Bridge is a different backend.

## Connect and collect

On Linux with Git installed, in a Claude remote-mode or Codex browser-task session, ask the agent to call `browser_task_create_client` with the space ID, exact origins, lease minutes (1–60), and a new connection-file path inside the project. In a Git repository this destination must already be ignored by Git; choose a private ignored location, never a publicly shared preview directory. The existing permission prompt shows those fields and the granted profile and requires a human one-time approval. Without a human approver the session refuses issuance; Claude local-terminal mode has no approver. Missing Git also refuses issuance because the writer cannot verify file exclusion. The parent session secret stays in the trusted session process; it is not supplied to the agent shell. Public CLI `create` is intentionally refused.

Issuance pins the approved parent directory by file descriptor so a concurrent symlink replacement cannot redirect the write. The tool writes a private mode-0600 descriptor and returns only its path, connection ID and expiry. Do not commit or serve that file. Then run in the dashboard backend:

```sh
happy browser-client status --file /private/path/dashboard-connection.json
happy browser-client collect --file /private/path/dashboard-connection.json --url https://example.com/report
happy browser-client revoke --file /private/path/dashboard-connection.json
```

`create` refuses an existing output path, writes a new mode-0600 file and prints only its path, connection ID and expiry. Keep this file outside source control, web roots, frontend bundles and logs. Other commands reject symlinks, non-regular files, files readable by group/others and files owned by another user. Creation returns a secret once; if a transport failure leaves delivery uncertain, a connection may exist until the requested deadline. Do not automatically retry creation.

A dashboard backend can invoke `collect` without an AI turn. It opens one task and one tab, observes the page, finishes with the current task version, closes its tab, and returns JSON with a collection timestamp. It never returns cookies. It uses the profile's current authentication; a new tab does not necessarily inherit sessionStorage or all application state. Site policy, target-site permissions, and login expiration still apply. The default observation limits of the runtime apply; this is not a general-purpose scraping SDK.

On a known login/verification page, collection reports `awaiting-user` and cleans up its temporary task/tab. Complete login in the profile and collect again. Other failures return exit code 3, do not retry mutations and do not expose transport error details. The runtime may retain an uncertain task or a tab blocked by beforeunload for user inspection. Successful data is never reported as freshly collected if finish/cleanup failed. Frontend clients should see only collected data, collection time and status, never the connection file or API token.

Use `browser_task_list_clients` in an authenticated owner session to inspect connections and `browser_task_revoke_client` to request their revocation with human approval, including when the descriptor was lost. Client credentials cannot call these owner tools' broker endpoints. A different session of the same current profile owner can recover a connection after the original conversation ends.

## Version 1 local API

The broker uses its existing Unix socket. All client routes are POST, use JSON, return the normal `{ok,result}` / `{ok:false,error}` envelope and reject unknown fields. The header is `x-abp-session-secret`; its meaning depends on the route:

| Route | Credential | Body |
|---|---|---|
| `/v1/clients/register` | Existing bound owner session secret | `{schemaVersion:1,profileId,taskSpaceId,origins,leaseMs}` |
| `/v1/clients/list` | Existing bound owner session secret | `{schemaVersion:1,profileId}` |
| `/v1/clients/revoke-owned` | Existing bound owner session secret | `{schemaVersion:1,profileId,clientSessionId}` |
| `/v1/clients/grant` | Dedicated client secret | `{schemaVersion:1}` |
| `/v1/clients/status` | Dedicated client secret | `{schemaVersion:1}` |
| `/v1/clients/revoke` | Dedicated client secret | `{schemaVersion:1}` |

Registration returns `clientSecret`, `clientSessionId`, profile/space/origins/operations and `expiresAtMs`. The requested origins must be exact HTTP(S) origins allowed by the broker's site policy. The existing registration ledger supplies the principal and current assignment; callers cannot name another principal. The runtime verifies the owner session's active membership in the space before adding the client; the broker rechecks the owner registration after attachment. At most 16 active connections are allowed per principal; revoked cleanup records do not consume this quota.

Grant returns a short `token`, `grantId`, `tokenExpiresAtMs` and connection metadata. The token is sent as `Authorization: Bearer ...` to the existing local runtime `POST /v1/ops/<operation>`. Runtime DTOs remain version 1; consumers must not import Happy's private source modules. The CLI accepts only HTTP loopback runtime endpoints and refuses redirects when sending a credential. External clients must enforce the same rule.

Allowed operations are createTask, openPage, closePage, observe, screenshot, submitBatch, finishTask, getTask, resume and cancel. Tokens name exactly one space. Other-space listing/joining, createSpace/closeSpace, interactive approval/control, credential export and raw CDP/evaluate are not available. ClosePage is additionally limited to tabs created by this client. The existing task owner, version, origin, policy, approval and user takeover checks continue to apply.

## Lifetime, persistence and rollback

A connection has a fixed lifetime of 1 second to 60 minutes (CLI: whole minutes, default 60). A grant lasts at most 5 minutes and never outlives the connection. Refreshing a token does not extend the connection. Longer running dashboards need a new user-authorized connection after expiry; silently renewing authority forever is not supported.

An approved live lease preserves the space through ordinary idle reclamation and the original conversation's end. Explicit space closure, reassignment, lease expiry or revocation denies further use. Expired leases are removed by runtime reclamation; the broker sweeper cancels the client and replays pending revocations. Space closure still obeys existing in-flight/unknown-effect safeguards. Quotas for tabs and windows are shared with the user's other tasks.

`browser-local-clients.json` stores secret hashes, bounded rights, fixed deadlines and a durable revocation tombstone separately from `broker-sessions.json`. Unknown/invalid registry schema disables client issuance and rejects existing client grants while ordinary browser sessions remain available. Missing client records also invalidate their runtime grants. A client secret never resolves as an ordinary session secret, including on older brokers. Revocation persists a tombstone, removes the runtime lease/cancels tasks, revokes issued grants, then removes the registration. Failure to persist the access fence or grant revocation retains a revoking tombstone for retry without blocking unrelated session cleanup/readiness. Once access is durably revoked, the response is `revoked:true`; `cleanupPending:true` means tabs still need safe cleanup. Revoked cleanup records do not consume active-connection quota. Cleanup closes only client-owned tabs; held tabs, running workers or unknown effects use a 60-second retry backoff. Runtime reclamation can clean expired client tabs even if the client registry is disabled.

Before rollback, stop issuance, revoke live connections, verify cancellation/cleanup and drain the broker. Keep registry metadata until that completes. An old runtime does not understand leases: already-issued signed grants can remain usable until expiry if rollback skips revocation. Do not treat downgrade alone as immediate revocation. Never delete login profiles, cookies or unrelated user tabs as rollback cleanup.

This is a bearer capability guardrail, not a security boundary against malicious agents or processes with the same OS user privileges. The human-only prompt is enforced on the cooperating session-tool path; it is not broker-verifiable proof of consent. Linux `/proc/<session-pid>/environ` may retain the owner secret originally inherited by the session even after Node removes it from `process.env`; an unrestricted same-UID process may obtain it and bypass the tool by calling the broker directly. Moving that secret from environment to a file/fd alone would not establish same-UID isolation. Processes running as the same OS user may read each other's secrets and daemon-owned files. Stronger separation needs a separately confined account and a trusted token-renewal service; merely blocking that account from the broker socket also prevents direct renewal. No new OS-account provisioning is performed by this feature.

## Validation

Relevant tests: `localClients.test.ts`, `localClientSession.test.ts`, `localClients.poc.test.ts`, `browserClientCommand.test.ts`, `runtime.test.ts`, `auth.test.ts`, `spaceReclaim.test.ts`, and existing broker suites where Unix sockets are allowed. Local restricted verification may exercise the actual broker HTTP handler with stream requests without binding a socket; this does not replace a process/socket/real Chrome acceptance test.

Before release, run on a machine that permits local sockets: create a logged-in test profile, attach a client, collect from a separate process, verify no token/cookie in stdout, end the original conversation, collect again within the lease, then test expiry, explicit close, revocation and restart. Test approval/takeover and a login using tab-local state. Record the exact build and inspect retained/blocked tabs. Publish and pin only after this acceptance passes.

The opt-in `BROWSER_CLIENT_HTTP_SMOKE=1` test uses real loopback HTTP and a separate Node consumer with a fake browser driver; it does not establish cookie sharing. `BROWSER_CLIENT_REAL_SMOKE=1` uses real Chrome, a synthetic test login cookie, the production Unix broker socket and the built CLI in a separate process. The Linux Node 24 PR smoke job runs this test. Both exercise parent termination then continued collection and revocation. The Chrome test requires an environment that allows Chrome process-singleton Unix sockets. Before release also verify the human approval prompt end-to-end in Desktop; unit coverage of PolicyApprover is not visual acceptance.

Revoked cleanup records are retained until tab cleanup succeeds; they have no separate count/retention limit in this version. An operator should inspect retained/blocked tabs before issuing many replacement connections. Revisit retention bounds when this is used for high-volume unattended clients; active connection quota alone is not a disk-usage bound.
