import { describe, expect, it } from 'vitest'
import { resolveDaemonPreset } from './mcpConfigPresets'

describe('resolveDaemonPreset', () => {
    it('resolves the fixed MCP and trusted Studio addresses together', () => {
        expect(resolveDaemonPreset('saycode')).toEqual({
            mcpConfigUrl: 'https://saycode.ai/api/me/mcp-config',
            studioOrigin: 'https://saycode.ai',
        })
    })

    it('shouldReturnUndefinedForUnknownPreset', () => {
        expect(resolveDaemonPreset('does-not-exist')).toBeUndefined()
    })
})
