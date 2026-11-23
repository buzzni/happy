import os from 'os';
import { WRITE_FILE_ATTEMPT_CAPABILITY } from '@/modules/common/writeFileAttempts';
import { AUTOMATION_PROTOCOL_VERSION, PROJECT_PURGE_CAPABILITY, RPC_BINDING_CAPABILITY, SEALED_SPAWN_ENV_CAPABILITY, WORKSPACE_SYNC_CAPABILITY, WORKTREE_OPS_CAPABILITY } from '@slopus/happy-wire';
import type { MachineMetadata } from '@/api/types';
import { LIST_FILES_PAGE_CAPABILITY } from '@/modules/common/listFilesPageCapability';
import { BASH_PREFIX_MATCHER_CAPABILITY } from '@/claude/utils/bashPrefixMatcher';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { projectPath } from '@/projectPath';
import { AI_AUTH_SELECTION_CAPABILITY } from './sessionEnv';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { STRUCTURED_OUTPUT_CAPABILITY } from '@/claude/structuredOutput';
import { agentBrowserMachineCapability } from './browserTaskBroker';
import { agentPlanCapabilityForPlatform } from './agentPlanGrantEnvelope';
import { ADDITIONAL_DIRECTORIES_CAPABILITY } from './additionalDirectories';
import { CHANNEL_SUPPORT_CAPABILITY } from '@/channel/channelSupportCapability';
import { MACHINE_RUN_MAX_OUTPUT_BYTES, MACHINE_RUN_MAX_TIMEOUT_MS } from '@/modules/common/typedMachineRun';
import { machineRunCapabilitySupported, TRUSTED_MACHINE_RUN_PROFILE_REGISTRY } from '@/modules/common/machineRunProfile';
import { hostManagedMachineTools } from '@/modules/common/moaiMachineRunProfiles';
import { toolPolicyMachineCapability } from '@/toolPolicy/claudeHook';
import { orgRequirementsMachineCapability } from '@/orgRequirements/gate';

// Prepare initial metadata
// Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
  automationSupport: {
    rpcAvailable: true,
    sessionFollowup: true,
    protocolVersion: AUTOMATION_PROTOCOL_VERSION,
  },
  additionalDirectories: ADDITIONAL_DIRECTORIES_CAPABILITY,
  channelSupport: CHANNEL_SUPPORT_CAPABILITY,
  aiAuthSelection: AI_AUTH_SELECTION_CAPABILITY,
  ...(agentPlanCapabilityForPlatform(process.platform) ? { agentPlan: agentPlanCapabilityForPlatform(process.platform) } : {}),
  structuredOutput: STRUCTURED_OUTPUT_CAPABILITY,
  writeFileAttempt: WRITE_FILE_ATTEMPT_CAPABILITY,
  listFilesPage: LIST_FILES_PAGE_CAPABILITY,
  permissionGrants: BASH_PREFIX_MATCHER_CAPABILITY,
  machineRun: {
    protocolVersion: 1,
    // The machine-scope handler installs the managed write policy (apiMachine).
    supported: machineRunCapabilitySupported(TRUSTED_MACHINE_RUN_PROFILE_REGISTRY, process.platform, true, hostManagedMachineTools(configuration.happyHomeDir)),
    shell: false,
    stdin: 'none',
    maxTimeoutMs: MACHINE_RUN_MAX_TIMEOUT_MS,
    maxOutputLimitBytes: MACHINE_RUN_MAX_OUTPUT_BYTES,
  },
  rpcBinding: RPC_BINDING_CAPABILITY,
  sealedSpawnEnv: SEALED_SPAWN_ENV_CAPABILITY,
  worktreeOps: WORKTREE_OPS_CAPABILITY,
  projectPurge: PROJECT_PURGE_CAPABILITY,
  workspaceSync: WORKSPACE_SYNC_CAPABILITY,
  ...(agentBrowserMachineCapability() ? { agentBrowser: agentBrowserMachineCapability() } : {}),
  ...(toolPolicyMachineCapability(process.env) ? { toolPolicy: toolPolicyMachineCapability(process.env) } : {}),
  ...(orgRequirementsMachineCapability(process.env) ? { orgRequirements: orgRequirementsMachineCapability(process.env) } : {}),
};
