import { z } from 'zod';
export { default as orgRequirementsV1CasesFixture } from './fixtures/orgRequirements.v1.cases.json';

/**
 * Organization requirements (aplus-dev-studio-desktop specs/codexcli-org-requirements T12).
 *
 * Studio serves one document per organization (and member) on the `/api/me/mcp-config` response the
 * session process already fetches, when the request carries `x-aplus-requirements-version: 1`. The
 * policy is restrictive-only: an organization can narrow models, cap the permission mode, ask or
 * block tools and switch features off — never open anything.
 *
 * `OrgRequirementsV1Schema` is the document as Studio emits it. A runtime does not parse with it:
 * a broken or newer item must drop only that item (spec R3), so the daemon checks the envelope with
 * `OrgRequirementsEnvelopeSchema` and judges items one by one. The case table
 * `fixtures/orgRequirements.v1.cases.json` is the canonical source the Desktop and Studio copies follow.
 */

export const ORG_REQUIREMENTS_SCHEMA_VERSION = 1;
/** Request header a runtime that enforces the document sends; Studio adds the fields only then. */
export const ORG_REQUIREMENTS_VERSION_HEADER = 'x-aplus-requirements-version';

/** `ok` carries a document (empty items = explicitly released); the rest carry none (spec R16). */
export const OrgRequirementsStatusSchema = z.enum(['ok', 'no-company', 'unresolved', 'unavailable']);
export type OrgRequirementsStatus = z.infer<typeof OrgRequirementsStatusSchema>;

/** Least to most autonomous; a ceiling clips anything above its `max` (spec R5.3). */
export const ORG_PERMISSION_MODE_ORDER = ['read-only', 'plan', 'default', 'acceptEdits', 'bypassPermissions'] as const;
/** What an administrator may pick as the permission mode ceiling (Q3). `bypassPermissions` = no limit. */
export const ORG_PERMISSION_MODE_CEILINGS = ['default', 'acceptEdits', 'bypassPermissions'] as const;
export type OrgPermissionModeCeiling = typeof ORG_PERMISSION_MODE_CEILINGS[number];

const text = (max: number) => z.string().max(max).refine((value) => value.trim().length > 0);
const revision = z.number().int().nonnegative();

export const OrgToolRuleV1Schema = z.object({
  id: text(128),
  tool: text(256),
  target: text(256).optional(),
  action: text(256).optional(),
  /** Organization rules only ask or block: "no limit" is the absence of a rule (spec R3a). */
  decision: z.enum(['ask', 'blocked']),
  /** The revision the rule was introduced at, assigned by Studio (spec R1a, R3a). */
  since: revision,
}).strict();
export type OrgToolRuleV1 = z.infer<typeof OrgToolRuleV1Schema>;

export const OrgAiModelsItemSchema = z.object({
  kind: z.literal('allowedSet'),
  /** Studio selection keys `<agent>:<model id>`, split at the first colon. */
  values: z.array(z.string().regex(/^[a-z]+:\S+$/)).max(256),
  default: z.string().nullable(),
  source: z.enum(['organization', 'member']),
}).strict();
export const OrgToolRulesItemSchema = z.object({ kind: z.literal('rules'), rules: z.array(OrgToolRuleV1Schema).max(200) }).strict();
export const OrgPermissionModeItemSchema = z.object({ kind: z.literal('ceiling'), max: z.enum(ORG_PERMISSION_MODE_CEILINGS) }).strict();
/** `fixed` items pin the restrictive value only (Q4): an organization can switch a feature off, never on. */
export const OrgFixedOffItemSchema = z.object({ kind: z.literal('fixed'), value: z.literal(false) }).strict();

const items = z.object({
  'ai.models': OrgAiModelsItemSchema.optional(),
  'tools.rules': OrgToolRulesItemSchema.optional(),
  'permissions.mode': OrgPermissionModeItemSchema.optional(),
  'approvals.aiReview': OrgFixedOffItemSchema.optional(),
  'autopilot.enabled': OrgFixedOffItemSchema.optional(),
}).catchall(OrgFixedOffItemSchema).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (['ai.models', 'tools.rules', 'permissions.mode', 'approvals.aiReview', 'autopilot.enabled'].includes(key)) continue;
    if (!/^developerFeatures\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) ctx.addIssue({ code: 'custom', message: `unknown item ${key}`, path: [key] });
  }
});

const envelope = {
  schemaVersion: z.literal(ORG_REQUIREMENTS_SCHEMA_VERSION),
  companyId: text(256),
  revision,
  /** `updatedAt` of the AI model policy rows the document was composed from. */
  modelPolicyUpdatedAt: z.number().finite().nullable(),
  /** Studio clock, ms. */
  issuedAt: z.number().finite(),
};

/** The document exactly as Studio emits it. */
export const OrgRequirementsV1Schema = z.object({ ...envelope, items });
export type OrgRequirementsV1 = z.infer<typeof OrgRequirementsV1Schema>;

/** What a runtime trusts wholesale: anything else is judged per item. */
export const OrgRequirementsEnvelopeSchema = z.object({ ...envelope, items: z.record(z.string(), z.unknown()) });

/**
 * Why the daemon clipped or refused something. Refusals end the turn (`turn-end{failed}`) with a reason
 * sentence; `requirement_ceiling` is the immediate unattended denial the D1 approval matrix names.
 */
export const ORG_REQUIREMENT_REASONS = [
  'requirement_model_denied',
  'requirement_model_unknown',
  'requirement_runtime_unsupported',
  /** No model chosen, or a resumed model the policy no longer allows: ran on an allowed model (R10.2a). */
  'requirement_model_substituted',
  /** `fallbackModel` outside the set was dropped; the turn ran. */
  'requirement_fallback_removed',
  /** Permission mode clipped to the ceiling, from a turn or an approval answer. */
  'requirement_mode_clamped',
  /** An approval answer's `allowTools` named a tool the organization blocks. */
  'requirement_tool_blocked',
  'requirement_ceiling',
  'requirement_autopilot_disabled',
  /** A session grant made before an organization `ask` rule existed asked again (R1a). */
  'org_rule_revision',
] as const;
export const OrgRequirementReasonSchema = z.enum(ORG_REQUIREMENT_REASONS);
export type OrgRequirementReason = z.infer<typeof OrgRequirementReasonSchema>;

export const OrgRequirementEnforcementSchema = z.object({
  /** Monotonic per session, so a client shows each enforcement once. */
  seq: z.number().int().nonnegative(),
  at: z.number(),
  item: z.string(),
  requested: z.string().nullable(),
  applied: z.string().nullable(),
  reason: OrgRequirementReasonSchema,
  revision,
});
export type OrgRequirementEnforcement = z.infer<typeof OrgRequirementEnforcementSchema>;

/**
 * agentState `orgRequirements` (spec R10.6, R16a). `stale`: the snapshot in use has not been refreshed
 * for 24 hours; `unknown`: the session is enforced by nothing because no document was ever received.
 * Absent when the session is outside any organization.
 */
export const OrgRequirementsAgentStateSchema = z.object({
  state: z.enum(['ok', 'stale', 'unknown']),
  revision: revision.optional(),
  lastEnforcement: OrgRequirementEnforcementSchema.optional(),
});
export type OrgRequirementsAgentState = z.infer<typeof OrgRequirementsAgentStateSchema>;

/** Machine metadata `orgRequirements`: what this runtime enforces. Absent with `HAPPY_ORG_REQUIREMENTS=off`. */
export const OrgRequirementsCapabilitySchema = z.object({ version: z.literal(1), enforced: z.array(z.string()) });
export type OrgRequirementsCapability = z.infer<typeof OrgRequirementsCapabilitySchema>;
