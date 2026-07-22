import { describe, expect, it } from 'vitest'
import { resolveMcpConfigPresetUrl } from './mcpConfigPresets'

describe('resolveMcpConfigPresetUrl', () => {
    it('shouldResolveSaycodePresetToItsMcpConfigUrl', () => {
        expect(resolveMcpConfigPresetUrl('saycode')).toBe('https://saycode.ai/api/me/mcp-config')
    })

    it('shouldReturnUndefinedForUnknownPreset', () => {
        expect(resolveMcpConfigPresetUrl('does-not-exist')).toBeUndefined()
    })
})
