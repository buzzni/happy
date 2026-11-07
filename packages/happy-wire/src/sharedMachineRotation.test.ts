import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import {
  MachineSetupTokenBindingV2Schema, DaemonRotationRequestBodySchema, rotationSigningBytes,
  rotationIsFresh, rotationDigest, sessionCreateBodyHash, sessionTagHash, sessionExecutionAuthorityDigest,
  signRotationDocument, verifyRotationDocument, daemonRotationOperationDigest,
  SessionExecutionTicketBodySchema, HappySessionCreateProofBodySchema, parseRotationDocument, RotationObservationSchema,
} from './sharedMachineRotation';
import fixture from './fixtures/sharedMachineRotation.v1.json';

describe('portable rotation contract', () => {

  it.each(['claude', 'codex'] as const)('signs provider-neutral execution authority for %s without any provider credential', async agent => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const body = { version: 1, type: 'automation-execution-authority', audience: 'https://studio.test',
      method: 'POST', path: '/api/automation/execution-target', companyId: 'company-1', machineId: 'machine-1',
      approvalId: 'approval-1', deviceKeyId: 'a'.repeat(64), runId: 'run-1', generation: 1, revision: 2,
      displaySessionId: 'manual-1', agent, launchId: 'launch-1', operationId: 'operation-1',
      initialNonce: Buffer.alloc(32, 3).toString('base64url'), sessionOwnerAccountId: 'account-1',
      machineOwnerAccountId: 'account-1', sessionTagHash: 'b'.repeat(64), sessionCreateBodyHash: 'c'.repeat(64),
      issuedAt: 100000, expiresAt: 160000 };
    const digest = await sessionExecutionAuthorityDigest(body);
    expect(digest).toBe('ed8ac166a7214744c9e7fab916555692e17d648315a35ef5c2c5b8359ed00e2c');
    const renewed = { ...body, issuedAt: 90000, expiresAt: 150000 };
    expect(await sessionExecutionAuthorityDigest(renewed)).toBe(digest);
    expect(await sessionExecutionAuthorityDigest({ ...body, initialNonce: Buffer.alloc(32, 4).toString('base64url') })).not.toBe(digest);
    const document = await signRotationDocument(body as never, keys.secretKey);
    await expect(verifyRotationDocument(document, keys.publicKey)).resolves.toEqual(document);
    await expect(verifyRotationDocument({ ...document, body: { ...body, runId: 'another-run' } }, keys.publicKey)).rejects.toThrow();
    expect(() => rotationSigningBytes({ ...body, path: '/v1/sessions' })).toThrow();
    expect(() => rotationSigningBytes({ ...body, managedAccountId: 'must-not-issue-a-provider-account' })).toThrow();
    expect(() => rotationSigningBytes({ ...body, credentialGeneration: 1 })).toThrow();
    expect(() => rotationSigningBytes({ ...body, initialNonce: 'short' })).toThrow();
  });

  it('pins every canonical byte, digest and Ed25519 signature independently of round trips', async () => {
    for (const vector of fixture.vectors) {
      expect(new TextDecoder().decode(rotationSigningBytes(vector.document.body))).toBe(vector.signingText);
      expect(await rotationDigest(vector.document.body)).toBe(vector.digest);
      const key = nacl.sign.keyPair.fromSeed(new Uint8Array(Buffer.from(vector.seed, 'hex')));
      const parsed = await verifyRotationDocument(vector.document, key.publicKey);
      expect(await signRotationDocument(parsed.body, key.secretKey)).toEqual(vector.document);
      expect(await verifyRotationDocument(vector.document, key.publicKey)).toEqual(vector.document);
      await expect(verifyRotationDocument(vector.document, nacl.sign.keyPair().publicKey)).rejects.toThrow();
    }
  });
  it('separates types/audiences and forbids machine userId and request path substitution', () => {
    const binding = fixture.vectors.find(v => v.document.body.type === 'claude-setup-token-binding')!.document.body;
    expect(MachineSetupTokenBindingV2Schema.safeParse({ ...binding, userId: 'machine-1' }).success).toBe(false);
    expect(SessionExecutionTicketBodySchema.safeParse(binding).success).toBe(false);
    expect(HappySessionCreateProofBodySchema.safeParse(binding).success).toBe(false);
    const issue = fixture.vectors.find(v => 'action' in v.document.body && v.document.body.action === 'issue')!.document.body;
    expect(DaemonRotationRequestBodySchema.safeParse({ ...issue, path: '/api/claude-setup-token/daemon/v2/claim' }).success).toBe(false);
    expect(() => rotationSigningBytes({ ...issue, surprise: true })).toThrow();
  });
  it('asks a rebind either with usage evidence or for start budget, never both or neither', () => {
    const rebind = fixture.vectors.find(v => 'action' in v.document.body && v.document.body.action === 'rebind')!.document.body as Record<string, unknown>;
    const { observation, ...bare } = rebind;
    expect(DaemonRotationRequestBodySchema.safeParse(rebind).success).toBe(true);
    expect(DaemonRotationRequestBodySchema.safeParse({ ...bare, startBudget: true }).success).toBe(true);
    expect(DaemonRotationRequestBodySchema.safeParse({ ...rebind, startBudget: true }).success).toBe(false);
    expect(DaemonRotationRequestBodySchema.safeParse(bare).success).toBe(false);
    expect(DaemonRotationRequestBodySchema.safeParse({ ...bare, startBudget: false }).success).toBe(false);
    expect(observation).toBeTruthy();
  });
  it('limits TTL to 60 seconds, accepts bounded future issue skew, never accepts expiry', () => {
    expect(rotationIsFresh({ issuedAt: 100000, expiresAt: 160000 }, 100000)).toBe(true);
    expect(rotationIsFresh({ issuedAt: 100000, expiresAt: 160000 }, 40000)).toBe(true);
    expect(rotationIsFresh({ issuedAt: 100000, expiresAt: 160000 }, 39999)).toBe(false);
    expect(rotationIsFresh({ issuedAt: 100000, expiresAt: 160000 }, 160000)).toBe(false);
    expect(rotationIsFresh({ issuedAt: 100000, expiresAt: 160001 }, 110000)).toBe(false);
  });
  it('binds exact encrypted fields, presence and tag bytes; operation refresh changes no selection', async () => {
    expect(await sessionTagHash(fixture.createBody.tag)).toBe(fixture.sessionTagHash);
    expect(await sessionCreateBodyHash(fixture.createBody)).toBe(fixture.sessionCreateBodyHash);
    expect(await sessionCreateBodyHash({ ...fixture.createBody, agentState: null })).not.toBe(fixture.sessionCreateBodyHash);
    expect(await sessionCreateBodyHash({ ...fixture.createBody, metadata: 'altered' })).not.toBe(fixture.sessionCreateBodyHash);
    const issue = fixture.vectors.find(v => 'action' in v.document.body && v.document.body.action === 'issue')!.document.body;
    const parsed = DaemonRotationRequestBodySchema.parse(issue);
    expect(await daemonRotationOperationDigest(parsed)).toBe(await daemonRotationOperationDigest({ ...parsed, issuedAt: parsed.issuedAt + 1, expiresAt: parsed.expiresAt + 1 }));
    expect(await daemonRotationOperationDigest(parsed)).not.toBe(await daemonRotationOperationDigest({ ...parsed, launchId: 'other' }));
  });
  it('rejects duplicate signed JSON keys, malformed binary and non-account-wide usage inventions', async () => {
    const vector = fixture.vectors[0];
    const json = JSON.stringify(vector.document);
    expect(() => parseRotationDocument(json.replace('"version":2', '"version":2,"version":2'))).toThrow('Duplicate');
    expect(() => parseRotationDocument(json.replace('"version":2', '"version":2,"\\u0076ersion":2'))).toThrow('Duplicate');
    await expect(verifyRotationDocument({ ...vector.document, signature: vector.document.signature + '=' }, new Uint8Array(32))).rejects.toThrow();
    const observation = { observationId: 'o', observedAt: 1, managedAccountId: 'a', credentialGeneration: 1, windows: [], accountWideRefusal: null };
    expect(RotationObservationSchema.safeParse(observation).success).toBe(false);
    expect(RotationObservationSchema.safeParse({ ...observation, accountWideRefusal: 'account_limit' }).success).toBe(true);
    expect(RotationObservationSchema.safeParse({ ...observation, accountWideRefusal: 'authentication_failed' }).success).toBe(true);
    expect(RotationObservationSchema.safeParse({ ...observation, accountWideRefusal: 'throttle' }).success).toBe(false);
  });

});

it('accepts start exhaustion only as an exclusive signed rebind reason', () => {
 const base=fixture.vectors.find(v=>'action' in v.document.body&&v.document.body.action==='claim')!.document.body
 const body={...base,action:'rebind',path:'/api/claude-setup-token/daemon/v2/rebind',startExhausted:true}
 expect(DaemonRotationRequestBodySchema.safeParse(body).success).toBe(true)
 expect(DaemonRotationRequestBodySchema.safeParse({...body,startBudget:true}).success).toBe(false)
})
