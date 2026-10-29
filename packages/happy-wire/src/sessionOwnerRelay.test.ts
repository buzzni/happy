import { describe, expect, it } from 'vitest';
import fixture from './fixtures/sessionOwnerRelay.v1.json';
import { OwnershipRelayContactSchema } from './sessionOwnership';
import { OwnerRelayRequestSchema, OwnerRelayReplySchema, OwnerContactRequestSchema } from './sessionOwnerRelay';
const copy = <T>(v: T): T => structuredClone(v);
describe('owner relay strict wire', () => {
  for (const { request, reply } of fixture.vectors) {
    it(`accepts ${request.operation} without stripping data`, () => {
      expect(OwnerRelayRequestSchema.parse(request)).toEqual(request);
      expect(OwnerRelayReplySchema.parse(reply)).toEqual(reply);
      const { operation, payload, targetSessionId, localId } = request;
      expect(OwnerContactRequestSchema.safeParse({ v: 1, entry: 'chat', operation, payload,
        ...(targetSessionId ? { targetSessionId } : {}), ...(localId ? { localId } : {}) }).success).toBe(true);
    });
    it(`rejects extra fields and mismatched payload for ${request.operation}`, () => {
      expect(OwnerRelayRequestSchema.safeParse({ ...request, bearer: 'secret' }).success).toBe(false);
      expect(OwnerRelayRequestSchema.safeParse({ ...request, payload: { ...request.payload, rpcMethod: 'exec' } }).success).toBe(false);
      expect(OwnerRelayReplySchema.safeParse({ ...reply, unrelated: true }).success).toBe(false);
      expect(OwnerRelayReplySchema.safeParse({ ...reply, result: 'unavailable' }).success).toBe(false);
      expect(OwnerRelayReplySchema.safeParse({ ...reply, ...(reply.operation === 'prompt-own-session' ? { owners: [] } : { storage: fixture.vectors[2].reply.storage }) }).success).toBe(false);
    });
  }
  it('uses the existing contact and method contract', () => {
    expect(OwnershipRelayContactSchema.safeParse(fixture.contact).success).toBe(true);
    expect(OwnershipRelayContactSchema.safeParse({ ...fixture.contact, method: 'uuid:owner-relay-v1' }).success).toBe(false);
  });
  it('rejects local source injection, unknown versions and verbs', () => {
    const r = { v: 1, entry: 'agent', operation: 'lookup-readable-sessions', payload: { sessionIds: [] } };
    expect(OwnerContactRequestSchema.safeParse(r).success).toBe(true);
    for (const field of ['sourceHubSessionId', 'sourceAuthority', 'sourceRuntimeId', 'callerBindingId', 'hostEpoch', 'scope', 'depth']) {
      expect(OwnerContactRequestSchema.safeParse({ ...r, [field]: 'injected' }).success).toBe(false);
    }
    expect(OwnerContactRequestSchema.safeParse({ ...r, v: 2 }).success).toBe(false);
    expect(OwnerContactRequestSchema.safeParse({ ...r, operation: 'stop-session' }).success).toBe(false);
  });
  it('requires prompt target/localId and binds guard target', () => {
    const r = fixture.vectors[2].request;
    for (const k of ['targetSessionId', 'localId']) { const v = { ...r }; delete v[k as keyof typeof v]; expect(OwnerRelayRequestSchema.safeParse(v).success).toBe(false); }
    expect(OwnerRelayRequestSchema.safeParse({ ...r, targetSessionId: 'another' }).success).toBe(false);
    expect(OwnerRelayRequestSchema.safeParse({ ...r, localId: '공백 불가' }).success).toBe(false);
  });
  it('requires started identity and confirmed authority for child operations', () => {
    for (const i of [6, 7]) {
      const r = fixture.vectors[i];
      expect(OwnerRelayRequestSchema.safeParse({ ...r.request, sourceAuthority: fixture.vectors[1].request.sourceAuthority }).success).toBe(false);
      for (const key of ['sessionId', 'ownershipBindingId', 'providerRuntimeId']) {
        const v = copy(r.reply); (v.childSpawn as any)[key] = null;
        expect(OwnerRelayReplySchema.safeParse(v).success).toBe(false);
      }
      const pending = copy(r.reply); pending.childSpawn!.state = 'pending'; pending.childSpawn!.stage = 'created'; pending.childSpawn!.providerRuntimeId = null as any;
      expect(OwnerRelayReplySchema.safeParse(pending).success).toBe(true);
    }
  });
  it('requires result payload only on allowed', () => {
    const r = fixture.vectors[0].reply;
    const { owners, ...rest } = r;
    expect(OwnerRelayReplySchema.safeParse(rest).success).toBe(false);
    for (const result of ['not_owned', 'unavailable', 'unknown']) expect(OwnerRelayReplySchema.safeParse({ ...rest, result }).success).toBe(true);
  });
});

describe('relay wire limits and existing dynamic data', () => {
  it.each([0, 100, 101])('lookup bounds: %i candidates', n => {
    const r = { ...fixture.vectors[0].request, payload: { sessionIds: Array.from({ length: n }, (_, i) => `s-${i}`) } };
    expect(OwnerRelayRequestSchema.safeParse(r).success).toBe(n <= 100);
    const reply = { ...fixture.vectors[0].reply, owners: Array.from({ length: n }, () => fixture.vectors[0].reply.owners![0]) };
    expect(OwnerRelayReplySchema.safeParse(reply).success).toBe(n <= 100);
  });
  it.each([0, 1, 50, 51, 1.5])('read limit %s', limit => {
    const r = fixture.vectors[1].request;
    expect(OwnerRelayRequestSchema.safeParse({ ...r, payload: { ...r.payload, limit } }).success).toBe(Number.isInteger(limit) && limit >= 1 && limit <= 50);
  });
  it.each([-1, 0, 15000, 15001, 0.5])('read wait %s', waitMs => {
    const r = fixture.vectors[1].request;
    expect(OwnerRelayRequestSchema.safeParse({ ...r, payload: { ...r.payload, waitMs } }).success).toBe(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 15000);
  });
  it.each(['a', '한', '🌍'])('64KiB complete request and 128KiB reply in UTF-8 (%s)', character => {
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    const request: any = copy(fixture.vectors[4].request);
    request.payload.updatedInput = { value: '' };
    const spare = 65536 - bytes(request), unit = new TextEncoder().encode(character).length;
    request.payload.updatedInput.value = character.repeat(Math.floor(spare / unit)) + 'a'.repeat(spare % unit);
    expect(bytes(request)).toBe(65536);
    expect(OwnerRelayRequestSchema.safeParse(request).success).toBe(true);
    request.payload.updatedInput.value += 'a';
    expect(OwnerRelayRequestSchema.safeParse(request).success).toBe(false);
    const reply: any = copy(fixture.vectors[1].reply);
    reply.sessionView.snapshot.pendingPermissionRequests[0].arguments = { value: '' };
    const remaining = 131072 - bytes(reply);
    reply.sessionView.snapshot.pendingPermissionRequests[0].arguments.value = character.repeat(Math.floor(remaining / unit)) + 'a'.repeat(remaining % unit);
    expect(bytes(reply)).toBe(131072);
    expect(OwnerRelayReplySchema.safeParse(reply).success).toBe(true);
    reply.sessionView.snapshot.pendingPermissionRequests[0].arguments.value += 'a';
    expect(OwnerRelayReplySchema.safeParse(reply).success).toBe(false);
  });
  it.each([undefined, NaN, Infinity, 1n, new Date(), () => 1, '\ud800'])('rejects non-JSON or invalid Unicode tool value %s', value => {
    const request: any = copy(fixture.vectors[4].request);
    request.payload.updatedInput = { value };
    expect(OwnerRelayRequestSchema.safeParse(request).success).toBe(false);
  });
  it('preserves existing nested tool data, nulls, fractional and negative JSON numbers', () => {
    const r: any = copy(fixture.vectors[4].request);
    r.payload.updatedInput = { arguments: [null, true, -1.25, { '10': 10, '2': 2 }], answers: { q: ['가', '🌍'] } };
    expect(OwnerRelayRequestSchema.parse(r)).toEqual(r);
  });
  it('preserves existing legacy message fields instead of silently stripping transcript data', () => {
    const r: any = copy(fixture.vectors[1].reply);
    r.sessionView.events = [{ id: 'm', seq: 1, localId: null, createdAt: 1, updatedAt: 1,
      content: { role: 'agent', content: { type: 'assistant', message: { content: [{ type: 'tool_use', input: { x: -1.5 } }] } } } }];
    expect(OwnerRelayReplySchema.parse(r)).toEqual(r);
  });
});

it('preserves all JSON keys in existing permission data, including prototype-looking keys', () => {
  const r: any = copy(fixture.vectors[4].request);
  r.payload.updatedInput = JSON.parse('{"__proto__":{"tool":"value"},"constructor":{"answer":1},"prototype":null}');
  expect(OwnerRelayRequestSchema.parse(r)).toEqual(r);
});
