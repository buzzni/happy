import { describe, expect, it } from 'vitest'
import { MANAGED_AI_AUTH_GLM_BASE_URL } from '@/managed/managedAiAuth'
import {
    aiAuthSourceForManagedKind,
    HAPPY_AI_AUTH_CONNECTION_VERSION_ENV,
    HAPPY_AI_AUTH_SOURCE_ENV,
    normalizeAiAuthSource,
    readAiAuthConnectionVersion,
    resolveAppliedAiAuthSource,
} from '@/usage/aiAuthSource'

describe('aiAuthSourceForManagedKind', () => {
    it.each([
        ['platform-gateway', 'platform-gateway'],
        ['platform-glm', 'platform-glm'],
        ['personal-subscription', 'personal-subscription'],
        ['personal-api-key', 'personal-api-key'],
    ])('maps the managed kind %s onto the ledger source %s', (kind, expected) => {
        expect(aiAuthSourceForManagedKind(kind)).toBe(expected)
    })

    it('reports a managed kind it does not know as unknown', () => {
        expect(aiAuthSourceForManagedKind('platform-something-new')).toBe('unknown')
    })
})

describe('normalizeAiAuthSource', () => {
    it('keeps an exact token of the closed set', () => {
        expect(normalizeAiAuthSource('org-bundle')).toBe('org-bundle')
    })

    it.each([
        ['a missing value', undefined],
        ['an empty string', ''],
        ['an unknown token', 'personal-somethings'],
        ['a differently cased token', 'Personal-Subscription'],
        ['a non-string', 7],
    ])('downgrades %s to unknown', (_label, value) => {
        expect(normalizeAiAuthSource(value)).toBe('unknown')
    })
})

describe('resolveAppliedAiAuthSource', () => {
    it('does not guess a source when nothing identifies the credential', () => {
        expect(resolveAppliedAiAuthSource({ env: {} })).toBe('unknown')
    })

    it('reads the source the daemon injected', () => {
        expect(resolveAppliedAiAuthSource({
            env: { [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-bundle' },
        })).toBe('org-bundle')
    })

    it('downgrades an injected source it does not know instead of passing it on', () => {
        expect(resolveAppliedAiAuthSource({
            env: { [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-bundle-v2' },
        })).toBe('unknown')
    })

    it('lets the managed run kind win over an inherited injected source', () => {
        expect(resolveAppliedAiAuthSource({
            env: { [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-bundle' },
            managedAiAuthKind: 'personal-subscription',
        })).toBe('personal-subscription')
    })

    it('lets the managed run kind win over the environment fingerprint', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: MANAGED_AI_AUTH_GLM_BASE_URL },
            managedAiAuthKind: 'personal-api-key',
        })).toBe('personal-api-key')
    })

    it('recognises the Z.AI endpoint as the platform GLM route', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: `${MANAGED_AI_AUTH_GLM_BASE_URL}/` },
        })).toBe('platform-glm')
    })

    it('cannot tell an org bundle from a personal key by the environment alone', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_API_KEY: 'sk-ant-whoever' },
        })).toBe('unknown')
    })

    it('does not read a subscription out of an inherited OAuth token', () => {
        expect(resolveAppliedAiAuthSource({
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-whoever' },
        })).toBe('unknown')
    })

    it('reports an unrecognised base URL as unknown rather than a platform route', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic' },
        })).toBe('unknown')
    })
})

describe('readAiAuthConnectionVersion', () => {
    it('reads the version the daemon injected', () => {
        expect(readAiAuthConnectionVersion({
            [HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]: '4',
        })).toBe(4)
    })

    it.each([
        ['a missing value', undefined],
        ['a non-numeric value', 'v4'],
        ['a fractional value', '4.5'],
        ['a negative value', '-1'],
    ])('reports %s as no version', (_label, value) => {
        expect(readAiAuthConnectionVersion({
            [HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]: value,
        })).toBeNull()
    })
})
