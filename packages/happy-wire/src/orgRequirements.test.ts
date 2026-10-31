import { describe, expect, it } from 'vitest';
import {
  ORG_REQUIREMENT_REASONS,
  OrgRequirementsAgentStateSchema,
  OrgRequirementsEnvelopeSchema,
  OrgRequirementsStatusSchema,
  OrgRequirementsV1Schema,
  orgRequirementsV1CasesFixture,
} from './orgRequirements';

describe('organization requirements wire', () => {
  const parseCases = orgRequirementsV1CasesFixture.parse.cases;

  it('accepts the document Studio serves', () => {
    const accepted = parseCases.find((entry) => entry.name === 'accepts every first-wave item')!;
    expect(OrgRequirementsV1Schema.parse(accepted.document)).toEqual(accepted.document);
  });

  it('rejects the envelopes the case table rejects, so the daemon keeps its last known good', () => {
    const rejected = parseCases.filter((entry) => 'rejected' in entry.expect && entry.expect.rejected);
    expect(rejected.length).toBeGreaterThan(0);
    for (const entry of rejected) expect(OrgRequirementsEnvelopeSchema.safeParse(entry.document).success, entry.name).toBe(false);
  });

  it('leaves item values to the per-item parser', () => {
    // A broken item must not reject the whole document (spec R3): only the envelope is strict here.
    const broken = parseCases.find((entry) => entry.name === 'broken known item keeps the previous value')!;
    expect(OrgRequirementsEnvelopeSchema.safeParse(broken.document).success).toBe(true);
    expect(OrgRequirementsV1Schema.safeParse(broken.document).success).toBe(false);
  });

  it('never accepts an organization allow rule', () => {
    const doc = { schemaVersion: 1, companyId: 'c1', revision: 1, modelPolicyUpdatedAt: null, issuedAt: 1,
      items: { 'tools.rules': { kind: 'rules', rules: [{ id: 'r', tool: 'mcp__a__b', decision: 'allow', since: 1 }] } } };
    expect(OrgRequirementsV1Schema.safeParse(doc).success).toBe(false);
  });

  it('names the four mcp-config response states', () => {
    expect(OrgRequirementsStatusSchema.options).toEqual(['ok', 'no-company', 'unresolved', 'unavailable']);
  });

  it('describes the agentState field Desktop reads', () => {
    const state = {
      state: 'stale',
      revision: 3,
      lastEnforcement: { seq: 2, at: 10, item: 'permissions.mode', requested: 'bypassPermissions', applied: 'default', reason: 'requirement_mode_clamped', revision: 3 },
    };
    expect(OrgRequirementsAgentStateSchema.parse(state)).toEqual(state);
    expect(OrgRequirementsAgentStateSchema.safeParse({ state: 'unknown' }).success).toBe(true);
    expect(OrgRequirementsAgentStateSchema.safeParse({ ...state, lastEnforcement: { ...state.lastEnforcement, reason: 'other' } }).success).toBe(false);
  });

  it('keeps the reason codes the spec and the D1 matrix name', () => {
    for (const reason of ['requirement_model_denied', 'requirement_model_unknown', 'requirement_runtime_unsupported', 'requirement_ceiling', 'org_rule_revision']) {
      expect(ORG_REQUIREMENT_REASONS).toContain(reason);
    }
  });
});
