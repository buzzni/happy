import { describe, it, expect } from 'vitest'
import { generateDefaultProfileName } from './profileId.js'

describe('generateDefaultProfileName', () => {
    it('embeds the given suffix, so two unconfigured installs do not both save the bare string "default"', () => {
        // BrowserBridge treats a reconnect under the same profile name as
        // "replace the old socket" — two different Chrome profiles that both
        // silently kept the literal default would evict each other forever.
        expect(generateDefaultProfileName('ab12')).toBe('default-ab12')
    })

    it('generates a random suffix itself when none is given', () => {
        const a = generateDefaultProfileName()
        const b = generateDefaultProfileName()
        expect(a).toMatch(/^default-[0-9a-f]{4}$/)
        expect(a).not.toBe(b)
    })
})
