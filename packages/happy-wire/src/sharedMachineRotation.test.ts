import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import {
  MachineSetupTokenBindingV2Schema, DaemonRotationRequestBodySchema, rotationSigningBytes,
  rotationIsFresh, rotationDigest, sessionCreateBodyHash, sessionTagHash,
  signRotationDocument, verifyRotationDocument, daemonRotationOperationDigest,
  SessionExecutionTicketBodySchema, HappySessionCreateProofBodySchema, parseRotationDocument, RotationObservationSchema,
} from './sharedMachineRotation';
import fixture from './fixtures/sharedMachineRotation.v1.json';

describe('portable rotation contract', () => {
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
    expect(RotationObservationSchema.safeParse({ ...observation, accountWideRefusal: 'throttle' }).success).toBe(false);
  });

});
