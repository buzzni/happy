import { z } from 'zod';
import { ownershipId as id, ownershipHash } from './sessionOwnership';
import { MessageMetaSchema, MessageContentSchema, SessionMessageSchema, type MessageContent } from './messages';
import { hubPromptGuardSchema } from './sessionProtocol';

export const relayCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// IDs a relay carries from existing records (messages, permissions, activity, runtime) keep their producers'
// unrestricted string contract; ownershipId is only for IDs this protocol mints (H1-R-02).
export const persistedId = z.string().min(1);
export const relayLocalId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const text = z.string();
// Existing sessionConnection permission input and PendingPermissionRequest.arguments are dynamic
// tool data, NOT a generic RPC payload. Canonical JSON and the envelope byte limit cover these too.
const toolData = z.custom<Record<string, unknown>>(v => v !== null && typeof v === 'object' && !Array.isArray(v));
const difficulty = z.enum(['trivial', 'routine', 'hard', 'escalated']);
const route = { model: text, effort: text.nullable(), difficulty };
const autoRoute = z.object({ model: text, effort: text.nullable(), label: text,
    stage: z.enum(['selected', 'queued', 'applied', 'failed', 'cancelled', 'unknown']).optional(),
    revision: relayCount.optional(), evidence: z.enum(['engine-applied', 'legacy-selection', 'unknown']).optional(),
    executionId: text.optional(), clientRequestIds: z.array(text).optional(), candidateDifficulty: difficulty.optional(),
    baseRoute: z.object(route).strict().optional(), temporaryEscalation: z.boolean().optional(),
    decisionReasons: z.array(text).optional(), providerConfirmedModel: text.optional(),
    previousApplied: z.object({ ...route, kind: z.enum(['auto', 'local-auto-bootstrap', 'manual']) }).strict().optional(),
}).strict();
// §3.4 normalized text producer settings; absence of permissionMode must stay absence.
export const OwnerRelayPromptPayloadSchema = z.object({ text,
    settings: MessageMetaSchema.pick({ model: true, effort: true, permissionMode: true }).extend({
        modelSource: z.enum(['user', 'auto']).optional(), autoRoute: autoRoute.optional(),
    }).strict(),
    delegatedAttendance: z.enum(['attended', 'unattended']).optional(), hubPrompt: hubPromptGuardSchema,
}).strict();
export const OwnerRelayPermissionPayloadSchema = z.object({ sessionId: id, runtimeId: persistedId,
    permissionId: persistedId, approved: z.boolean(), updatedInput: toolData.optional(),
    mode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional(),
}).strict();
// A wire projection of Desktop PendingPermissionRequest, including its existing policy metadata.
const policy = z.object({ reasonCode: text, ruleId: text, humanOnly: z.boolean(),
    target: z.object({ category: text, appName: text, bundleIdOrExe: text }).strict().optional(),
    action: text.optional(), grantOffer: z.enum(['once', 'session']),
}).strict();
export const OwnerRelayPendingPermissionSchema = z.object({ requestId: persistedId, toolName: text, title: text,
    arguments: toolData, createdAt: relayCount.optional(), expiresAt: relayCount.optional(),
    kind: z.enum(['ask-user-question', 'exit-plan-mode', 'project-scope', 'generic']), policy: policy.optional(),
}).strict();
// Existing Desktop AgentActivity, with no invented idle/completion meaning for observation gaps.
const activity = z.object({ state: z.enum(['known', 'none', 'unknown']), title: text.nullable(),
    inProgress: z.array(text), text: text.nullable(), source: z.enum(['TodoWrite', 'plan']).nullable(),
    sourceMessageId: persistedId.nullable(), sourceSeq: relayCount.nullable(), reason: text.nullable(),
    observedAt: relayCount.nullable(),
}).strict();
export const OwnerRelaySnapshotSchema = z.object({ active: z.boolean().nullable(), thinking: z.boolean().nullable(),
    runtimeId: persistedId.nullable().optional(), machineId: persistedId.nullable().optional(),
    agentControlledByUser: z.boolean().optional(), pendingPermissionRequests: z.array(OwnerRelayPendingPermissionSchema).optional(),
    activity: activity.optional(),
}).strict();
// Validate the existing message union, but preserve legacy/event extension data for signing and
// transcript fidelity. A normal parse would silently strip fields belonging to existing producers.
const content = z.custom<MessageContent>(value => MessageContentSchema.safeParse(value).success);
export const OwnerRelayReadEventSchema = z.object({ id: SessionMessageSchema.shape.id, seq: relayCount, localId: SessionMessageSchema.shape.localId,
    content, createdAt: relayCount, updatedAt: relayCount,
}).strict();
// Mirrors daemon/ownedSpawnRuntime.ts's supported options; no arbitrary argv, executable or RPC.
// Environment is still subject to daemon/sessionEnv.ts admission at execution, never authority.
export const OwnerRelaySpawnOptionsSchema = z.object({ directory: text.min(1), agent: z.enum(['claude', 'codex']),
    model: text.optional(), effort: text.optional(), initialPrompt: text.optional(), initialPromptLocalId: text.optional(), // the daemon's existing spawn option, not a relay-minted ID (H1-R-04)
    permissionMode: MessageMetaSchema.shape.permissionMode, additionalDirectories: z.array(text).optional(),
    environmentVariables: z.custom<Record<string, string>>(v => v !== null && typeof v === 'object' && !Array.isArray(v)
        && Object.values(v).every(entry => typeof entry === 'string')).optional(), mcpConfigProjectId: text.optional(),
    mcpCallerGrantEnvelope: text.optional(), expectedConnectors: z.array(text).optional(),
    approvedNewDirectoryCreation: z.boolean().optional(),
    aiAuthSelection: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('machine-personal') }).strict(), z.object({ kind: z.literal('org-bundle') }).strict(),
        // Same formats as daemon/sessionEnv.ts MANAGED_ACCOUNT_ID / GROUP_SCOPE: the wire never accepts what the daemon refuses (H1-R-05).
        z.object({ kind: z.literal('claude-setup-token'), managedAccountId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
            groupScope: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            credentialGeneration: relayCount.min(1), bindingGrant: text.max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
            credentialProofVersion: z.literal(1).optional() }).strict(),
    ]).optional(),
}).strict();
export const OwnerRelayChildReferenceSchema = z.object({ operationId: id, spawnId: id, spawnDigest: ownershipHash }).strict();
