import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
    createTypedMachineRunHandler,
    MACHINE_RUN_MAX_OUTPUT_BYTES,
    MACHINE_RUN_MAX_TIMEOUT_MS,
    type TypedMachineRunRequest,
    type TypedMachineRunResponse,
} from './typedMachineRun';

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
}

export interface MachineRunProfileResolver {
    resolve(profileId: string): MachineRunProfile | undefined;
    list(): readonly MachineRunProfile[];
}

export type MachineRunCapabilityRequest =
    | { action: 'capabilities'; version?: 1 }
    | { action: 'start'; profileId: string; parameters: Record<string, MachineRunJsonValue> }
    | { action: 'status'; operationId: string }
    | { action: 'cancel'; operationId: string };

export type MachineRunCapabilityResponse =
    | {
        version: 1;
        action: 'capabilities';
        protocolVersion: 1;
        supported: boolean;
        shell: false;
        stdin: 'none';
        maxTimeoutMs: number;
        maxOutputLimitBytes: number;
        profiles: Array<Pick<MachineRunProfile, 'id' | 'cwd' | 'parameters' | 'timeoutMs' | 'outputLimitBytes'>>;
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
}

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const EXECUTABLE = /^[a-z][a-z0-9._-]*$/;
const FORBIDDEN_EXECUTABLE = /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh|node|python|python3|npm|npx|env|xargs|ssh|tmux)$/i;
const FORBIDDEN_FLAG = /^(?:--from|--wake|--interactive|--tty|--tui|-i)$/;
const DANGEROUS_ENV = /^(?:PATH|LD_PRELOAD|DYLD_|NODE_OPTIONS|BASH_ENV|GIT_SSH_COMMAND|PYTHONSTARTUP)/;
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

function validateProfile(raw: MachineRunProfile): MachineRunProfile {
    if (!raw || typeof raw !== 'object') throw profileError('profile must be an object');
    if (typeof raw.id !== 'string' || !PROFILE_ID.test(raw.id)) throw profileError('invalid profile id');
    if (typeof raw.executable !== 'string' || !EXECUTABLE.test(raw.executable) || FORBIDDEN_EXECUTABLE.test(raw.executable)) {
        throw profileError(`unsupported executable for ${raw.id}`);
    }
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.length > 32) throw profileError(`invalid argv for ${raw.id}`);
    for (const arg of raw.argv) {
        if (typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || FORBIDDEN_FLAG.test(arg) || arg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(arg)) {
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

    // Validate placeholders against the profile's declaration while keeping the
    // declaration immutable after the trusted host has accepted it.
    const names = new Set(Object.keys(parameters));
    for (const arg of raw.argv) {
        for (const match of arg.matchAll(PLACEHOLDER)) if (!names.has(match[1])) throw profileError(`unknown parameter ${match[1]} in ${raw.id}`);
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
    };
    return Object.freeze({
        ...profile,
        argv: Object.freeze(profile.argv) as unknown as string[],
        parameters: Object.freeze(Object.fromEntries(Object.entries(parameters).map(([name, parameter]) => [
            name,
            Object.freeze(parameter),
        ]))) as Record<string, MachineRunParameter>,
        envAllowlist: Object.freeze(profile.envAllowlist) as unknown as string[],
    });
}

export function createTrustedMachineRunProfileResolver(profiles: readonly MachineRunProfile[]): MachineRunProfileResolver {
    const byId = new Map<string, MachineRunProfile>();
    for (const profile of profiles) {
        const validated = validateProfile(profile);
        if (byId.has(validated.id)) throw profileError(`duplicate profile id ${validated.id}`);
        byId.set(validated.id, validated);
    }
    return {
        resolve: (profileId) => byId.get(profileId),
        list: () => [...byId.values()],
    };
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
        if (request.version !== undefined && request.version !== 1) throw new Error('MACHINE_RUN_INVALID: unsupported version');
        return;
    }
    if (request.action === 'start') {
        if (typeof request.profileId !== 'string' || request.profileId.length === 0 || request.profileId.length > 256) throw new Error('MACHINE_RUN_INVALID: profileId is required');
        if (!request.parameters || typeof request.parameters !== 'object' || Array.isArray(request.parameters)) throw new Error('MACHINE_RUN_INVALID: parameters must be an object');
        return;
    }
    if (request.action === 'status' || request.action === 'cancel') {
        if (typeof request.operationId !== 'string' || request.operationId.length === 0 || request.operationId.length > 256) throw new Error('MACHINE_RUN_INVALID: operationId is required');
        return;
    }
    throw new Error('MACHINE_RUN_INVALID: unsupported action');
}

function parameterValue(parameter: MachineRunParameter, value: unknown, name: string): string {
    if (parameter.type === 'string') {
        if (typeof value !== 'string' || value.length > parameter.maxLength || value.includes('\0')) throw new Error(`MACHINE_RUN_INVALID: invalid parameter ${name}`);
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
    for (const [name, value] of Object.entries(supplied)) values.set(name, parameterValue(profile.parameters[name], value, name));
    const used = new Set<string>();
    const args = profile.argv.map((template) => template.replace(PLACEHOLDER, (_match, name: string) => {
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
    const supported = platform !== 'win32';
    return {
        version: 1,
        action: 'capabilities',
        protocolVersion: 1,
        supported,
        shell: false,
        stdin: 'none',
        maxTimeoutMs: MACHINE_RUN_MAX_TIMEOUT_MS,
        maxOutputLimitBytes: MACHINE_RUN_MAX_OUTPUT_BYTES,
        profiles: supported ? resolver.list().map(({ id, cwd, parameters, timeoutMs, outputLimitBytes }) => ({
            id, cwd, parameters, timeoutMs, outputLimitBytes,
        })) : [],
        ...(supported ? {} : { reason: 'MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required' }),
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
    const baseEnvironment: Record<string, string> = { PATH: environment.PATH ?? '' };
    const legacyHandler = options.typedHandler ?? createTypedMachineRunHandler(workingDirectory, {
        platform,
        baseEnvironment,
        allowUnsafeArguments: true,
    });

    return async (input: unknown) => {
        assertCapabilityRequest(input);
        if (input.action === 'capabilities') return capabilityResponse(resolver, platform);
        if (platform === 'win32') throw new Error('MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required');
        if (input.action === 'status' || input.action === 'cancel') return withoutVersion(await legacyHandler({ version: 1, action: input.action, operationId: input.operationId }));

        const profile = resolver.resolve(input.profileId);
        if (!profile) throw new Error(`MACHINE_RUN_PROFILE_NOT_FOUND: ${input.profileId}`);
        const cwd = profile.cwd === 'workspaceRoot'
            ? workingDirectory
            : profile.cwd === 'extensionData'
                ? options.extensionDataDirectory
                : options.tempDirectory ?? tmpdir();
        if (!cwd) throw new Error(`MACHINE_RUN_PROFILE_ROOT_UNAVAILABLE: ${profile.cwd}`);
        const env: Record<string, string> = {};
        for (const name of profile.envAllowlist) {
            const value = environment[name];
            if (value !== undefined) env[name] = value;
        }
        const result = await legacyHandler({
            version: 1,
            action: 'start',
            executable: profile.executable,
            args: buildArguments(profile, input.parameters),
            cwd: resolve(cwd),
            env,
            timeoutMs: profile.timeoutMs,
            outputLimitBytes: profile.outputLimitBytes,
        });
        return withoutVersion(result);
    };
}

// Names used by different Desktop integration layers; keep one implementation.
export const createMachineRunCapabilityHandler = createProfileAwareMachineRunHandler;
export const createMachineRunProfileHandler = createProfileAwareMachineRunHandler;
