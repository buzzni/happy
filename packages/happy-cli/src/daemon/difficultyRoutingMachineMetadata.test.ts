import { describe, expect, it } from 'vitest'
import type { MachineMetadata } from '@/api/types'
import {
  DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
  DIFFICULTY_ROUTING_MAX_INPUT_TOKENS,
  DIFFICULTY_ROUTING_POLICY_VERSION,
} from '@/difficultyRouting'
import { buildDifficultyRoutingMetadataUpdate } from './run'

/**
 * `createDifficultyRoutingHostKey()` mints a fresh tweetnacl box keypair on
 * every daemon start, and `POST /v1/machines` does not rewrite metadata for a
 * machine that is already registered. So the metadata poll is the only place
 * the live run's host key reaches the server, and it must advertise the LIVE
 * block rather than whatever the previous run left stored — otherwise every
 * client seals its relay request to a public key whose secret key died with
 * the previous process.
 */

function capability(keyId: string, publicKey: string): NonNullable<MachineMetadata['difficultyRouting']> {
  return {
    version: 1,
    protocol: DIFFICULTY_ROUTING_POLICY_VERSION,
    hostProcessKeyId: keyId,
    hostProcessPublicKey: publicKey,
    classifier: {
      kind: 'transformers-binary',
      modelMaxInputTokens: DIFFICULTY_ROUTING_MAX_INPUT_TOKENS,
      maxInputChars: DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
      onnxSha256: '444c99b6f4d417e50859f73e1557db11943a2ad073ce4050a65f1b7d39403038',
      tokenizerJsonSha256: 'acadd7d076a55a97edf9fb0521a0a2e9cf8cbbdd62e4d793f2aa3d1900916356',
      revision: 'rev-1',
    },
    limits: {
      concurrency: 1,
      queueSize: 8,
      requestDeadlineMs: 1000,
    },
  }
}

describe('difficulty routing machine metadata advertised by the daemon', () => {
  it('advertises this run\'s host key even when the server still stores the previous run\'s', () => {
    // Daemon run #1 registered the machine with RUN-1; run #2 holds RUN-2 in
    // memory and the server hands back the stored block untouched.
    const stored = { difficultyRouting: capability('RUN-1-KEY', 'RUN-1-PUB'), other: 'kept' } as unknown as MachineMetadata
    const baseMetadata = { difficultyRouting: capability('RUN-2-KEY', 'RUN-2-PUB') } as unknown as MachineMetadata

    const published = buildDifficultyRoutingMetadataUpdate({ stored, baseMetadata, ready: true })

    expect(published.difficultyRouting?.hostProcessKeyId).toBe('RUN-2-KEY')
    expect(published.difficultyRouting?.hostProcessPublicKey).toBe('RUN-2-PUB')
    expect(published.difficultyRouting?.ready).toBe(true)
  })

  it('keeps the rest of the stored metadata the server already has', () => {
    const stored = { difficultyRouting: capability('RUN-1-KEY', 'RUN-1-PUB'), daemonVersion: '9.9.9' } as unknown as MachineMetadata
    const baseMetadata = { difficultyRouting: capability('RUN-2-KEY', 'RUN-2-PUB'), daemonVersion: '0.0.0' } as unknown as MachineMetadata

    const published = buildDifficultyRoutingMetadataUpdate({ stored, baseMetadata, ready: false })

    expect((published as unknown as { daemonVersion: string }).daemonVersion).toBe('9.9.9')
    expect(published.difficultyRouting?.ready).toBe(false)
  })

  it('falls back to the live metadata when the server has none stored', () => {
    const baseMetadata = { difficultyRouting: capability('RUN-2-KEY', 'RUN-2-PUB') } as unknown as MachineMetadata

    const published = buildDifficultyRoutingMetadataUpdate({ stored: null, baseMetadata, ready: true })

    expect(published.difficultyRouting?.hostProcessKeyId).toBe('RUN-2-KEY')
    expect(published.difficultyRouting?.ready).toBe(true)
  })
})
