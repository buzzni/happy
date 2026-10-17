import { describe, expect, it } from 'vitest';
import type { MachineMetadata } from '@/api/types';
import { machineIdentityMetadataUpdate } from './machineIdentityMetadata';

const base = {
    host: 'mini.local',
    platform: 'darwin',
    happyCliVersion: '1.1.10',
    homeDir: '/Users/me',
    happyHomeDir: '/Users/me/.happy',
    happyLibDir: '/opt/happy-cli',
    cliAvailability: { claude: true, codex: true, gemini: false, openclaw: false, detectedAt: 1 },
} as MachineMetadata;

describe('machineIdentityMetadataUpdate', () => {
    it('restores identity fields a feature-only overwrite removed, keeping the stored features', () => {
        const stored = { happyCliVersion: '1.1.9', cliAvailability: { claude: false, codex: true, gemini: false, openclaw: false, detectedAt: 2 } } as unknown as MachineMetadata;

        expect(machineIdentityMetadataUpdate(stored, base)).toEqual({
            ...stored,
            host: 'mini.local',
            platform: 'darwin',
            homeDir: '/Users/me',
            happyHomeDir: '/Users/me/.happy',
            happyLibDir: '/opt/happy-cli',
        });
    });

    it('keeps the identity an existing machine first registered with', () => {
        const stored = { ...base, host: 'renamed.local', homeDir: '/Users/first' };

        expect(machineIdentityMetadataUpdate(stored, base)).toBeUndefined();
    });

    it('publishes the full base when the stored metadata cannot be read', () => {
        expect(machineIdentityMetadataUpdate(null, base)).toEqual(base);
    });
});
