import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MachineMetadataSchema } from '@/api/types'
import {
  ADDITIONAL_DIRECTORIES_CAPABILITY,
  parseAdditionalDirectories,
  prepareAdditionalDirectories,
} from './additionalDirectories'

describe('additional directories spawn contract', () => {
  it('advertises a versioned bounded Claude/Codex read-write capability', () => {
    const metadata = MachineMetadataSchema.parse({
      host: 'host',
      platform: 'linux',
      happyCliVersion: 'test',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/opt/happy',
      additionalDirectories: ADDITIONAL_DIRECTORIES_CAPABILITY,
    })

    expect(metadata.additionalDirectories).toEqual({
      version: 1,
      maxDirectories: 8,
      agents: ['claude', 'codex'],
      access: 'read-write',
    })
  })

  it.each([null, {}, 'path', [null], ['/absolute', 1], Array(9).fill('/absolute')])(
    'rejects malformed payload %j',
    (value) => {
      expect(() => parseAdditionalDirectories(value)).toThrow('Additional directories')
    },
  )

  it.each([['relative/path'], ['/absolute/../escape'], ['/absolute/\0escape']])(
    'rejects unsafe path payload %j',
    (value) => {
      expect(() => parseAdditionalDirectories(value)).toThrow('Additional directories')
    },
  )

  it('keeps an absent field backward compatible and omits an empty list', () => {
    expect(parseAdditionalDirectories(undefined)).toBeUndefined()
    expect(parseAdditionalDirectories([])).toBeUndefined()
  })
})

describe('prepareAdditionalDirectories', () => {
  it('accepts existing directories, skips missing/files without creating them, and canonical-deduplicates', async () => {
    const allowedRoot = await mkdtemp(join(tmpdir(), 'happy-additional-roots-'))
    const primaryDirectory = join(allowedRoot, 'primary')
    const existingDirectory = join(allowedRoot, 'existing')
    const missingDirectory = join(allowedRoot, 'missing')
    const filePath = join(allowedRoot, 'file.txt')
    const aliasPath = join(allowedRoot, 'alias')
    await mkdir(primaryDirectory)
    await mkdir(existingDirectory)
    await writeFile(filePath, 'not a directory')
    await symlink(existingDirectory, aliasPath)

    const result = await prepareAdditionalDirectories({
      requested: [existingDirectory, missingDirectory, filePath, aliasPath, primaryDirectory],
      primaryDirectory,
      allowedRoot,
    })

    expect(result.accepted).toEqual([await realpath(existingDirectory)])
    expect(result.skipped).toEqual({ missing: 1, 'not-directory': 1, duplicate: 1, primary: 1 })
    await expect(stat(missingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(filePath, 'utf8')).resolves.toBe('not a directory')
  })

  it('fails closed when a symlink canonicalizes outside the daemon allowed root', async () => {
    const allowedRoot = await mkdtemp(join(tmpdir(), 'happy-additional-root-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happy-additional-outside-'))
    const primaryDirectory = join(allowedRoot, 'primary')
    const escapePath = join(allowedRoot, 'escape')
    await mkdir(primaryDirectory)
    await symlink(outsideRoot, escapePath)

    await expect(prepareAdditionalDirectories({
      requested: [escapePath],
      primaryDirectory,
      allowedRoot,
    })).rejects.toThrow('canonical boundary')
  })
})
