# Shared-machine rotation wire and Happy execution binding

Status: fixed local implementation contract, 2026-10-19. Base: `241462cf6`.
Scope: happy-wire and happy-server only; no CLI runtime, deployment, production DB or release.
Security architecture approval was supplied by the caller. Core: authentication, credential authority and authoritative session ownership cannot be delegated to an extension.

## Authoritative exports and encoding

`@slopus/happy-wire` exports the schemas/types/helpers from `sharedMachineRotation.ts`.
Implementers must import these, rather than clone DTOs. All objects are strict. IDs are
1–128 characters without whitespace/control characters; hashes are lowercase SHA-256
hex (64 characters). Ed25519 public keys/signatures and nonces are canonical unpadded
base64url (32/64/32 bytes). `deviceKeyId` is SHA-256 of the raw device Ed25519
public key; `keyId` is SHA-256 of the raw Studio Ed25519 public key.
All times are epoch milliseconds, nonnegative safe integers; generations/revisions are
positive safe integers. No machine binding contains `userId`.

Canonical JSON is `canonicalOrgSetupTokenJson`: recursively sorted UTF-16 keys, UTF-8,
no whitespace or Unicode normalization, no undefined/sparse values, lone surrogates,
negative/fractional/unsafe numbers, custom prototypes or symbols; maximum 64KiB and
64 nested levels. Sign the original validated object, never strip unknown fields.
`parseRotationDocument` rejects duplicate JSON keys before schema validation when
consuming raw signed JSON. HTTP signatures bind the schema-validated JSON value.
The encrypted create body including all fields must fit the canonical 64KiB limit;
individual metadata and agentState fields allow at most 60000 characters.

Every signed envelope is `{ body, signature }`. The signature field is not part of
its signing bytes. `rotationSigningBytes(body)` returns UTF-8:

```
saycode/<body.type>/v<body.version>\n<canonical JSON of body>
```

`rotationDigest(value)` = SHA-256(UTF-8(canonical JSON(value))).
`sessionTagHash(tag)` = SHA-256(UTF-8(tag)), including exact tag bytes.
`sessionCreateBodyHash(body)` = rotationDigest of the exact create body excluding
`executionProof`. Omitted fields remain omitted; null and omission differ. Do not
modify encrypted metadata, agent state or key after signing. Unknown create fields
are rejected when proof is present. Legacy creates retain their existing behavior.
`rotationIsFresh` requires `0 < expiresAt-issuedAt <= 60000`, issuedAt <= now+60000,
and now < expiresAt. Skew permits future issue time, never expired authorization.
TTL is checked again inside the new-session transaction.

## Fixed discriminators and audiences

| Exported body schema | version / type | audience | signer |
|---|---|---|---|
| MachineSetupTokenBindingV2Schema | 2 / claude-setup-token-binding | saycode-daemon | Studio signing key |
| DaemonRotationRequestBodySchema | 2 / setup-token-daemon-request | configured Studio origin | currently approved device key |
| SessionExecutionTicketBodySchema | 1 / saycode-session-execution | configured Happy origin | pinned Studio signing key |
| HappySessionCreateProofBodySchema | 1 / happy-session-create-proof | configured Happy origin | ticket device key |

Origins are exact URL origins (HTTPS, or HTTP loopback for local tests), no trailing
slash/path/query/userinfo. Verifiers compare them to their configuration. An origin
or public key supplied by a request never establishes trust.

Machine binding fields: version,type,audience,principalType=`machine`, companyId,
machineId,groupScope,assignmentGeneration,assignmentFingerprint,managedAccountId,
credentialGeneration,approvalId,deviceKeyId,launchId,bindingRevision,nonce,
previousNonce (null for revision 1),issuedAt,expiresAt,keyId (Studio signing key ID).
A binding is signed, not a token; it grants no message access. Revision 1 requires
null previousNonce; later revisions require the prior nonce. It is daemon-internal,
never accepted through public spawn `aiAuthSelection`. `groupScope` equals the
approved custody journal entry's `scope`; `assignmentGeneration` equals its applied
`assignmentGeneration`; `assignmentFingerprint` equals its `fingerprint` unchanged.
The selected managedAccountId/credentialGeneration must match `appliedCredentials`.
Missing receipts/generations fail closed; do not derive fingerprints from tokens or
invent a new fingerprint algorithm.

Execution ticket fields: version,type,audience,studioOrigin,keyId,companyId,machineId,
machineOwnerAccountId,sessionOwnerAccountId,launchId,initialNonce,operationId,
approvalId,deviceKeyId,deviceSigningPublicKey,sessionTagHash,sessionCreateBodyHash,
issuedAt,expiresAt. `keyId` selects no remote key: it must match the configured key.

The complete POST DTO is `HappySessionCreateRequestSchema` (the encrypted create
body plus required `executionProof`). Happy create proof is `{ ticket: SessionExecutionTicket, deviceProof: SignedHappySessionCreateProof }`.
Device proof body fields: version,type,audience,method=`POST`,path=`/v1/sessions`,
ticketDigest (rotationDigest of the complete signed ticket),sessionOwnerAccountId,
sessionTagHash,sessionCreateBodyHash,issuedAt,expiresAt. POST `/v1/sessions` retains
the original session owner's account bearer (browser-sync and session-scoped
credentials are rejected). The device proof covers the exact signed ticket,
method/path and encrypted body/tag hashes.

## Signed daemon requests (all POST)

Every request is `{ body, signature }` (signature uses approved device key).
Common body: version=2,type=`setup-token-daemon-request`,audience,method=`POST`,
path (fixed per action below),action,companyId,machineId,approvalId,deviceKeyId,
operationId,launchId,issuedAt,expiresAt. All fields below are required, including
nullable values. Each logical action uses a fresh operationId, retained for retries;
issue/claim/commit do not share one operationId. The ticket records the issue ID.
launchId is fresh for each launch (including children); operationId and launchId
must have at least 128 bits of randomness. Studio alone generates 32-byte nonces.
Studio checks bearer, current approval/key, company/machine,
assignment and applied receipt before any selection/nonce/history mutation.

| action | fixed path | additional fields |
|---|---|---|
| issue | /api/claude-setup-token/daemon/v2/issue | sessionOwnerAccountId,sessionTagHash,sessionCreateBodyHash |
| claim | /api/claude-setup-token/daemon/v2/claim | sessionId,nonce,bindingRevision |
| commit | /api/claude-setup-token/daemon/v2/commit | sessionId,nonce,bindingRevision,bindingDigest |
| usage | /api/claude-setup-token/daemon/v2/usage | sessionId,nonce,bindingRevision,observation |
| rebind | /api/claude-setup-token/daemon/v2/rebind | sessionId,nonce,bindingRevision,observation |
| operation | /api/claude-setup-token/daemon/v2/operation | targetOperationId |

An observation: `{ observationId, observedAt, managedAccountId, credentialGeneration,
windows, accountWideRefusal }`. windows is a unique list of `{ kind: 'five_hour' |
'seven_day', utilizationBps: 0..10000, resetsAt: epoch-ms|null }` (max two).
accountWideRefusal is `account_limit` or null. Empty windows plus account_limit is
valid; empty windows plus null is invalid. Model/throttle/auth failures must not be
encoded as account_limit. Studio must separately reject stale or unauthorized reports.

`daemonRotationOperationDigest(body)` removes only issuedAt/expiresAt before hashing;
this permits fresh signatures for the same operation without changing selection.
operationId is scoped by companyId+machineId; same ID+same digest returns the existing
result/nonce/revision; changed digest conflicts. `operation` uses a new query operationId
and the original targetOperationId. It is signed and authorized, never new selection.
A commit references the digest of the complete signed binding. Successful durable
transitions alone count toward rotation limits. Studio's operation/receipt semantics
remain the Studio implementation's responsibility; these wire DTOs do not implement it.

## Happy persistence and authorization

Server config (all required for proof creates, otherwise 503; no effect on legacy):
`HAPPY_EXECUTION_STUDIO_ORIGIN`, `HAPPY_EXECUTION_STUDIO_PUBLIC_KEY` (base64url Ed25519),
`HAPPY_EXECUTION_AUDIENCE` (Happy origin). No network key discovery or request trust URL.
Both ticket and device proof must be fresh and correctly typed/scoped. Session bearer
must equal ticket.sessionOwnerAccountId. Machine row must have ID=machineId and
accountId=machineOwnerAccountId. Approval authority is the pinned Studio issuer;
Happy does not invent a second device approval store.

New `SessionExecutionBinding`: immutable sessionId PK, companyId,machineId,
machineOwnerAccountId,sessionOwnerAccountId,launchId,initialNonce,operationId,
approvalId,deviceKeyId,sessionTagHash,sessionCreateBodyHash,ticketDigest,createProofDigest,
createdAt. Unique(companyId,machineId,launchId), Unique(companyId,initialNonce),
Unique(companyId,machineId,operationId). Nullable composite row links
(sessionRowId,sessionRowOwnerAccountId) and (machineRowId,machineRowOwnerAccountId)
reference Session/Machine (id,accountId), with CHECKs tying them to immutable IDs.
Deletion sets the row links null, preserving replay evidence and normal deletion.
Tombstones cannot be returned as execution owners or reused for a new session.

Create and binding insert occur in one Serializable transaction with retries. The
account update sequence is allocated in that transaction; event publishes after commit.
Existing tag is returned only if a stored binding has the exact complete proof digest
(and original body/tag hashes), current machine owner and matching session owner.
Never add a binding to an existing legacy/other session. A changed proof, tag, owner,
launch or initial nonce cannot reuse a launch. Expired requests cannot create or replay;
recovery after expiry uses an independently authenticated operation/execution-owner query.
Binding stays immutable if session encrypted metadata changes later. Exact create retry
checks stored original digests, not current mutable metadata. Unique conflict losers
re-read through the same exact replay check, never attach by upsert.

POST `/v1/machine-sessions/:sessionId/execution-owner` uses machine-owner account
bearer (browser-sync and session-scoped credentials are rejected);
body `{ companyId,machineId,launchId,initialNonce }` (strict). On exact stored relation
and current machine/session owner match, returns `{ owner: { companyId,machineId,
sessionId,launchId,initialNonce,machineOwnerAccountId,sessionOwnerAccountId } }`;
otherwise 200 `{ owner:null }`. No ciphertext, signature, token or device key returned.
Original `/owner` and all messages/socket ACLs remain account-scoped and unchanged.
Cross-account execution registration never grants the machine account message access.

## Rollback, verification and handoff

This is an additive OFF-by-missing-config boundary. Rollback disables new proof creates;
keep the schema/rows and execution-owner route for existing bindings. Never reinterpret
v2 as v1 or delete replay evidence. No migration is applied to production by this task.
Architecture docs outside the assigned ownership are intentionally unchanged: this
contract records the new boundary for the parent to incorporate after review.

Portable deterministic vectors: `packages/happy-wire/src/fixtures/sharedMachineRotation.v1.json`.
They contain public test seeds, canonical JSON, signing bytes, hashes and Ed25519
signatures for every request action, binding, ticket and create proof. Tests must check
literal fixture bytes/signatures as well as rejection boundaries.

Implemented locally: typed body/envelope/create/query schemas, portable canonical
signing/hash helpers and 9 independent Node-Ed25519 vectors; proof-only account-bearer
gate; pinned Studio trust; atomic session/binding/sequence creation; exact replay;
additive migration with identity CHECKs and deletion tombstones; execution-owner query.
The original same-account owner and message ACL remain unchanged. Changed files:
5 existing, 8 new. No commits, CLI runtime changes or external deployment.

Final verification commands (from this checkout):

```sh
corepack pnpm -C packages/happy-wire exec vitest run src/sharedMachineRotation.test.ts src/orgSetupTokenApproval.test.ts
# PASS: 27 tests, 2 files
corepack pnpm -C packages/happy-wire run build
# PASS: typecheck + ESM/CJS/declarations build
corepack pnpm -C packages/happy-server exec vitest run sources/app/api/routes/executionBindingRoutes.spec.ts sources/app/session/sessionExecutionBinding.spec.ts sources/app/api/routes/sessionRoutes.spec.ts sources/app/api/routes/machineSessionOwnerRoutes.spec.ts
# PASS: 38 tests, 4 files; actual additive migration exercised in isolated PGlite
corepack pnpm -C packages/happy-server run typecheck
# PASS
corepack pnpm -C packages/happy-server run build
# PASS: typecheck + runtime bundle
XDG_CACHE_HOME=/tmp/happy-rotation-prisma-cache DATABASE_URL=postgresql://unused:unused@localhost:5432/unused corepack pnpm -C packages/happy-server exec prisma validate --schema prisma/schema.prisma
# PASS: schema validation only, no database connection
git diff --check
# PASS
```

ESM and CJS runtime imports additionally checked 15 rotation schemas and 12 helpers,
and parsed the complete create DTO from the signed fixture. Failure-first HTTP tests reproduced ignored malformed
proof (200 instead of 400) and browser-sync authority (200 instead of 403) before fixes.
Boundary coverage includes forged Studio/device signatures, changed encrypted fields,
wrong origins/audiences/accounts, expiry/TTL, legacy sessions, concurrent exact retries,
launch/nonce/operation reuse, atomic rollback, deletion/recreation and message ACL.

Local setup used filtered frozen-lockfile installation with scripts disabled, then
`XDG_CACHE_HOME=/tmp/happy-rotation-prisma-cache corepack pnpm -C packages/happy-server run generate`.
Server typecheck includes existing happy-app schema imports, so ignored node_modules
links to the already installed zod/happy-wire were added for those imports only.
Vitest prints unrelated missing Expo/Electron tsconfig warnings from uninstalled
workspaces; all selected tests pass. The PGlite test normalizes adapter 0.7.2 bytea
result cells to JSON arrays for the Prisma Rust bridge; no production adapter changes.

Parent review/integration remains: Studio issue/claim/commit/usage/rebind/operation
implementations and daemon runtime are outside this checkout's ownership. Consumers
must verify current approval/assignment/applied receipt at each authority boundary.
Parent should incorporate this architecture into shared docs after reviewing the
changes. Production migration, rollout and real-machine/provider acceptance remain
unperformed; local boundary success is not full rotation end-to-end acceptance.

## Parent review follow-up

A raw HTTP request containing a duplicated signed `companyId` was accepted (200)
because the ordinary JSON parser discarded the earlier key. Parent added a
pre-parsing check for proof-bearing creates using the common unique-key parser;
legacy payloads retain the existing body-size limit/parser. Signed HTTP documents
are bounded to 64 KiB including the proof and reject malformed UTF-8. The new
regression failed before the fix; all four server suites then passed 39 tests.
Server typecheck also passed after compatibility fixes for the existing TS target.
This follow-up is now copied into the integrated Happy checkout. Source identity
was verified; the server review checkout passed the 39 related tests and typecheck.
Live cross-service acceptance remains pending.
