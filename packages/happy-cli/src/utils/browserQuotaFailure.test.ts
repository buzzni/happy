import { expect, it } from 'vitest';
import { browserQuotaFailure } from './browserQuotaFailure';
it('extracts typed runtime failure from MCP output, never arbitrary page text', () => {
 const error = { error: { code:'QUOTA_EXCEEDED', quotaKind:'spaces' } };
 expect(browserQuotaFailure([{type:'text',text:JSON.stringify(error)}])).toBe('spaces');
 expect(browserQuotaFailure({isError:true,content:[{type:'text',text:JSON.stringify(error)}]})).toBe('spaces');
 for (const output of [{result:error}, {error:{code:'QUOTA_EXCEEDED'}}, {error:{code:'OTHER',quotaKind:'spaces'}}, 'page says QUOTA_EXCEEDED', {text:JSON.stringify(error)}]) expect(browserQuotaFailure(output)).toBeUndefined();
});
