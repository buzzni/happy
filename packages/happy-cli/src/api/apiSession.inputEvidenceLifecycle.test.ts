/** T2RT-16..32: replay real source revisions, not a second hand-written mapper. */
import { expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

it.each([false, true])('preserves merge-base turns/consumers with evidence opt-in=%s', async enabled => {
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const root = resolve(cli, '../..');
    const directory = await mkdtemp(join(tmpdir(), 'happy-turn-parity-'));
    try {
        const archive = execFileSync('git', ['archive', '9ee84191', 'packages/happy-cli/src', 'packages/happy-cli/package.json'],
            { cwd: root, maxBuffer: 32 * 1024 * 1024 });
        execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
        const base = join(directory, 'packages/happy-cli');
        await symlink(join(cli, 'node_modules'), join(base, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const config = join(directory, 'vitest.config.mjs');
        const fixture = join(cli, 'src/api/fixtures/turnEventParity.scenarios.ts');
        await writeFile(config, `export default ${JSON.stringify({
            root: cli, cacheDir: join(directory, 'cache'),
            test: { projects: [base, cli].map((source, index) => ({
                resolve: { alias: { '@': join(source, 'src') } },
                test: { name: index ? 'head' : 'base', root: source, environment: 'node', include: [fixture],
                    setupFiles: [join(cli, 'src/testing/unit.setup.ts')],
                    env: { T2RT_PARITY_OUTPUT: join(directory, `${index ? 'head' : 'base'}.jsonl`),
                        T2RT_PARITY_EVIDENCE: enabled ? 'on' : 'off' } },
            })) },
        })};`);
        try {
            await promisify(execFile)(process.execPath, [join(cli, 'node_modules/vitest/vitest.mjs'), 'run',
                '--config', config, '--project', 'base', '--project', 'head', '--maxWorkers', '2'],
            { cwd: cli, maxBuffer: 8 * 1024 * 1024, timeout: 90_000 });
        } catch (error: any) {
            throw new Error(`Source replay failed:\n${error.stdout}\n${error.stderr}`, { cause: error });
        }
        const load = async (source: string): Promise<any[]> => (await readFile(join(directory, `${source}.jsonl`), 'utf8'))
            .trim().split('\n').map(line => JSON.parse(line));
        const baseline = await load('base'), head = await load('head');
        expect(baseline).toHaveLength(enabled ? 58 : 82);
        expect(head).toHaveLength(baseline.length);
        for (const original of baseline) {
            const actual = head.find(record => record.name === original.name);
            expect.soft(actual, original.name).toBeDefined();
            for (const field of ['turns', 'routing', 'reports', 'reportsBeforeCancel', 'followup', 'ready', 'outboxTurns', 'prompts',
                ...(!enabled ? ['wire', 'metadata', 'metadataWrites', 'transitions'] : [])]) {
                expect.soft(actual?.[field], `${original.name}: ${field}`).toEqual(original[field]);
            }
            for (const revision of actual?.evidence ?? []) {
                expect.soft(revision.inputEvidence).toMatchObject({ coverage: 'incomplete', inputs: [], inputCount: 0, terminal: true });
                expect.soft(revision.inputEvidence.incompleteReasons).toContain('unmapped-final-answer');
            }
            if (enabled && original.name.endsWith('-true') && ['T16-', 'T17-19-', 'T18-', 'outbox-'].some(prefix => original.name.startsWith(prefix))) {
                expect.soft(actual.evidence.length, original.name).toBeGreaterThan(0);
            }
            if (enabled && original.name.startsWith('account-') && original.name.endsWith('-true')) {
                expect.soft(actual.settledEvidence, original.name).toMatchObject({ rootBatchId: actual.sourceEvidence.rootBatchId,
                    inputs: [{ kind: 'rest', serverMessageId: 'A', serverSeq: 1 }], terminal: true,
                    continuation: { kind: 'claude-account-switch', state: original.name.startsWith('account-empty-') ? 'cancelled' : 'completed' } });
                if (original.name.startsWith('account-empty-')) {
                    expect.soft(actual.settledEvidence).toMatchObject({ coverage: 'incomplete',
                        incompleteReasons: expect.arrayContaining(['continuation-consumption-unproven']) });
                    const root = actual.sourceEvidence.rootBatchId;
                    expect.soft(actual.wire.filter((event: any) => event.ev.t === 'turn-input-evidence'
                        && event.ev.inputEvidence.rootBatchId === root && event.ev.inputEvidence.terminal)).toHaveLength(1);
                    expect.soft(actual.wire.find((event: any) => event.ev.t === 'turn-end').ev.inputEvidence).toMatchObject({
                        rootBatchId: root, terminal: true, coverage: 'incomplete', continuation: { state: 'cancelled' },
                    });
                }
            }
            if (!enabled) expect.soft(actual.evidence ?? [], original.name).toEqual([]);
            if (original.name.startsWith('off-metadata-')) {
                expect.soft(actual.metadataWrites, original.name).toEqual([]);
                expect.soft(actual.transitions, original.name).toHaveLength(5);
                for (const metadata of actual.transitions) expect.soft(metadata, original.name).toEqual(original.metadata);
            }
            if (enabled && original.name.startsWith('full-') && original.name.endsWith('-true')) {
                expect.soft(actual.metadata.runtimeCapabilities?.agentContact?.guardedPrompt, original.name).toBe(1);
                if (original.name === 'full-codex-ordinary-true') expect.soft(actual.finals).toHaveLength(1);
                if (original.name === 'full-plan-empty-true') expect.soft(actual.wire.map((event: any) => event.ev.t)).toEqual(['plan']);
                if (original.name === 'full-guards-true') expect.soft(actual.wire.map((event: any) => event.ev.state))
                    .toEqual(['accepted', 'rejected', 'rejected', 'rejected']);
            }
            for (const final of actual?.finals ?? []) {
                for (const revision of actual.evidence) {
                    expect.soft(final.turn, original.name).not.toBe(revision.inputEvidence.turnId);
                    expect.soft(final.ev.inputEvidence?.rootBatchId, original.name).not.toBe(revision.inputEvidence.rootBatchId);
                }
            }
            if (enabled && original.name.startsWith('T17-19-') && original.name.includes('-true-') && original.name.endsWith('-true')) {
                for (const final of actual.finals) {
                    expect.soft(final.ev.inputEvidence.inputs, original.name).not.toContainEqual({ kind: 'rest', serverMessageId: 'A', serverSeq: 1 });
                    expect.soft(final.ev.inputEvidence.coverage, original.name).toBe('incomplete');
                }
            }
        }
        // Main's textless scheduled result opens no turn: its missing completion
        // report is pre-existing and cannot be repaired by creating evidence turns.
        for (const result of baseline.filter(record => record.name.startsWith('T18-'))) {
            expect(result.turns).toEqual([]); expect(result.reports).toEqual([]); expect(result.ready).toBe(1);
        }
        console.info(`${baseline.length} scenarios replayed on 9ee84191 and HEAD, opt-in=${enabled}; ${baseline.length * 2} source replays. Main follow-up controls:`,
            baseline.filter(record => record.name.startsWith('T17-19-') && record.name.endsWith('-true'))
                .map(record => ({ name: record.name, ...record.followup })));
        if (process.env.T2RT_PARITY_EXPORT) await writeFile(`${process.env.T2RT_PARITY_EXPORT}.${enabled ? 'on' : 'off'}.json`, JSON.stringify({ baseline, head }));
    } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
