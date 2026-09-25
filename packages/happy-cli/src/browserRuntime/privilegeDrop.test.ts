import { describe, expect, it } from 'vitest'
import { capabilitiesCleared, runtimeIdentity } from './privilegeDrop'

const status = (caps: { prm?: string; eff?: string; amb?: string } = {}) => [
    'Name:\tnode', 'Uid:\t10870\t10870\t10870\t10870', 'Gid:\t10870\t10870\t10870\t10870',
    `CapInh:\t0000000000000000`, `CapPrm:\t${caps.prm ?? '0000000000000000'}`, `CapEff:\t${caps.eff ?? '0000000000000000'}`,
    'CapBnd:\t00000000000000c0', `CapAmb:\t${caps.amb ?? '0000000000000000'}`, '',
].join('\n')

describe('privilege drop', () => {
    it('reads the unprivileged runtime identity from the image environment', () => {
        expect(runtimeIdentity({ ABP_RUNTIME_UID: '10870', ABP_RUNTIME_GID: '10870' })).toEqual({ uid: 10870, gid: 10870 })
    })

    it.each([
        [{}],
        [{ ABP_RUNTIME_UID: '0', ABP_RUNTIME_GID: '10870' }],
        [{ ABP_RUNTIME_UID: '10870', ABP_RUNTIME_GID: '0' }],
        [{ ABP_RUNTIME_UID: '10870x', ABP_RUNTIME_GID: '10870' }],
    ])('refuses a missing or root runtime identity %j', (env) => {
        expect(() => runtimeIdentity(env)).toThrow(/ABP_RUNTIME_UID/)
    })

    it('accepts a process only when its permitted, effective and ambient capabilities are empty', () => {
        expect(capabilitiesCleared(status())).toBe(true)
        expect(capabilitiesCleared(status({ prm: '00000000000000c0' }))).toBe(false)
        expect(capabilitiesCleared(status({ eff: '0000000000000080' }))).toBe(false)
        expect(capabilitiesCleared(status({ amb: '0000000000000040' }))).toBe(false)
        expect(capabilitiesCleared('Name:\tnode\n')).toBe(false)
    })
})
