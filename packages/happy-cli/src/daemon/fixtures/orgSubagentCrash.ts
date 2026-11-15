/** Isolated process used by orgEndpointSubagentCrash.test. Never connects to a real server or provider. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrgEndpointSubagent, type OrgSubagentRecord } from '../orgEndpointSubagent';
import { createOrgSubagentJournal } from '../orgEndpointSubagentJournal';

const [home, checkpoint] = process.argv.slice(2);
if (!home || !checkpoint) throw Error('Missing isolated crash arguments');
const stop = () => { process.kill(process.pid, 'SIGKILL'); throw Error('SIGKILL was not delivered'); };
const files = createOrgSubagentJournal(home);
const journal = { ...files,
    reserve: async (record: OrgSubagentRecord) => {
        const result = await files.reserve(record);
        if (result.owner && checkpoint === 'reserved') stop();
        return result;
    },
    write: async (record: OrgSubagentRecord) => {
        await files.write(record);
        const reached = checkpoint === 'created' ? record.phase === 'creating-session' && !!record.sessionId : record.phase === checkpoint;
        if (reached) stop();
    },
};
const engine = createOrgEndpointSubagent({ journal, now: Date.now, strict: () => false, localEndpoint: async () => null,
    parent: async () => ({ sessionId: 'parent', launchId: 'launch', orgEndpoint: { endpointId: 'endpoint', generation: 3 } }),
    studio: async (_source, action) => {
        if (action === 'prepare') {
            appendFileSync(join(home, 'prepare-count'), '1\n', { mode: 0o600 });
            return { version: 1, state: 'prepared', selection: { kind: 'org-endpoint', bindingId: 'binding', endpointId: 'endpoint', generation: 3, candidates: ['target'] } };
        }
        if (action === 'launching') return { version: 1, state: 'launching', launchAuthorized: true };
        return { version: 1, state: action === 'started' ? 'started' : 'unknown' };
    }, sync: async () => {}, environment: async () => ({ targetId: 'target', environment: { HAPPY_AI_AUTH_SOURCE: 'org-endpoint' } }),
    createSession: async (_record, save) => { const snapshot = { stable: 'create' }; await save(snapshot); return { sessionId: 'child', snapshot }; },
    start: async () => {
        appendFileSync(join(home, 'provider-count'), '1\n', { mode: 0o600 });
        if (checkpoint === 'after-provider') stop();
        return { sessionId: 'child' };
    },
});
console.log(JSON.stringify(await engine.spawn({ operationId: 'operation', spawnId: 'spawn', sourceSessionId: 'parent', directory: home, agent: 'claude', initialPrompt: 'fixture' })));
