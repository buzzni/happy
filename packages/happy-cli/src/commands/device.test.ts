import { expect, it, vi } from 'vitest';
import { handleDeviceCommand } from './device';
const digest='abcdef0123456789'.repeat(4);
function fixture(){return {status:vi.fn(async()=>({machineId:'machine',companyId:'company',enrollment:{digest,expiresAt:1000,locallyConfirmed:false,administratorApproved:false},pin:null})),confirm:vi.fn(async()=>({locallyConfirmed:true})),print:vi.fn()};}
it('shows the entire grouped fingerprint and distinguishes administrator and local waiting states',async()=>{
 const deps=fixture();await handleDeviceCommand(['status','--company-id','company'],deps);
 expect(deps.status).toHaveBeenCalledWith('company');
 const output=deps.print.mock.calls.flat().join('\n');
 expect(output).toContain(digest.match(/.{4}/g)!.join(' '));
 expect(output).toContain('machine');expect(output).toContain('company');
 expect(output).toContain('관리자 승인 대기');expect(output).toContain('로컬 확인 대기');
 expect(deps.confirm).not.toHaveBeenCalled();
});
it('requires explicit organization, machine and full fingerprint before local confirmation',async()=>{
 const deps=fixture();
 for(const args of [[],['confirm'],['confirm','--company-id','company','--machine-id','machine','--digest','abcdef'],['confirm','--company-id','company','--machine-id','machine','--digest',digest,'--remote','host']]) await expect(handleDeviceCommand(args,deps)).rejects.toThrow();
 expect(deps.confirm).not.toHaveBeenCalled();
 await handleDeviceCommand(['confirm','--company-id','company','--machine-id','machine','--digest',digest],deps);
 expect(deps.confirm).toHaveBeenCalledWith({companyId:'company',machineId:'machine',enrollmentDigest:digest});
 expect(deps.status).not.toHaveBeenCalled();
 expect(deps.print).toHaveBeenCalledWith(expect.stringContaining('로컬 확인이 완료되었습니다'));
});
it('does not print confirmation success or raw transport secrets on failure',async()=>{
 const deps=fixture();deps.confirm.mockRejectedValueOnce(new Error('private-control-secret'));
 await expect(handleDeviceCommand(['confirm','--company-id','company','--machine-id','machine','--digest',digest],deps)).rejects.toThrow('DEVICE_CONTROL_UNAVAILABLE');
 expect(deps.print).not.toHaveBeenCalled();
});
// aplus specs/shared-machine-server-signing S6b — the PC's own one-step "use as the organization's shared PC".
it('marks this PC as the organization\'s shared PC with one explicit command and says whether the key is already pinned',async()=>{
 for(const [confirmed,expected] of [[true,'조직 키가 저장되었습니다'],[false,'서버 승인이 오면 자동으로 확인됩니다']] as const){
  const deps={...fixture(),useAsShared:vi.fn(async()=>({accepted:true as const,confirmed,declined:false}))};
  await handleDeviceCommand(['use-as-shared','--company-id','company'],deps);
  expect(deps.useAsShared).toHaveBeenCalledWith('company');
  expect(deps.print).toHaveBeenCalledWith(expect.stringContaining(expected));
 }
 const deps={...fixture(),useAsShared:vi.fn()};
 for(const args of [['use-as-shared'],['use-as-shared','--company-id','company','--machine-id','m']]) await expect(handleDeviceCommand(args,deps)).rejects.toThrow();
 expect(deps.useAsShared).not.toHaveBeenCalled();
});
it('tells the user to compare the fingerprint when the PC was marked but the automatic check declined',async()=>{
 const deps={...fixture(),useAsShared:vi.fn(async()=>({accepted:true as const,confirmed:false,declined:true}))};
 await handleDeviceCommand(['use-as-shared','--company-id','company'],deps);
 expect(deps.print).toHaveBeenCalledWith(expect.stringContaining('happy device status'));
 expect(deps.print).not.toHaveBeenCalledWith(expect.stringContaining('자동으로 확인됩니다'));
});
it('explains a failure after the PC was marked differently from a refusal',async()=>{
 for(const [code,expected] of [['DEVICE_PIN_PERSIST_FAILED','조직 키를 저장하지 못했습니다'],['DEVICE_ENROLLMENT_EXPIRED','등록 요청이 만료되었거나 바뀌었습니다'],['DEVICE_USE_AS_SHARED_UNAVAILABLE','자동 확인을 할 수 없습니다']] as const){
  const deps={...fixture(),useAsShared:vi.fn(async()=>{throw new Error(code);})};
  await expect(handleDeviceCommand(['use-as-shared','--company-id','company'],deps)).rejects.toThrow(expected);
 }
});
it('explains a refusal without claiming the PC was marked',async()=>{
 const deps={...fixture(),useAsShared:vi.fn(async()=>{throw new Error('DEVICE_USE_AS_SHARED_REFUSED');})};
 await expect(handleDeviceCommand(['use-as-shared','--company-id','company'],deps)).rejects.toThrow('이미 공용·전용으로 표시된 PC이거나');
 expect(deps.print).not.toHaveBeenCalled();
});
