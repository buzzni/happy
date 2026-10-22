import { describe, expect, it, vi } from 'vitest';
import { MachineMetadataSchema } from '@/api/types';

const probes = vi.hoisted(() => ({ detect: vi.fn(() => ({
  claude: true, codex: false, gemini: false, openclaw: false, detectedAt: 123,
})) }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: probes.detect }));

import * as daemon from './run';

describe('machine capability discovery lifecycle', () => {
  it('does not launch tool discovery when a conversation imports machine metadata', () => {
    expect(probes.detect).not.toHaveBeenCalled();
    expect(daemon.initialMachineMetadata.cliAvailability).toBeUndefined();
    expect(MachineMetadataSchema.safeParse(daemon.initialMachineMetadata).success).toBe(true);
  });

  it('discovers complete tool availability when preparing the daemon registration', () => {
    probes.detect.mockClear();
    const metadata = daemon.createDaemonMachineMetadata();
    expect(probes.detect).toHaveBeenCalledTimes(1);
    expect(metadata.cliAvailability).toEqual({
      claude: true, codex: false, gemini: false, openclaw: false, detectedAt: 123,
    });
    expect(metadata.aiAuthSelection).toEqual(daemon.initialMachineMetadata.aiAuthSelection);
    // specs/claude-cli-benchmark-followups R2: a client gates `--output-schema` on this.
    expect(metadata.structuredOutput).toEqual({ version: 1, agents: ['claude'], maxSchemaBytes: 16384 });
    expect(MachineMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(daemon.initialMachineMetadata.cliAvailability).toBeUndefined();
  });
});
