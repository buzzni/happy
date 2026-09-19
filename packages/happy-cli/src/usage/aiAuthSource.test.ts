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

    it('does not read platform ownership out of the Z.AI endpoint', () => {
        // 이 테스트는 원래 URL → platform-glm 을 고정하고 있었다. 개인 GLM 키가
        // 같은 주소를 쓰므로 그 추론은 틀렸다 — 주소는 어느 wire 를 타는지를 말할 뿐
        // 누구 자격으로 쓰는지를 말하지 않는다.
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: `${MANAGED_AI_AUTH_GLM_BASE_URL}/` },
        })).toBe('unknown')
    })

    it('데몬이 체험 임대를 적용했다고 말할 때만 platform-glm 이다', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: `${MANAGED_AI_AUTH_GLM_BASE_URL}/` },
            platformLeaseApplied: true,
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

describe('부모 리뷰 수정: URL 은 소유권의 증거가 아니다', () => {
    it('적어 둔 값은 임대 신호보다 우선한다 — 적어 둔 unknown 도 답이다', () => {
        // "못 가른다" 고 적은 것을 뒤 레이어가 다시 추측하면 남의 키가 플랫폼
        // 임대로 계량된다. 기록된 값이 없을 때만 임대 신호를 본다.
        expect(resolveAppliedAiAuthSource({
            env: {
                [HAPPY_AI_AUTH_SOURCE_ENV]: 'unknown',
                ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
            },
            platformLeaseApplied: true,
        })).toBe('unknown')
    })

    it('적어 둔 개인 키가 임대 신호를 이긴다', () => {
        expect(resolveAppliedAiAuthSource({
            env: { [HAPPY_AI_AUTH_SOURCE_ENV]: 'personal-api-key' },
            platformLeaseApplied: true,
        })).toBe('personal-api-key')
    })

    it('Z.AI 주소만으로는 플랫폼 임대라고 판정하지 않는다', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
        })).toBe('unknown')
    })

    it('daemon 이 체험 임대를 적용했다고 알려줄 때만 platform-glm 이다', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
            platformLeaseApplied: true,
        })).toBe('platform-glm')
    })

    it('managed 봉투는 여전히 권위다', () => {
        expect(resolveAppliedAiAuthSource({
            env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
            managedAiAuthKind: 'personal-api-key',
        })).toBe('personal-api-key')
    })
})
