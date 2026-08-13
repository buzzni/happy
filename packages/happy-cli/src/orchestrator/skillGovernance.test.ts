import { describe, expect, it } from 'vitest'
import { buildSkillGovernanceOptions, readSkillGovernanceConfigFromEnv } from './skillGovernance'

describe('buildSkillGovernanceOptions', () => {
    it('returns a no-op result when no governance env is set', () => {
        expect(buildSkillGovernanceOptions({})).toEqual({})
        expect(buildSkillGovernanceOptions({ settingSources: null, skillAllowlist: null })).toEqual({})
        expect(buildSkillGovernanceOptions({ settingSources: '', skillAllowlist: '' })).toEqual({})
    })

    it('parses a comma-separated setting sources allowlist, dropping unknown entries', () => {
        expect(buildSkillGovernanceOptions({ settingSources: 'project,local' }))
            .toEqual({ settingSources: ['project', 'local'] })
        expect(buildSkillGovernanceOptions({ settingSources: ' project , bogus ,local' }))
            .toEqual({ settingSources: ['project', 'local'] })
    })

    it('omits settingSources when every entry is unknown', () => {
        expect(buildSkillGovernanceOptions({ settingSources: 'bogus,also-bogus' })).toEqual({})
    })

    it('parses "all" as the literal skills allowlist value', () => {
        expect(buildSkillGovernanceOptions({ skillAllowlist: 'all' })).toEqual({ skills: 'all' })
    })

    it('parses a comma-separated skill name allowlist', () => {
        expect(buildSkillGovernanceOptions({ skillAllowlist: 'project-analyze, plan-think ,debug-diagnose' }))
            .toEqual({ skills: ['project-analyze', 'plan-think', 'debug-diagnose'] })
    })

    it('combines both governance knobs independently', () => {
        expect(buildSkillGovernanceOptions({ settingSources: 'project,local', skillAllowlist: 'pdf,docx' }))
            .toEqual({ settingSources: ['project', 'local'], skills: ['pdf', 'docx'] })
    })
})

describe('readSkillGovernanceConfigFromEnv', () => {
    it('reads governance knobs from HAPPY_* env', () => {
        expect(readSkillGovernanceConfigFromEnv({ HAPPY_SETTING_SOURCES: 'project,local', HAPPY_SKILL_ALLOWLIST: 'pdf' }))
            .toEqual({ settingSources: 'project,local', skillAllowlist: 'pdf' })
    })

    it('returns undefined fields when env is empty', () => {
        expect(readSkillGovernanceConfigFromEnv({})).toEqual({ settingSources: undefined, skillAllowlist: undefined })
    })

    it('round-trips through buildSkillGovernanceOptions from env', () => {
        const cfg = readSkillGovernanceConfigFromEnv({ HAPPY_SETTING_SOURCES: 'project', HAPPY_SKILL_ALLOWLIST: 'all' })
        expect(buildSkillGovernanceOptions(cfg)).toEqual({ settingSources: ['project'], skills: 'all' })
    })
})
