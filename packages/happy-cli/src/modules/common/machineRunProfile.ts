import { tmpdir } from 'node:os';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { hashObject } from '../../utils/deterministicJson';
import {
    createTypedMachineRunHandler,
    MACHINE_RUN_MAX_OUTPUT_BYTES,
    MACHINE_RUN_MAX_TIMEOUT_MS,
    type TypedMachineRunRequest,
    type TypedMachineRunResponse,
} from './typedMachineRun';
import { validatePath } from './pathSecurity';
import packageJson from '../../../package.json';

export type MachineRunJsonValue = string | number | boolean | null | MachineRunJsonValue[] | { [key: string]: MachineRunJsonValue };

export type MachineRunParameter =
    | { type: 'string'; maxLength: number; values?: string[] }
    | { type: 'integer'; min: number; max: number };

export interface MachineRunProfile {
    id: string;
    executable: string;
    argv: string[];
    parameters: Record<string, MachineRunParameter>;
    cwd: 'workspaceRoot' | 'extensionData' | 'temp';
    envAllowlist: string[];
    timeoutMs: number;
    outputLimitBytes: number;
    stdin: 'none';
    writeScope?: 'none' | 'moai' | 'project';
    descendantAllowlist?: string[];
}

/** A profile after the daemon has validated and sealed its host-owned identity. */
export interface TrustedMachineRunProfile extends MachineRunProfile {
    profileDigest: string;
}

export interface MachineRunProfileResolver {
    resolve(profileId: string): TrustedMachineRunProfile | undefined;
    list(): readonly TrustedMachineRunProfile[];
}

/**
 * A profile resolver is the daemon's trust boundary. Extension input must not
 * be used to populate it at runtime; only a host-owned registry may do that.
 */
export type TrustedMachineRunProfileRegistry = MachineRunProfileResolver;

export type MachineRunCapabilityRequest =
    | { action: 'capabilities'; version?: 1 }
    | { action: 'start'; profileId: string; profileDigest: string; workspaceRoot: string; parameters: Record<string, MachineRunJsonValue> }
    | { action: 'status'; operationId: string }
    | { action: 'cancel'; operationId: string };

export type MachineRunCapabilityResponse =
    | {
        version: 1;
        action: 'capabilities';
        protocolVersion: 1;
        /** Runtime identity lets a host verify that the RPC came from its pinned artifact. */
        runtime: {
            packageName: string;
            packageVersion: string;
            protocolVersion: 1;
        };
        capabilities: readonly ['machine.run.v1'];
        supported: boolean;
        shell: false;
        stdin: 'none';
        maxTimeoutMs: number;
        maxOutputLimitBytes: number;
        profiles: Array<Pick<TrustedMachineRunProfile, 'id' | 'cwd' | 'parameters' | 'timeoutMs' | 'outputLimitBytes' | 'profileDigest'>>;
        reason?: string;
    }
    | Omit<TypedMachineRunResponse, 'version'>;

export interface MachineRunProfileHandlerOptions {
    platform?: NodeJS.Platform;
    /** Environment values are read by name; no other daemon environment is inherited. */
    environment?: NodeJS.ProcessEnv;
    extensionDataDirectory?: string;
    tempDirectory?: string;
    /** Reuse the legacy lifecycle store when both RPC shapes share a method. */
    typedHandler?: (input: TypedMachineRunRequest) => Promise<TypedMachineRunResponse>;
    /** Host-owned policy required before any profile with a write scope can run. */
    writeScopePolicy?: MachineRunWriteScopePolicy;
}

export interface MachineRunWriteScopePolicy {
    /** Validate the resolved workspace and reserve it for one active operation. */
    acquire(input: { profile: TrustedMachineRunProfile; workspaceRoot: string }): Promise<() => void>;
}

/**
 * Conservative default policy for managed project writes. It validates the
 * workspace identity and rejects protected control-plane entries. The caller
 * must still explicitly install it in the daemon; no write profile is enabled
 * by default.
 */
export function createManagedProjectWriteScopePolicy(): MachineRunWriteScopePolicy {
    const locks = new Set<string>();
    return {
        async acquire({ profile, workspaceRoot }) {
            if (profile.writeScope !== 'project' && profile.writeScope !== 'moai') throw new Error('MACHINE_RUN_WRITE_SCOPE_DENIED: unsupported write scope');
            const root = await realpath(workspaceRoot).catch(() => null);
            if (!root) throw new Error('MACHINE_RUN_WRITE_SCOPE_DENIED: workspace root is unavailable');
            const metadata = resolve(root, '.moai');
            const metadataInfo = await lstat(metadata).catch(() => null);
            if (metadataInfo?.isSymbolicLink()) throw new Error('MACHINE_RUN_WRITE_SCOPE_DENIED: .moai must not be a symlink');
            if (metadataInfo) {
                const metadataReal = await realpath(metadata).catch(() => null);
                if (!metadataReal || (metadataReal !== root && !metadataReal.startsWith(`${root}${sep}`))) {
                    throw new Error('MACHINE_RUN_WRITE_SCOPE_DENIED: .moai escapes workspace');
                }
            }
            const protectedNames = new Set(['.git', '.claude', '.aplus', 'AGENTS.md', 'CLAUDE.md']);
            for (const name of protectedNames) {
                const entry = resolve(root, name);
                const info = await lstat(entry).catch(() => null);
                if (info?.isSymbolicLink()) throw new Error(`MACHINE_RUN_WRITE_SCOPE_DENIED: protected symlink ${name}`);
            }
            // One lock per workspace: a project write covers .moai, so the two scopes must not overlap.
            const key = root;
            if (locks.has(key)) throw new Error('MACHINE_RUN_WRITE_SCOPE_BUSY: workspace has an active write operation');
            locks.add(key);
            let released = false;
            return () => { if (!released) { released = true; locks.delete(key); } };
        },
    };
}

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const EXECUTABLE = /^[a-z][a-z0-9._-]*$/;
const FORBIDDEN_EXECUTABLE = /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh|node|nodejs|deno|bun|python|python2|python3|ruby|perl|php|java|awk|gawk|osascript|npm|npx|env|xargs|ssh|tmux|make|cargo)$/i;
const FORBIDDEN_FLAG = /^(?:--from|--wake|--interactive|--tty|--tui|-i)$/;
const DANGEROUS_ENV = /^(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_|NODE_OPTIONS|BASH_ENV|GIT_SSH_COMMAND|GIT_CONFIG_|PYTHONSTARTUP)/;
const PARAMETER_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{([a-z][a-zA-Z0-9_]{0,63})\}\}/g;

function profileError(message: string): Error {
    return new Error(`MACHINE_RUN_PROFILE_INVALID: ${message}`);
}

function cloneParameter(parameter: MachineRunParameter): MachineRunParameter {
    return parameter.type === 'string'
        ? { type: 'string', maxLength: parameter.maxLength, ...(parameter.values ? { values: [...parameter.values] } : {}) }
        : { type: 'integer', min: parameter.min, max: parameter.max };
}

function validateProfile(raw: MachineRunProfile): TrustedMachineRunProfile {
    if (!raw || typeof raw !== 'object') throw profileError('profile must be an object');
    if (typeof raw.id !== 'string' || !PROFILE_ID.test(raw.id)) throw profileError('invalid profile id');
    if (typeof raw.executable !== 'string' || !EXECUTABLE.test(raw.executable) || FORBIDDEN_EXECUTABLE.test(raw.executable)) {
        throw profileError(`unsupported executable for ${raw.id}`);
    }
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.length > 32) throw profileError(`invalid argv for ${raw.id}`);
    for (const arg of raw.argv) {
        if (typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || FORBIDDEN_FLAG.test(arg) || (arg.includes('{{workspaceRoot}}') && arg !== '{{workspaceRoot}}') || (arg !== '{{workspaceRoot}}' && (arg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(arg)))) {
            throw profileError(`unsafe argument template for ${raw.id}`);
        }
    }
    if (!raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters)) throw profileError(`invalid parameters for ${raw.id}`);
    const parameters: Record<string, MachineRunParameter> = {};
    for (const [name, rawParameter] of Object.entries(raw.parameters)) {
        if (!PARAMETER_NAME.test(name) || !rawParameter || typeof rawParameter !== 'object') throw profileError(`invalid parameter ${name}`);
        const parameter = rawParameter as MachineRunParameter;
        if (parameter.type === 'string') {
            if (!Number.isSafeInteger(parameter.maxLength) || parameter.maxLength < 1 || parameter.maxLength > 4096) throw profileError(`invalid parameter ${name}`);
            if (parameter.values !== undefined && (!Array.isArray(parameter.values) || parameter.values.some((value) => typeof value !== 'string' || value.length > parameter.maxLength || value.includes('\0')))) {
                throw profileError(`invalid values for parameter ${name}`);
            }
        } else if (parameter.type === 'integer') {
            if (!Number.isSafeInteger(parameter.min) || !Number.isSafeInteger(parameter.max) || parameter.min > parameter.max) throw profileError(`invalid parameter ${name}`);
        } else {
            throw profileError(`unsupported parameter type for ${name}`);
        }
        parameters[name] = cloneParameter(parameter);
    }
    if (raw.cwd !== 'workspaceRoot' && raw.cwd !== 'extensionData' && raw.cwd !== 'temp') throw profileError(`unsupported cwd for ${raw.id}`);
    if (!Array.isArray(raw.envAllowlist) || raw.envAllowlist.some((key) => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key) || DANGEROUS_ENV.test(key))) {
        throw profileError(`unsafe environment allowlist for ${raw.id}`);
    }
    if (new Set(raw.envAllowlist).size !== raw.envAllowlist.length) throw profileError(`duplicate environment key for ${raw.id}`);
    if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > MACHINE_RUN_MAX_TIMEOUT_MS) throw profileError(`invalid timeout for ${raw.id}`);
    if (!Number.isSafeInteger(raw.outputLimitBytes) || raw.outputLimitBytes < 1 || raw.outputLimitBytes > MACHINE_RUN_MAX_OUTPUT_BYTES) throw profileError(`invalid output limit for ${raw.id}`);
    if (raw.stdin !== 'none') throw profileError(`stdin must be none for ${raw.id}`);
    if (raw.writeScope !== undefined && raw.writeScope !== 'none' && raw.writeScope !== 'moai' && raw.writeScope !== 'project') throw profileError(`unsupported write scope for ${raw.id}`);
    if (raw.descendantAllowlist !== undefined && (!Array.isArray(raw.descendantAllowlist) || raw.descendantAllowlist.length > 8 || raw.descendantAllowlist.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/i.test(name) || /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh|node|python|python3|npm|npx|env|xargs|ssh|tmux|vi|vim|nvim|nano|less|more)$/i.test(name)))) throw profileError(`unsafe descendants for ${raw.id}`);

    // Validate placeholders against the profile's declaration while keeping the
    // declaration immutable after the trusted host has accepted it.
    const names = new Set(Object.keys(parameters));
    for (const arg of raw.argv) {
        for (const match of arg.matchAll(PLACEHOLDER)) if (match[1] !== 'workspaceRoot' && !names.has(match[1])) throw profileError(`unknown parameter ${match[1]} in ${raw.id}`);
        if (arg.includes('{{') && !arg.match(PLACEHOLDER)) throw profileError(`malformed parameter template in ${raw.id}`);
    }
    const profile: MachineRunProfile = {
        id: raw.id,
        executable: raw.executable,
        argv: [...raw.argv],
        parameters,
        cwd: raw.cwd,
        envAllowlist: [...raw.envAllowlist],
        timeoutMs: raw.timeoutMs,
        outputLimitBytes: raw.outputLimitBytes,
        stdin: 'none',
        ...(raw.writeScope ? { writeScope: raw.writeScope } : {}),
        ...(raw.descendantAllowlist ? { descendantAllowlist: [...raw.descendantAllowlist] } : {}),
    };
    const sealedProfile = {
        ...profile,
        argv: Object.freeze(profile.argv) as unknown as string[],
        parameters: Object.freeze(Object.fromEntries(Object.entries(parameters).map(([name, parameter]) => [
            name,
            Object.freeze(parameter.type === 'string' && parameter.values
                ? { ...parameter, values: Object.freeze([...parameter.values]) }
                : parameter),
        ]))) as Record<string, MachineRunParameter>,
        envAllowlist: Object.freeze(profile.envAllowlist) as unknown as string[],
        ...(profile.descendantAllowlist
            ? { descendantAllowlist: Object.freeze([...profile.descendantAllowlist]) as unknown as string[] }
            : {}),
    } as TrustedMachineRunProfile;
    sealedProfile.profileDigest = hashObject(sealedProfile);
    return Object.freeze(sealedProfile);
}

export function createTrustedMachineRunProfileResolver(profiles: readonly MachineRunProfile[]): MachineRunProfileResolver {
    const byId = new Map<string, TrustedMachineRunProfile>();
    for (const profile of profiles) {
        const validated = validateProfile(profile);
        if (byId.has(validated.id)) throw profileError(`duplicate profile id ${validated.id}`);
        byId.set(validated.id, validated);
    }
    return Object.freeze({
        resolve: (profileId: string) => byId.get(profileId),
        list: () => [...byId.values()],
    });
}

/** No host-owned profiles are currently shipped by the daemon. */
export const TRUSTED_MACHINE_RUN_PROFILE_REGISTRY: TrustedMachineRunProfileRegistry =
    createTrustedMachineRunProfileResolver([]);

export function machineRunCapabilitySupported(
    registry: TrustedMachineRunProfileRegistry,
    platform: NodeJS.Platform = process.platform,
): boolean {
    return platform !== 'win32' && registry.list().some((profile) => (profile.writeScope ?? 'none') === 'none' && (profile.descendantAllowlist?.length ?? 0) === 0);
}

function resolverFor(source: MachineRunProfileResolver | readonly MachineRunProfile[]): MachineRunProfileResolver {
    return typeof source === 'object' && 'resolve' in source && 'list' in source
        ? source
        : createTrustedMachineRunProfileResolver(source as readonly MachineRunProfile[]);
}

function assertCapabilityRequest(value: unknown): asserts value is MachineRunCapabilityRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MACHINE_RUN_INVALID: request must be an object');
    const request = value as Record<string, unknown>;
    if (request.action === 'capabilities') {
        assertKnownFields(request, ['action', 'version']);
        if (request.version !== undefined && request.version !== 1) throw new Error('MACHINE_RUN_INVALID: unsupported version');
        return;
    }
    if (request.action === 'start') {
        assertKnownFields(request, ['action', 'profileId', 'profileDigest', 'workspaceRoot', 'parameters']);
        if (typeof request.profileId !== 'string' || request.profileId.length === 0 || request.profileId.length > 256) throw new Error('MACHINE_RUN_INVALID: profileId is required');
        if (typeof request.profileDigest !== 'string' || request.profileDigest.length !== 64 || !/^[a-f0-9]{64}$/.test(request.profileDigest)) throw new Error('MACHINE_RUN_INVALID: profileDigest is required');
        if (typeof request.workspaceRoot !== 'string' || request.workspaceRoot.length === 0 || !isAbsolute(request.workspaceRoot)) throw new Error('MACHINE_RUN_INVALID: workspaceRoot must be absolute');
        if (!request.parameters || typeof request.parameters !== 'object' || Array.isArray(request.parameters)) throw new Error('MACHINE_RUN_INVALID: parameters must be an object');
        return;
    }
    if (request.action === 'status' || request.action === 'cancel') {
        assertKnownFields(request, ['action', 'operationId']);
        if (typeof request.operationId !== 'string' || request.operationId.length === 0 || request.operationId.length > 256) throw new Error('MACHINE_RUN_INVALID: operationId is required');
        return;
    }
    throw new Error('MACHINE_RUN_INVALID: unsupported action');
}

function assertKnownFields(request: Record<string, unknown>, allowed: readonly string[]): void {
    const allowedFields = new Set(allowed);
    const unknown = Object.keys(request).find((key) => !allowedFields.has(key));
    if (unknown) throw new Error(`MACHINE_RUN_INVALID: unknown field ${unknown}`);
}

async function resolveWorkspaceRoot(target: string, workingDirectory: string): Promise<string> {
    const lexical = validatePath(target, workingDirectory);
    if (!lexical.valid || !lexical.resolvedPath) throw new Error(`MACHINE_RUN_WORKSPACE_ROOT_DENIED: ${lexical.error ?? 'workspaceRoot is outside the daemon root'}`);
    const [root, resolved] = await Promise.all([
        realpath(workingDirectory).catch(() => null),
        realpath(lexical.resolvedPath).catch(() => null),
    ]);
    if (!root || !resolved || (resolved !== root && !resolved.startsWith(`${root}/`))) throw new Error('MACHINE_RUN_WORKSPACE_ROOT_DENIED: realpath is outside the daemon root');
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) throw new Error('MACHINE_RUN_WORKSPACE_ROOT_DENIED: workspaceRoot must be a directory');
    return resolved;
}

function parameterValue(parameter: MachineRunParameter, value: unknown, name: string): string {
    if (parameter.type === 'string') {
        if (typeof value !== 'string' || value.length === 0 || value.length > parameter.maxLength || value.includes('\0') || value.startsWith('-') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.split('/').includes('..')) throw new Error(`MACHINE_RUN_INVALID: invalid parameter ${name}`);
        if (parameter.values && !parameter.values.includes(value)) throw new Error(`MACHINE_RUN_INVALID: invalid parameter ${name}`);
        return value;
    }
    if (!Number.isSafeInteger(value) || (value as number) < parameter.min || (value as number) > parameter.max) throw new Error(`MACHINE_RUN_INVALID: invalid parameter ${name}`);
    return String(value);
}

function buildArguments(profile: MachineRunProfile, supplied: Record<string, MachineRunJsonValue>): string[] {
    const known = new Set(Object.keys(profile.parameters));
    for (const name of Object.keys(supplied)) if (!known.has(name)) throw new Error(`MACHINE_RUN_INVALID: unknown parameter ${name}`);
    const values = new Map<string, string>();
    for (const [name, parameter] of Object.entries(profile.parameters)) {
        if (!(name in supplied)) throw new Error(`MACHINE_RUN_INVALID: missing parameter ${name}`);
        values.set(name, parameterValue(parameter, supplied[name], name));
    }
    const used = new Set<string>();
    const args = profile.argv.map((template) => template.replace(PLACEHOLDER, (_match, name: string) => {
        if (name === 'workspaceRoot') return '__WORKSPACE_ROOT__';
        used.add(name);
        const value = values.get(name);
        if (value === undefined) throw new Error(`MACHINE_RUN_INVALID: missing parameter ${name}`);
        return value;
    }));
    // A profile may use positional parameters without template markers. Their
    // declaration order is stable because manifests are parsed in order.
    for (const [name, value] of values) if (!used.has(name)) args.push(value);
    if (args.length > 64) throw new Error('MACHINE_RUN_INVALID: too many arguments');
    return args;
}

function capabilityResponse(resolver: MachineRunProfileResolver, platform: NodeJS.Platform): Extract<MachineRunCapabilityResponse, { action: 'capabilities' }> {
    const supported = machineRunCapabilitySupported(resolver, platform);
    const profiles = resolver.list().filter((profile) => (profile.writeScope ?? 'none') === 'none' && (profile.descendantAllowlist?.length ?? 0) === 0);
    return {
        version: 1,
        action: 'capabilities',
        protocolVersion: 1,
        runtime: {
            packageName: packageJson.name,
            packageVersion: packageJson.version,
            protocolVersion: 1,
        },
        capabilities: ['machine.run.v1'],
        supported,
        shell: false,
        stdin: 'none',
        maxTimeoutMs: MACHINE_RUN_MAX_TIMEOUT_MS,
        maxOutputLimitBytes: MACHINE_RUN_MAX_OUTPUT_BYTES,
        profiles: supported ? profiles.map(({ id, cwd, parameters, timeoutMs, outputLimitBytes, profileDigest }) => ({
            id, cwd, parameters, timeoutMs, outputLimitBytes, profileDigest,
        })) : [],
        ...(platform === 'win32'
            ? { reason: 'MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required' }
            : supported
                ? {}
                : { reason: 'MACHINE_RUN_PROFILE_REGISTRY_UNAVAILABLE: no trusted profiles are registered' }),
    };
}

function withoutVersion(response: TypedMachineRunResponse): Omit<TypedMachineRunResponse, 'version'> {
    const { version: _version, ...result } = response;
    return result;
}

export function createProfileAwareMachineRunHandler(
    workingDirectory: string,
    source: MachineRunProfileResolver | readonly MachineRunProfile[],
    options: MachineRunProfileHandlerOptions = {},
): (input: unknown) => Promise<MachineRunCapabilityResponse> {
    const resolver = resolverFor(source);
    const platform = options.platform ?? process.platform;
    const environment = options.environment ?? process.env;
    const writeReleases = new Map<string, () => void>();
    const baseEnvironment: Record<string, string> = { PATH: environment.PATH ?? '' };
    const legacyHandler = options.typedHandler ?? createTypedMachineRunHandler(workingDirectory, {
        platform,
        baseEnvironment,
        allowAbsoluteArguments: true,
        allowStructuredArguments: true,
    });

    return async (input: unknown) => {
        assertCapabilityRequest(input);
        if (input.action === 'capabilities') return capabilityResponse(resolver, platform);
        if (platform === 'win32') throw new Error('MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required');
        if (input.action === 'status' || input.action === 'cancel') {
            const result = await legacyHandler({ version: 1, action: input.action, operationId: input.operationId });
            if (result.action === 'status' && result.state !== 'running' || result.action === 'cancel') {
                writeReleases.get(input.operationId)?.();
                writeReleases.delete(input.operationId);
            }
            return withoutVersion(result);
        }

        const profile = resolver.resolve(input.profileId);
        if (!profile) throw new Error(`MACHINE_RUN_PROFILE_NOT_FOUND: ${input.profileId}`);
        if (profile.profileDigest !== input.profileDigest) throw new Error(`MACHINE_RUN_PROFILE_DIGEST_MISMATCH: ${input.profileId}`);
        const requestedWorkspaceRoot = await resolveWorkspaceRoot(input.workspaceRoot, workingDirectory);
        let releaseWrite: (() => void) | undefined;
        try {
            if ((profile.writeScope ?? 'none') !== 'none') {
                if (!options.writeScopePolicy) throw new Error(`MACHINE_RUN_WRITE_SCOPE_UNSUPPORTED: ${input.profileId}`);
                releaseWrite = await options.writeScopePolicy.acquire({ profile, workspaceRoot: requestedWorkspaceRoot });
            }
            if ((profile.descendantAllowlist?.length ?? 0) > 0) throw new Error(`MACHINE_RUN_DESCENDANT_POLICY_UNSUPPORTED: ${input.profileId}`);
        } catch (error) {
            releaseWrite?.();
            throw error;
        }
        try {
            const cwd = profile.cwd === 'workspaceRoot'
                ? requestedWorkspaceRoot
                : profile.cwd === 'extensionData'
                    ? options.extensionDataDirectory
                    : options.tempDirectory ?? tmpdir();
            if (!cwd) throw new Error(`MACHINE_RUN_PROFILE_ROOT_UNAVAILABLE: ${profile.cwd}`);
            const env: Record<string, string> = {};
            for (const name of profile.envAllowlist) {
                const value = environment[name];
                if (value !== undefined) env[name] = value;
            }
            const args = buildArguments(profile, input.parameters).map((arg) => arg === '__WORKSPACE_ROOT__' ? requestedWorkspaceRoot : arg);
            const result = await legacyHandler({
                version: 1,
                action: 'start',
                executable: profile.executable,
                args,
                cwd: resolve(cwd),
                env,
                timeoutMs: profile.timeoutMs,
                outputLimitBytes: profile.outputLimitBytes,
            });
            if (releaseWrite) writeReleases.set(result.operationId, releaseWrite);
            return withoutVersion(result);
        } catch (error) {
            releaseWrite?.();
            throw error;
        }
    };
}

// Names used by different Desktop integration layers; keep one implementation.
export const createMachineRunCapabilityHandler = createProfileAwareMachineRunHandler;
export const createMachineRunProfileHandler = createProfileAwareMachineRunHandler;
