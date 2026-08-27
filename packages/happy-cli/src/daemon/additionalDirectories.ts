import fs from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

export const ADDITIONAL_DIRECTORIES_CAPABILITY = {
  version: 1 as const,
  maxDirectories: 8 as const,
  agents: ['claude', 'codex'] as ['claude', 'codex'],
  access: 'read-write' as const,
}

export type AdditionalDirectorySkipReason =
  | 'missing'
  | 'not-directory'
  | 'canonicalize-failed'
  | 'duplicate'
  | 'primary'

export type AdditionalDirectorySkipCounts = Partial<Record<AdditionalDirectorySkipReason, number>>

export function parseAdditionalDirectories(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > ADDITIONAL_DIRECTORIES_CAPABILITY.maxDirectories) {
    throw new Error('Additional directories must be a bounded array')
  }
  if (value.length === 0) return undefined
  if (value.some((directory) => (
    typeof directory !== 'string'
    || directory.length === 0
    || directory.includes('\0')
    || !isAbsolute(directory)
    || /(^|[\\/])\.\.([\\/]|$)/.test(directory)
  ))) {
    throw new Error('Additional directories must contain safe absolute paths only')
  }
  return [...value]
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function increment(
  skipped: AdditionalDirectorySkipCounts,
  reason: AdditionalDirectorySkipReason,
): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}

export async function prepareAdditionalDirectories(input: {
  requested: readonly string[] | undefined
  primaryDirectory: string
  allowedRoot: string
}): Promise<{ accepted: string[]; skipped: AdditionalDirectorySkipCounts }> {
  if (!input.requested?.length) return { accepted: [], skipped: {} }

  const [canonicalRoot, canonicalPrimary] = await Promise.all([
    fs.realpath(input.allowedRoot),
    fs.realpath(input.primaryDirectory),
  ])
  const inspected = await Promise.all(input.requested.map(async (requested) => {
    try {
      const canonical = await fs.realpath(requested)
      if (!isWithinRoot(canonicalRoot, canonical)) {
        throw new Error('Additional directory violates the canonical boundary')
      }
      const entry = await fs.stat(canonical)
      return entry.isDirectory()
        ? { type: 'directory' as const, canonical }
        : { type: 'skipped' as const, reason: 'not-directory' as const }
    } catch (error) {
      if (error instanceof Error && error.message.includes('canonical boundary')) throw error
      const code = (error as NodeJS.ErrnoException)?.code
      return {
        type: 'skipped' as const,
        reason: code === 'ENOENT' || code === 'ENOTDIR'
          ? 'missing' as const
          : 'canonicalize-failed' as const,
      }
    }
  }))

  const accepted: string[] = []
  const skipped: AdditionalDirectorySkipCounts = {}
  const seen = new Set<string>([canonicalPrimary])
  for (const entry of inspected) {
    if (entry.type === 'skipped') {
      increment(skipped, entry.reason)
      continue
    }
    if (entry.canonical === canonicalPrimary) {
      increment(skipped, 'primary')
      continue
    }
    if (seen.has(entry.canonical)) {
      increment(skipped, 'duplicate')
      continue
    }
    seen.add(entry.canonical)
    accepted.push(entry.canonical)
  }
  return { accepted, skipped }
}
