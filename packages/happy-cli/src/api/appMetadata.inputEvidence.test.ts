import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { inputEvidenceMetadata, resolveRecoveredInputEvidenceEnvironment } from '@/utils/inputEvidenceSettings';

// Execute the real app schema, session encryption/cache, title transform and
// CAS writer. Only their transport/crypto adapter is supplied by this harness;
// no mobile runtime or copied consumer implementation is involved.
const appRoot = new URL('../../../happy-app/sources/sync/', import.meta.url);
function appNode(file: string, matches: (node: ts.Node, source: ts.SourceFile) => boolean): string {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, appRoot), 'utf8'), ts.ScriptTarget.Latest, true);
    let found: ts.Node | undefined;
    const visit = (node: ts.Node) => {
        if (matches(node, source)) found = node;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`Production node not found in ${file}`);
    return found.getText(source);
}
function evaluate(code: string, result: string, dependencies: Record<string, unknown> = {}): any {
    const compiled = ts.transpileModule(code.replace(/^export\s+/, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return Function(...Object.keys(dependencies), `${compiled}; return ${result};`)(...Object.values(dependencies));
}
const metadataDeclaration = appNode('storageTypes.ts', n => ts.isVariableDeclaration(n) && n.name.getText() === 'MetadataSchema');
const MetadataSchema = evaluate(`const ${metadataDeclaration};`, 'MetadataSchema', { z });
const EncryptionCache = evaluate(appNode('encryption/encryptionCache.ts', n => ts.isClassDeclaration(n) && n.name?.text === 'EncryptionCache'), 'EncryptionCache');
const SessionEncryption = evaluate(appNode('encryption/sessionEncryption.ts', n => ts.isClassDeclaration(n) && n.name?.text === 'SessionEncryption'), 'SessionEncryption', { MetadataSchema, decodeBase64, encodeBase64 });
const titleTransform = appNode('storage.ts', (n, source) => ts.isObjectLiteralExpression(n)
    && n.getText(source).includes('...session.metadata,') && n.getText(source).includes('text: newTitle')
    && !n.getText(source).includes('...state'));
const changeTitle = (metadata: any, title: string) => evaluate(`const updated = ${titleTransform};`, 'updated', { session: { metadata }, newTitle: title });
const ackTransform = appNode('storage.ts', (n, source) => ts.isArrowFunction(n)
    && n.parameters[0]?.name.getText(source) === 'result' && n.body.getText(source).includes('metadataVersion: result.version'));
function applyTitleAck(metadata: any, metadataVersion: number, result: any): any {
    let state: any = { sessions: { original: { metadata, metadataVersion } } };
    const apply = evaluate(`const apply = ${ackTransform};`, 'apply', {
        sessionId: 'original', set: (update: (state: any) => any) => { state = update(state); },
    });
    apply(result);
    return state.sessions.original;
}
const writer = appNode('ops.ts', n => ts.isFunctionDeclaration(n) && n.name?.text === 'sessionUpdateMetadata');

describe.each(['claude', 'codex'])('T2RT-29 %s producer/app/recovery round trip', flavor => {
    for (const conflict of [false, true]) for (const enabled of [false, true]) {
        it.each([undefined, '0'])(`title write, CAS conflict=${conflict}, ON=${enabled}, recovery override=%s`, async override => {
            const contact = { v: 1, runtimeId: 'original-runtime', principal: 'account', prompt: true, steer: true,
                inputEvidence: 1, guardedPrompt: 1, mode: 'remote', modeEpoch: 1 };
            let server: any = inputEvidenceMetadata<Record<string, unknown> & { inputEvidenceEnabled?: boolean }>({ path: '/workspace/owned', host: 'owned-machine', flavor,
                ...(flavor === 'claude' ? { claudeSessionId: 'native-owner' } : { codexThreadId: 'native-owner' }),
                runtimeCapabilities: { saycodeSystemPromptPreference: true, futureCapability: { revision: 1 }, ...(enabled ? { agentContact: contact } : {}) },
                summary: { text: 'old title', updatedAt: 1, branchSlug: 'old-branch', futureSummary: 'old-summary' },
                models: [{ code: 'model', value: 'model', futureModel: 'preserve' }],
                futureProviderState: { revision: 1 },
            }, enabled);
            let version = 1;
            let conflicted = false;
            const key = new Uint8Array(32).fill(7);
            const seal = (value: unknown) => encodeBase64(encrypt(key, 'legacy', value));
            const open = (value: string) => decrypt(key, 'legacy', decodeBase64(value));
            const encryption = new SessionEncryption('original', {
                encrypt: async (values: unknown[]) => values.map(value => encrypt(key, 'legacy', value)),
                decrypt: async (values: Uint8Array[]) => values.map(value => decrypt(key, 'legacy', value)),
            }, new EncryptionCache());
            const update = evaluate(writer, 'sessionUpdateMetadata', {
                sync: { encryption: { getSessionEncryption: () => encryption } },
                apiSocket: { emitWithAck: async (event: string, request: any) => {
                    expect(event).toBe('update-metadata');
                    expect(request.sid).toBe('original');
                    if (conflict && !conflicted) {
                        conflicted = true;
                        server = { ...server, permissionMode: 'read-only', futureProviderState: { revision: 2 },
                            summary: { ...server.summary, branchSlug: 'latest-branch', futureSummary: 'latest-summary' },
                            runtimeCapabilities: { ...server.runtimeCapabilities, futureCapability: { revision: 2 } } };
                        return { result: 'version-mismatch', version: ++version, metadata: seal(server) };
                    }
                    expect(request.expectedVersion).toBe(version);
                    server = open(request.metadata);
                    return { result: 'success', version: ++version, metadata: request.metadata };
                } },
            });
            const parsed = await encryption.decryptMetadata(version, seal(server));
            // This is storage.ts's actual title-change transform and ops.ts's actual writer.
            const titled = changeTitle(parsed, 'new title');
            const result = await update('original', titled, 1);
            expect(result.version).toBe(conflict ? 3 : 2);
            expect(server.summary).toMatchObject({ text: 'new title', branchSlug: conflict ? 'latest-branch' : 'old-branch',
                futureSummary: conflict ? 'latest-summary' : 'old-summary' });
            expect(server.futureProviderState).toEqual({ revision: conflict ? 2 : 1 });
            expect(server.models[0].futureModel).toBe('preserve');
            expect(server.runtimeCapabilities.futureCapability).toEqual({ revision: conflict ? 2 : 1 });
            expect(server.runtimeCapabilities.agentContact).toEqual(enabled ? contact : undefined);
            if (!enabled) expect(server).not.toHaveProperty('inputEvidenceEnabled');
            expect(resolveRecoveredInputEvidenceEnvironment({ metadata: server,
                requestedEnvironment: override === undefined ? undefined : { HAPPY_INPUT_EVIDENCE: override },
            }).HAPPY_INPUT_EVIDENCE).toBe(enabled && override !== '0' ? '1' : '0');
            if (conflict) expect(server.permissionMode).toBe('read-only');
            // With no intervening socket update, the ACK must align the cached document
            // and version before the next title write, including newly discovered fields.
            const cached = applyTitleAck(titled, 1, result);
            expect(cached.metadata).toEqual(server);
            const pendingTitle = applyTitleAck(changeTitle(titled, 'pending local title'), 1, result);
            expect(pendingTitle.metadata.summary.text).toBe('pending local title');
            expect(pendingTitle.metadata.runtimeCapabilities).toEqual(server.runtimeCapabilities);
            expect(pendingTitle.metadata.futureProviderState).toEqual(server.futureProviderState);
            const next = await update('original', changeTitle(cached.metadata, 'next title'), cached.metadataVersion);
            expect(next.version).toBe(result.version + 1);
            expect(server.summary).toMatchObject({ text: 'next title', branchSlug: conflict ? 'latest-branch' : 'old-branch' });
            expect(server.runtimeCapabilities.agentContact).toEqual(enabled ? contact : undefined);
            expect(resolveRecoveredInputEvidenceEnvironment({ metadata: server }).HAPPY_INPUT_EVIDENCE).toBe(enabled ? '1' : '0');
            // A late title ACK must never replace a newer document already observed.
            const newer = { ...server, name: 'newer concurrent edit' };
            expect(applyTitleAck(newer, next.version + 1, result)).toEqual({ metadata: newer, metadataVersion: next.version + 1 });
        });
    }
});

it('T2RT-29 stripped offline metadata defaults OFF; only a valid saved setting or explicit request can enable it', () => {
    const metadata = { inputEvidenceEnabled: true, runtimeCapabilities: { agentContact: { inputEvidence: 1 } } };
    const { inputEvidenceEnabled: _lost, ...stripped } = metadata;
    expect(resolveRecoveredInputEvidenceEnvironment({ metadata: stripped as { inputEvidenceEnabled?: boolean } }).HAPPY_INPUT_EVIDENCE).toBe('0');
    expect(resolveRecoveredInputEvidenceEnvironment({ metadata: stripped as { inputEvidenceEnabled?: boolean }, savedEnvironment: { HAPPY_INPUT_EVIDENCE: '1' } }).HAPPY_INPUT_EVIDENCE).toBe('1');
    expect(resolveRecoveredInputEvidenceEnvironment({ metadata: stripped as { inputEvidenceEnabled?: boolean }, savedEnvironment: { HAPPY_INPUT_EVIDENCE: 'true' } }).HAPPY_INPUT_EVIDENCE).toBe('0');
    expect(resolveRecoveredInputEvidenceEnvironment({ metadata: stripped as { inputEvidenceEnabled?: boolean }, savedEnvironment: { HAPPY_INPUT_EVIDENCE: '1' },
        requestedEnvironment: { HAPPY_INPUT_EVIDENCE: '0' } }).HAPPY_INPUT_EVIDENCE).toBe('0');
});
