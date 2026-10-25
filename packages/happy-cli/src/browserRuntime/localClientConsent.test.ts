import { expect, it } from 'vitest'
import { parseBrowserClientConsent } from './localClientConsent'
it('accepts only an explicit, bounded human consent DTO', () => {
    for (const raw of [undefined, null, {}, [], { leaseMinutes: 1440 }, { leaseMinutes: 15, rememberSameScope: 'true' },
        { leaseMinutes: 1441, rememberSameScope: true }, { leaseMinutes: 15, rememberSameScope: true, appId: 'forged' }]) expect(parseBrowserClientConsent(raw)).toBeUndefined()
    expect(parseBrowserClientConsent({ leaseMinutes: 1440, rememberSameScope: false })).toEqual({ leaseMinutes: 1440, rememberSameScope: false })
})
