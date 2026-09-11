/**
 * The provider environment the runtime generates, against the policy that
 * guards it.
 *
 * These are two files, each internally consistent and each with its own tests:
 * `managedProviderEnvironment` composes what the child needs, and
 * `assertProviderEnv` refuses anything a provider must not carry. Nothing tested
 * them *together* — and together they refused every managed run, for both
 * agents, before a single byte was written. The composition is the contract.
 */
import { describe, expect, it } from 'vitest';

import { assertProviderEnv } from './claudeToolPolicy';
import { MANAGED_GENERATION_CODEX_HOME, managedProviderEnvironment } from './managedRunConfig';
import { MANAGED_BOOTSTRAP_FD_ENV } from '@/managed/managedSpawnBootstrap';
import { MANAGED_REPORT_FD_ENV } from '@/daemon/launch/managedReportCredential';
import type { ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

const envelope = (): ManagedSpawnEnvelope => ({
    directory: '/workspace/project',
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'medium',
    initialPrompt: 'hello',
    initialPromptLocalId: 'local_1',
    bootstrap: {
        version: 1,
        serverOrigin: 'http://127.0.0.1:3005',
        sessionId: 'sess_1',
        encryptionVariant: 'dataKey',
        rawKeyBase64: Buffer.alloc(32, 1).toString('base64'),
        wrappedKeyBase64: Buffer.alloc(105, 2).toString('base64'),
        scopedToken: 'scoped',
        tokenExpiresAt: Date.now() + 60_000,
    },
    gateway: {
        baseUrl: 'http://127.0.0.1:3005/api/cloud/gateway/anthropic/v1/messages',
        provider: 'anthropic',
        endpoint: 'anthropic-messages',
        model: 'claude-opus-5',
        capability: 'cap_1',
    },
} as unknown as ManagedSpawnEnvelope);

describe('the generated provider environment and the policy that guards it', () => {
    it('shouldGiveTheProviderAHomeItsOwnUidCanWrite', () => {
        /*
         * The provider uid has no passwd entry in the image, so a child with no
         * `HOME` resolves one it cannot write and dies before reporting
         * anything — the daemon sees only a session webhook that never comes.
         * The value is the directory the runtime already creates and chowns for
         * the provider's own state.
         */
        expect(managedProviderEnvironment(envelope()).HOME).toBe(MANAGED_GENERATION_CODEX_HOME);
    });

    it('shouldNotRefuseTheEnvironmentTheRuntimeItselfComposes', () => {
        // The failure this pins: every managed launch died here, before the
        // provider script was written, because the runtime's own three
        // bootstrap variables are `HAPPY_MANAGED_*` and the policy refused the
        // whole prefix.
        expect(() => assertProviderEnv(managedProviderEnvironment(envelope()))).not.toThrow();
    });

    it('shouldStillRefuseAHappyManagedKeyThatIsNotOneOfTheThree', () => {
        // The prefix stays closed. Only the three the runtime binds are let
        // through, by name — a prefix that is open again is a way to hand the
        // provider anything at all.
        for (const key of ['HAPPY_MANAGED_SOMETHING', 'HAPPY_MANAGED_BOOTSTRAP_FD_X', 'HAPPY_MANAGED_']) {
            expect(() => assertProviderEnv({ ...managedProviderEnvironment(envelope()), [key]: '1' }))
                .toThrow(/must not carry/);
        }
    });

    it('shouldNameExactlyTheThreeTheRuntimeBinds', () => {
        const generated = Object.keys(managedProviderEnvironment(envelope()))
            .filter((key) => key.startsWith('HAPPY_MANAGED_'))
            .sort();
        expect(generated).toEqual([
            MANAGED_BOOTSTRAP_FD_ENV, 'HAPPY_MANAGED_REQUIRE_PROMPT_ACK', MANAGED_REPORT_FD_ENV,
        ].sort());
    });

    it('shouldStillRefuseTheProviderCredentialsThatWereAlwaysForbidden', () => {
        // The provider's own list, not a guess: `ANTHROPIC_AUTH_TOKEN` and
        // `ANTHROPIC_BASE_URL` are how a managed provider is pointed at the
        // gateway, so they are forbidden to the *tool executor*, not here.
        for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HAPPY_HOME_DIR']) {
            expect(() => assertProviderEnv({ [key]: 'x' })).toThrow(/must not carry/);
        }
    });
});
