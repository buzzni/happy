import { createPublicKey, verify } from 'node:crypto';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/orgSetupTokenApproval.v1.json';
import { canonicalOrgSetupTokenJson, parseOrgSetupTokenDocument, orgSetupTokenSigningBytes,
  signOrgSetupTokenDocument, verifyOrgSetupTokenDocument, orgDeviceEnrollmentDigest } from './orgSetupTokenApproval';
const publicKey = Uint8Array.from(Buffer.from(fixture.publicKey, 'base64url'));
const pair = nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(fixture.seed, 'base64url')));

describe('approved org setup-token wire contract', () => {
  for (const vector of fixture.vectors) it(`matches independent Node Ed25519 fixture: ${vector.body.kind}`, async () => {
    expect(canonicalOrgSetupTokenJson(vector.body)).toBe(vector.canonical);
    expect(new TextDecoder().decode(orgSetupTokenSigningBytes(vector.body))).toBe(vector.signingInput);
    const envelope = { body: vector.body, signature: vector.signature };
    expect(await signOrgSetupTokenDocument(vector.body, pair.secretKey)).toEqual(envelope);
    expect(await verifyOrgSetupTokenDocument(JSON.stringify(envelope), publicKey)).toEqual(envelope);
    const nodePublic = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' });
    expect(verify(null, orgSetupTokenSigningBytes(vector.body), nodePublic, Buffer.from(vector.signature, 'base64url'))).toBe(true);
  });
  it('binds the full enrollment transcript and preserves Unicode without normalization', async () => {
    expect(await orgDeviceEnrollmentDigest(fixture.transcript)).toBe(fixture.enrollmentDigest);
    for (const field of ['companyId', 'machineId', 'ownerUserId']) {
      expect(await orgDeviceEnrollmentDigest({ ...fixture.transcript, [field]: 'other' })).not.toBe(fixture.enrollmentDigest);
    }
    expect(canonicalOrgSetupTokenJson({ '10': 10, '2': 2, '\u{10000}': 'a', '\ue000': 'b' })).toBe('{"10":10,"2":2,"𐀀":"a","":"b"}');
    expect(canonicalOrgSetupTokenJson(['é', 'e\u0301', '\n'])).toBe('["é","é","\\n"]');
  });
  it.each([-0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, '\ud800', '\udfff', new Date(), { x: undefined }])('rejects values outside canonical JSON: %s', value => {
    expect(() => canonicalOrgSetupTokenJson(value)).toThrow();
  });
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}'])('rejects duplicate decoded JSON keys before parsing: %s', json => {
    expect(() => parseOrgSetupTokenDocument(json)).toThrow(/duplicate/i);
  });
  it('rejects unknown fields, invalid binary, inconsistent ownership and document size', () => {
    const body = fixture.vectors[0].body;
    for (const mutation of [{ extra: true }, { deviceSigningPublicKey: fixture.publicKey + '=' }, { issuedAt: -0 }, { machineType: 'shared' }, { signingGeneration: 0 }]) {
      expect(() => orgSetupTokenSigningBytes({ ...body, ...mutation })).toThrow();
    }
    expect(() => parseOrgSetupTokenDocument(' '.repeat(65537))).toThrow();
    expect(() => canonicalOrgSetupTokenJson('x'.repeat(65536))).toThrow();
    expect(() => parseOrgSetupTokenDocument(JSON.stringify({ body, signature: fixture.vectors[0].signature, extra: true }))).toThrow();
  });
  it('rejects unsorted/duplicate accounts and nonconsecutive rotation', () => {
    const body = fixture.vectors[1].body;
    const account = body.accounts![0];
    for (const accounts of [[account, account], [{ ...account, managedAccountId: 'z' }, account]]) {
      expect(() => orgSetupTokenSigningBytes({ ...body, accounts })).toThrow();
    }
    expect(() => orgSetupTokenSigningBytes({ ...fixture.vectors[3].body, nextGeneration: 3 })).toThrow();
  });
  it('rejects changed content, different public keys and fake key IDs', async () => {
    const vector = fixture.vectors[0];
    await expect(verifyOrgSetupTokenDocument(JSON.stringify({ body: { ...vector.body, machineId: 'other' }, signature: vector.signature }), publicKey)).rejects.toThrow();
    await expect(verifyOrgSetupTokenDocument(JSON.stringify({ body: vector.body, signature: vector.signature }), nacl.sign.keyPair().publicKey)).rejects.toThrow();
    await expect(signOrgSetupTokenDocument({ ...vector.body, signingKeyId: '0'.repeat(64) }, pair.secretKey)).rejects.toThrow();
  });
});
