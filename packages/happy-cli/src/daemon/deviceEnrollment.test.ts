import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { createDeviceEnrollment } from './deviceEnrollment';
import { canonicalOrgSetupTokenJson, signOrgSetupTokenDocument, orgSetupTokenKeyId } from '@slopus/happy-wire';
const input = () => ({ companyId: 'company', machineType: 'dedicated' as const, ownerUserId: 'user', orgSigningPublicKey: Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url'), signingGeneration: 1 });
function fixture(store?: Parameters<typeof createDeviceEnrollment>[0]['store']) { let now = 1000; const keys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() }; return { keys, state: createDeviceEnrollment({ machineId: 'machine', keys, store, now: () => now }), advance: (value: number) => { now = value; } }; }
it('binds local identity and fresh nonce in a verifiable enrollment proof', async () => {
 const { state, keys } = fixture(); const request = input();
 const first = await state.begin(request);
 expect(first.transcript).toMatchObject({ machineId: 'machine', companyId: 'company', ownerUserId: 'user', expiresAt: 601000 });
 expect(Buffer.from(first.transcript.enrollmentNonce, 'base64url')).toHaveLength(32);
 const bytes = new TextEncoder().encode('saycode/device-enrollment/v1\n' + canonicalOrgSetupTokenJson(first.transcript));
 expect(nacl.sign.detached.verify(bytes, Buffer.from(first.proof, 'base64url'), keys.signing.publicKey)).toBe(true);
 const second = await state.begin(request);
 expect(second.digest).not.toBe(first.digest);
 expect(() => state.confirm({ companyId: 'company', machineId: 'machine', enrollmentDigest: first.digest })).toThrow();
});
it('requires exact local confirmation and expires at the ten-minute boundary', async () => {
 const { state, advance } = fixture(); const pending = await state.begin(input());
 expect(state.status()?.locallyConfirmed).toBe(false);
 for(const change of [{companyId:'other'},{machineId:'other'},{enrollmentDigest:'0'.repeat(64)}]) expect(() => state.confirm({companyId:'company',machineId:'machine',enrollmentDigest:pending.digest,...change})).toThrow();
 state.confirm({companyId:'company',machineId:'machine',enrollmentDigest:pending.digest});
 expect(state.status()?.locallyConfirmed).toBe(true);
 advance(601000);expect(state.status()).toBeNull();
 expect(() => state.confirm({companyId:'company',machineId:'machine',enrollmentDigest:pending.digest})).toThrow(/EXPIRED/);
});
it('does not let callers mutate the stored transcript or retain confirmation after restarting enrollment', async () => {
 const {state}=fixture();const request=input(); const first=await state.begin(request);
 first.transcript.ownerUserId='attacker';expect(state.status()?.transcript.ownerUserId).toBe('user');
 state.confirm({companyId:'company',machineId:'machine',enrollmentDigest:first.digest});
 await state.begin({...request,ownerUserId:'new-owner'});expect(state.status()?.locallyConfirmed).toBe(false);
});
it('rejects unknown input, invalid ownership, and confirmation before enrollment', async () => {
 const {state}=fixture();expect(()=>state.confirm({companyId:'company',machineId:'machine',enrollmentDigest:'0'.repeat(64)})).toThrow();
 await expect(state.begin({...input(),machineType:'shared'})).rejects.toThrow();
 await expect(state.begin({...input(),extra:true} as any)).rejects.toThrow();
});
it('keeps only the latest overlapping enrollment and accepts shared machines only without an owner', async () => {
 const {state}=fixture();const request=input();
 const results=await Promise.allSettled([state.begin(request),state.begin({...request,machineType:'shared',ownerUserId:null})]);
 expect(results[0].status).toBe('rejected');expect(results[1].status).toBe('fulfilled');
 expect(state.status()?.transcript).toMatchObject({machineType:'shared',ownerUserId:null});
});

async function approvalFixture(store?: Parameters<typeof createDeviceEnrollment>[0]['store']) {
 const f = fixture(store); const signer = nacl.sign.keyPair();
 const pending = await f.state.begin({...input(), orgSigningPublicKey: Buffer.from(signer.publicKey).toString('base64url')});
 const {transcript: t} = pending;
 const body = {version:1 as const, kind:'device-approval' as const, companyId:t.companyId, signingGeneration:t.signingGeneration,
  issuedAt:1000, approvalId:'approval', approvalRevision:1, machineId:t.machineId, machineType:t.machineType,
  ownerUserId:t.ownerUserId, deviceSigningPublicKey:t.deviceSigningPublicKey, recipientPublicKey:t.recipientPublicKey, enrollmentDigest:pending.digest};
 const sign = async (change = {}, key = signer.secretKey) => JSON.stringify(await signOrgSetupTokenDocument({...body,signingKeyId:await orgSetupTokenKeyId(nacl.sign.keyPair.fromSecretKey(key).publicKey),...change}, key));
 const confirm = () => f.state.confirm({companyId:t.companyId,machineId:t.machineId,enrollmentDigest:pending.digest});
 return {...f, pending, sign, confirm};
}
it('requires both verified administrator approval and local confirmation in either order', async () => {
 for (const localFirst of [false,true]) {
  const f=await approvalFixture();expect(f.state.status()?.readyToPin).toBe(false);
  if(localFirst) f.confirm(); else await f.state.approve(await f.sign());
  expect(f.state.status()?.readyToPin).toBe(false);
  if(localFirst) await f.state.approve(await f.sign()); else f.confirm();
  expect(f.state.status()?.readyToPin).toBe(true);
 }
});
it('rejects correctly signed approvals for a different enrollment identity or generation', async () => {
 const f=await approvalFixture(); f.confirm();
 for(const change of [{companyId:'other'},{machineId:'other'},{machineType:'shared',ownerUserId:null},{ownerUserId:'other'},
  {deviceSigningPublicKey:Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url')},
  {recipientPublicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64url')},
  {signingGeneration:2},{enrollmentDigest:'0'.repeat(64)}]) {
  await expect(f.state.approve(await f.sign(change))).rejects.toThrow(/MISMATCH/);
  expect(f.state.status()?.readyToPin).toBe(false);
 }
 await expect(f.state.approve(await f.sign({},nacl.sign.keyPair().secretKey))).rejects.toThrow();
 expect(f.state.status()?.readyToPin).toBe(false);
});
it('does not reuse verified approval after replacement or expiry during signature verification', async () => {
 const f=await approvalFixture();const signed=await f.sign(); f.confirm();
 const verifying=f.state.approve(signed);f.advance(601000);
 await expect(verifying).rejects.toThrow(/EXPIRED/);
 f.advance(1000);const replacing=f.state.approve(signed);const beginning=f.state.begin(input());
 await expect(replacing).rejects.toThrow(/REPLACED/);await beginning;
 expect(f.state.status()?.readyToPin).toBe(false);
});
it('keeps approval snapshots isolated and drops both conditions on re-enrollment', async () => {
 const f=await approvalFixture();await f.state.approve(await f.sign());f.confirm();
 const status=f.state.status()!;status.approval!.body.companyId='tampered';
 expect(f.state.status()?.approval?.body.companyId).toBe('company');
 await f.state.begin(input());expect(f.state.status()).toMatchObject({locallyConfirmed:false,approval:null,readyToPin:false});
});

it('rejects a forged signature without turning local confirmation into approval', async () => {
 const f=await approvalFixture();f.confirm();const forged=JSON.parse(await f.sign());
 forged.signature=Buffer.alloc(64).toString('base64url');
 await expect(f.state.approve(JSON.stringify(forged))).rejects.toThrow(/signature/i);
 expect(f.state.status()).toMatchObject({locallyConfirmed:true,approval:null,readyToPin:false});
});
it('accepts identical approval retries but never replaces an accepted candidate with conflicting revision content', async () => {
 const f=await approvalFixture();const signed=await f.sign();await f.state.approve(signed);
 await expect(f.state.approve(signed)).resolves.toBeUndefined();
 await expect(f.state.approve(await f.sign({approvalId:'different'}))).rejects.toThrow(/CONFLICT/);
 expect(f.state.status()?.approval?.body.approvalId).toBe('approval');
});

it('persists only after both confirmations and does not report a pin on disk failure', async () => {
 for(const localFirst of [false,true]) {
  const store={get:vi.fn().mockResolvedValue(null),pin:vi.fn().mockRejectedValueOnce(new Error('disk failure')).mockResolvedValue(undefined)};
  const f=await approvalFixture(store);const signed=await f.sign();
  if(localFirst) await f.confirm();else await f.state.approve(signed);
  expect(store.pin).not.toHaveBeenCalled();
  await expect(localFirst ? f.state.approve(signed) : f.confirm()).rejects.toThrow('DEVICE_PIN_PERSIST_FAILED');
  expect(f.state.status()?.pinned).toBe(false);
  await f.confirm();expect(f.state.status()?.pinned).toBe(true);expect(store.pin).toHaveBeenCalledTimes(2);
  await f.confirm();expect(store.pin).toHaveBeenCalledTimes(2);
 }
});
it('blocks re-enrollment during persistence and rejects enrollment over a stored pin',async()=>{
 let finish!:()=>void;const store={get:vi.fn().mockResolvedValue(null),pin:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}))};
 const f=await approvalFixture(store);await f.state.approve(await f.sign());const saving=f.confirm();
 await expect(f.state.begin(input())).rejects.toThrow('DEVICE_PIN_PENDING');
 expect(f.state.status()?.pinned).toBe(false);finish();await saving;
 store.get.mockResolvedValue({policy:'signed-required'});
 await expect(f.state.begin(input())).rejects.toThrow('ORG_ALREADY_PINNED');
});

it('returns only public local status for the requested organization and reads persistent pins after restart',async()=>{
 const store={get:vi.fn().mockResolvedValue(null),pin:vi.fn().mockResolvedValue(undefined)};
 const f=await approvalFixture(store);
 const waiting=await f.state.getStatus('company');
 expect(waiting).toMatchObject({machineId:'machine',companyId:'company',enrollment:{digest:f.pending.digest,administratorApproved:false,locallyConfirmed:false},pin:null});
 expect(JSON.stringify(waiting)).not.toContain(f.pending.proof);
 expect((await f.state.getStatus('other')).enrollment).toBeNull();
 const approval=JSON.parse(await f.sign());store.get.mockResolvedValue({publicKey:f.pending.transcript.orgSigningPublicKey,policy:'signed-required',approval});
 const restarted=createDeviceEnrollment({machineId:'machine',keys:f.keys,store});
 expect(await restarted.getStatus('company')).toMatchObject({enrollment:null,pin:{policy:'signed-required',approvalId:'approval',signingGeneration:1}});
 await expect(restarted.getStatus('')).rejects.toThrow();
});

it('acknowledges only the exact persisted approval after expiry or restart without writing again',async()=>{
 const store={get:vi.fn().mockResolvedValue(null),pin:vi.fn().mockResolvedValue(undefined)};
 const f=await approvalFixture(store);const signed=await f.sign();
 const pin={publicKey:f.pending.transcript.orgSigningPublicKey,policy:'signed-required',approval:JSON.parse(signed)};
 store.get.mockResolvedValue(pin);
 const restarted=createDeviceEnrollment({machineId:'machine',keys:f.keys,store});
 await expect(restarted.approve(signed)).resolves.toBeUndefined();
 await expect(restarted.approve(await f.sign({approvalId:'different'}))).rejects.toThrow();
 expect(store.pin).not.toHaveBeenCalled();
});
