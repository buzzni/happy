/**
 * provisionLegacyMachineKey 의 실제 파일 왕복 검증 (aplus §6-1 Phase 3b).
 *
 * persistence.test.ts 와 분리된 이유: configuration 싱글턴이 import 시점에
 * HAPPY_HOME_DIR 을 읽으므로, env 를 먼저 고정하고 dynamic import 해야
 * 임시 홈으로 격리된다 (기존 테스트 파일은 이미 정적 import 됨).
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'happy-provision-'))
process.env.HAPPY_HOME_DIR = home

describe('provisionLegacyMachineKey (file round-trip)', () => {
    beforeAll(() => {
        mkdirSync(home, { recursive: true })
    })

    it('upgrades a plain legacy access.key to the combined format and returns updated credentials', async () => {
        const { configuration } = await import('./configuration')
        expect(configuration.happyHomeDir).toBe(home)

        const secret = Buffer.alloc(32, 1)
        writeFileSync(configuration.privateKeyFile, JSON.stringify({
            token: 'tok-1',
            secret: secret.toString('base64'),
        }))

        const { readCredentials, provisionLegacyMachineKey } = await import('./persistence')
        const before = await readCredentials()
        expect(before!.encryption.type).toBe('legacy')
        expect((before!.encryption as any).provisioned).toBeUndefined()

        const accountPublicKey = Buffer.alloc(32, 2).toString('base64')
        const updated = await provisionLegacyMachineKey(before!, accountPublicKey)

        // 반환값: legacy 활성 + provisioned 재료
        expect(updated.encryption.type).toBe('legacy')
        const enc = updated.encryption as any
        expect(enc.secret).toEqual(new Uint8Array(secret))
        expect(enc.provisioned.publicKey).toEqual(new Uint8Array(Buffer.alloc(32, 2)))
        expect(enc.provisioned.machineKey.length).toBe(32)

        // 디스크: secret 이 그대로 남아 있고(구버전 CLI 가 legacy 로 읽음)
        // encryption 블록이 병기됨
        const onDisk = JSON.parse(readFileSync(configuration.privateKeyFile, 'utf8'))
        expect(onDisk.secret).toBe(secret.toString('base64'))
        expect(onDisk.token).toBe('tok-1')
        expect(Buffer.from(onDisk.encryption.publicKey, 'base64').length).toBe(32)
        expect(Buffer.from(onDisk.encryption.machineKey, 'base64').length).toBe(32)

        // 재기동 재현: readCredentials 가 병기 파일을 legacy+provisioned 로 읽는다
        const after = await readCredentials()
        expect(after!.encryption.type).toBe('legacy')
        expect((after!.encryption as any).provisioned.machineKey)
            .toEqual(enc.provisioned.machineKey)
    })

    it('throws (best-effort at the caller) when invoked again on already-provisioned credentials', async () => {
        const { readCredentials, provisionLegacyMachineKey } = await import('./persistence')
        const current = await readCredentials()
        await expect(provisionLegacyMachineKey(current!, Buffer.alloc(32, 2).toString('base64')))
            .rejects.toThrow(/already/)
    })
})
