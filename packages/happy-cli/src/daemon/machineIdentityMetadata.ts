import type { MachineMetadata } from '@/api/types';

const IDENTITY_KEYS = ['host', 'platform', 'homeDir', 'happyHomeDir', 'happyLibDir'] as const;

/**
 * The stored machine metadata with any missing identity field taken from this daemon's base, or undefined when
 * nothing is missing.
 *
 * Capability refreshes spread whatever metadata the daemon could open (`{ ...(metadata || {}), ... }`). When the
 * stored blob could not be opened (null), that writes features without host/platform/homeDir, and because an
 * existing machine keeps its first-registered metadata, a restart never brings them back. Clients then cannot tell
 * the OS (Desktop's resource probe refuses to run). Present fields are kept: they are the first registration.
 */
export function machineIdentityMetadataUpdate(stored: MachineMetadata | null, base: MachineMetadata): MachineMetadata | undefined {
    if (!stored) return base;
    const missing = IDENTITY_KEYS.filter((key) => typeof stored[key] !== 'string' || !stored[key]);
    if (missing.length === 0) return undefined;
    return { ...stored, ...Object.fromEntries(missing.map((key) => [key, base[key]])) };
}
