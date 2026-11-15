import { describe, it, expect } from 'vitest'
import { parseOrgLlmModelBinding } from './orgLlmModelBinding'
const body = {version:1,bindingId:'binding-a',snapshotId:'snap-a',machineId:'machine',maxOutputTokens:8192,selectedModel:'creator/model:edition',launchSecret:'s'.repeat(64),companyId:'co',userId:'user',endpoint:{id:'endpoint',generation:1,model:'creator/model:edition',models:{},maxContextTokens:200000,apiTimeoutMs:600000,authMode:'static-token',token:'secret',targets:[{id:'target',url:'https://apis.opengateway.ai'}]}}
describe('immutable model binding',()=>{
 it('preserves exact model ID independently of endpoint cache',()=>{expect(parseOrgLlmModelBinding(body)).toMatchObject({bindingId:'binding-a',selectedModel:'creator/model:edition',entry:{model:'creator/model:edition'}})})
 it.each([{selectedModel:'other/model'},{endpoint:{...body.endpoint,targets:[{id:'target',url:'https://evil.example'}]}},{bindingId:'../escape'},{launchSecret:''}])('refuses mismatched or unsafe snapshots %j',patch=>{expect(()=>parseOrgLlmModelBinding({...body,...patch})).toThrow()})
})
