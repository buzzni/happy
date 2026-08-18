import { describe, it, expect } from 'vitest'
import { ensureDefaultProfileName, generateDefaultProfileName } from './profileId.js'

describe('generateDefaultProfileName', () => {
    it('embeds the given suffix, so two unconfigured installs do not both save the bare string "default"', () => {
        // BrowserBridge treats a reconnect under the same profile name as
        // "replace the old socket" — two different Chrome profiles that both
        // silently kept the literal default would evict each other forever.
        expect(generateDefaultProfileName('ab12')).toBe('default-ab12')
    })

    it('generates a hexadecimal suffix itself when none is given', () => {
        expect(generateDefaultProfileName()).toMatch(/^default-[0-9a-f]{4}$/)
    })
})

describe('ensureDefaultProfileName', () => {
    it('stores a unique default before returning it when no profile exists', async () => {
        const writes = []
        const chromeApi = {
            storage: {
                local: {
                    get: async () => ({}),
                    set: async (value) => { writes.push(value) },
                },
            },
        }

        const profile = await ensureDefaultProfileName(chromeApi, () => 'default-ab12')

        expect(profile).toBe('default-ab12')
        expect(writes).toEqual([{ profile: 'default-ab12' }])
    })

    it('preserves an existing profile without generating or writing another one', async () => {
        let generated = false
        let wrote = false
        const chromeApi = {
            storage: {
                local: {
                    get: async () => ({ profile: 'work' }),
                    set: async () => { wrote = true },
                },
            },
        }

        const profile = await ensureDefaultProfileName(chromeApi, () => {
            generated = true
            return 'default-ab12'
        })

        expect(profile).toBe('work')
        expect(generated).toBe(false)
        expect(wrote).toBe(false)
    })
})
