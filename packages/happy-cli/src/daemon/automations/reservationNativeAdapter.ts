import { ReservationNativeMonitor } from './reservationNativeMonitor';
import type { ToolPolicyGate } from '@/toolPolicy/policyGate';
import { dirname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { ApiSessionClient } from '@/api/apiSession';
import type { Session } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';
import { reservationLeaseViewSchema, type ReservationLeaseRequest, type ReservationRuntimeIdentity, type ReservationExitProof } from '@slopus/happy-wire';
import type { ServerAutomationExecutorInput } from './serverAutomationExecutor';
import type { ReservationTurnDependencies, ReservationTurnDescriptor } from './reservationConversationTurn';
import { ReservationNativeContainers, reservationDocker, type ReservationContainer } from './reservationNativeContainer';
import { createReservationNativeBroker } from './reservationNativeBroker';
import { reservationGitCommonDirectory, findReservationNativeTranscript, prepareReservationNativeNetwork, prepareReservationNativeWorkspace } from './reservationNativeWorkspace';
import { resolveReservationNativeAuth, resolveReservationNativeGithub } from './reservationNativeAuth';
import { runReservationNativeProvider } from './reservationNativeProvider';
import { readWorkspaceHeadSha } from './agentTaskReviewObjects';

type Adapter = NonNullable<ServerAutomationExecutorInput['reservationConversation']>;
type Definition = Parameters<Adapter['describe']>[0];
export type ReservationNativeSession = { session: Session; home: string; environment: Record<string, string | undefined>; running: boolean; processedSeq: number | null };
export type ReservationNativeHost = {
  accountId: string; machineId: string; token: string; serverUrl: string; image: string; directory: string;
  resolve(sessionId: string): Promise<ReservationNativeSession | null>;
  aiEnvironment(sessionId: string): Promise<Record<string, string>>;
  connectors(context: Definition['mcpContext'], sessionId: string): Promise<Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>>;
  lease(request: ReservationLeaseRequest): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  transport: ServerAutomationExecutorInput['transport']; deliver: NonNullable<ReservationTurnDependencies['deliver']>;
  checkpoint: NonNullable<Adapter['checkpoint']>;
  commitCursor(sessionId: string): Promise<void>;
  policy?(sessionId: string): ToolPolicyGate | undefined;
  recordExit(runId: string, proof: ReservationExitProof): void;
};
type Turn = { monitor?: ReservationNativeMonitor; recovering?: boolean; controller: AbortController; cleanup?: () => Promise<{ stored: boolean; proof: ReservationExitProof | null }>; definition: Definition; descriptor: ReservationTurnDescriptor; target: ReservationNativeSession; model: string; nativeId: string; transcript: string;
  handle?: ReservationContainer; scope?: ReservationContainer['scope']; workspace?: Awaited<ReturnType<typeof prepareReservationNativeWorkspace>>;
  network?: Awaited<ReturnType<typeof prepareReservationNativeNetwork>>; broker?: Awaited<ReturnType<typeof createReservationNativeBroker>>;
  auth?: Awaited<ReturnType<typeof resolveReservationNativeAuth>>; output?: ApiSessionClient; containerAttempted?: boolean; exit?: { exited: boolean; runtime?: ReservationRuntimeIdentity }; answer: string; outcome?: 'WOKE' | 'SILENT'; deliveryAttempted?: boolean; deliveryUncertain?: boolean; activity?: NodeJS.Timeout; failed?: boolean; claimToken?: string;
};

/** Only immutable, explicitly configured images that contain both native CLIs are advertised. Never installs or pulls an image. */
export async function verifyReservationNativeImage(image: string): Promise<void> {
  if (!process.getuid || process.getuid() <= 0) throw new Error('RESERVATION_NONROOT_OWNER_REQUIRED');
  if (!/^(?:sha256:|[\w./:-]+@sha256:)[a-f0-9]{64}$/.test(image)) throw new Error('RESERVATION_IMAGE_INVALID');
  const result = await reservationDocker.command(['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
    '--tmpfs', '/tmp:rw,nosuid,size=16m', '--entrypoint', 'sh', image, '-c',
    `node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||a===24&&b<5)process.exit(2)' && timeout 10 claude --version && timeout 10 codex --version`]);
  if (!/2\.1\./.test(result) || !/codex-cli 0\.153\./.test(result)) throw new Error('RESERVATION_NATIVE_VERSION_UNSUPPORTED');
}

/** Concrete adapter: the Happy chat remains in the host; only native CLIs and project tools run in the scoped container. */
export function createReservationNativeAdapter(host: ReservationNativeHost): Adapter & {
  cancel(sessionId: string): boolean;
  takeResult(runId: string): { finalAnswer: string | null; silent: boolean } | undefined;
  recover(run: { runId: string; sessionId: string; epoch?: string; descriptorHash: string; runtime?: ReservationRuntimeIdentity; launchIntent?: boolean; preparation?: { engineId: string; directory?: string; cleaned?: boolean } }): Promise<{ stored: boolean; proof: ReservationExitProof | null }>;
} {
  const owner = createHash('sha256').update(JSON.stringify([host.serverUrl, host.accountId, host.machineId])).digest('hex');
  const containers = new ReservationNativeContainers(), turns = new Map<string, Turn>(), results = new Map<string, { finalAnswer: string | null; silent: boolean }>();
  const lookup = (runId: string) => { const turn = turns.get(runId); if (!turn) throw new Error('RESERVATION_NATIVE_CONTEXT_MISSING'); return turn; };
  const lease = async (request: ReservationLeaseRequest) => {
    const result = await host.lease(request); if (!result.ok) return { ok: false as const, error: result.error ?? 'RESERVATION_LEASE_UNCONFIRMED' };
    const parsed = reservationLeaseViewSchema.safeParse(result.value); return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, error: 'RESERVATION_LEASE_INVALID' };
  };
  return {
    checkpoint: host.checkpoint,
    runScript: ({ runId, command, notepad }) => { const turn = lookup(runId); if (!turn.monitor) throw new Error('RESERVATION_COMMAND_SCOPE_UNAVAILABLE'); return turn.monitor.run({ command, notepad }); },
    async describe(definition) {
      const target = await host.resolve(definition.sessionId), agent = definition.payload.agent ?? 'claude';
      if ((definition.payload.monitorCommand || definition.payload.scriptCommand) && !definition.payload.reservation?.commands) throw new Error('RESERVATION_COMMAND_SCOPE_UNSUPPORTED');
      if (!target || !['claude', 'codex'].includes(agent) || target.session.metadata.flavor !== agent || target.running) throw new Error('RESERVATION_TARGET_BUSY_OR_UNAVAILABLE');
      const nativeId = agent === 'claude' ? target.session.metadata.claudeSessionId : target.session.metadata.codexThreadId;
      const model = definition.payload.model ?? target.session.metadata.currentModelCode;
      if (!nativeId || !/^[a-f0-9-]{36}$/i.test(nativeId) || !model || ['auto', 'default'].includes(model)) throw new Error('RESERVATION_NATIVE_LINEAGE_OR_MODEL_UNCONFIRMED');
      const baseDirectory = await realpath(target.session.metadata.path), executionDirectory = await realpath(definition.executionDirectory);
      let common: string | null = null;
      try { common = await reservationGitCommonDirectory(baseDirectory); } catch {
        // A plain project can be monitored, but a broken/embedded Git root cannot expose its config to commands.
        if (definition.githubTarget || definition.agentTaskDispatch || baseDirectory !== executionDirectory || baseDirectory !== await realpath(definition.payload.directory)) throw new Error('RESERVATION_DIRECTORY_MISMATCH');
        if (await lstat(join(baseDirectory, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) throw new Error('RESERVATION_GIT_SCOPE_INVALID');
      }
      if (common && (common !== await reservationGitCommonDirectory(await realpath(definition.payload.directory)) || common !== await reservationGitCommonDirectory(executionDirectory))) throw new Error('RESERVATION_DIRECTORY_MISMATCH');
      const headSha = common ? await readWorkspaceHeadSha({ directory: executionDirectory }) : null;
      const request = definition.agentTaskDispatch?.input as { baseSha?: unknown; headSha?: unknown; reviewedHeadSha?: unknown } | null;
      const expectedHead = request?.reviewedHeadSha ?? request?.headSha ?? definition.githubTarget?.headSha;
      if (common && !headSha || expectedHead && expectedHead !== headSha) throw new Error('RESERVATION_HEAD_CHANGED');
      const policy = definition.mcpContext?.connectorPolicy;
      if (policy === 'unspecified') throw new Error('RESERVATION_CONNECTOR_POLICY_UNCONFIRMED');
      const descriptor: ReservationTurnDescriptor = { version: 1, automationId: definition.automationId, generation: definition.generation, runId: definition.runId,
        sessionId: definition.sessionId, machineId: host.machineId, accountId: host.accountId, agent: agent as 'claude' | 'codex', baseDirectory, executionDirectory,
        // Review work happens in a throwaway checkout and may install dependencies; publish tools remain separately constrained.
        writeMode: 'worktree', headSha, baseSha: typeof request?.baseSha === 'string' ? request.baseSha : null,
        connectorPolicy: policy ?? 'none', requiredConnectors: definition.mcpContext?.requiredConnectors ?? [],
        credentialHandles: [...(definition.mcpContext?.mcpCallerGrant ? ['connectors'] : []), ...(definition.agentTaskDispatch ? ['agent-task'] : []), ...(definition.githubTarget ? ['github'] : [])] };
      const transcript = await findReservationNativeTranscript(descriptor.agent, nativeId, baseDirectory, target.environment, target.home);
      turns.set(definition.runId, { controller: new AbortController(), definition, target, descriptor, nativeId, transcript, model, answer: '' }); return descriptor;
    },
    async encryptPrompt(sessionId, runId, prompt) {
      const turn = lookup(runId); if (turn.descriptor.sessionId !== sessionId) throw new Error('RESERVATION_CONTEXT_MISMATCH');
      if (turn.definition.githubTarget && !turn.definition.agentTaskDispatch) prompt = [
        '[Scoped GitHub reservation runtime]',
        'Continue only this existing chat. Use reservation_exec for project commands and file edits. Do not create or fork a chat or delegate to another agent.',
        'Use reservation_github_read for the assigned GitHub target. Publish changes only through reservation_github_publish_fix; gh/git push have no credentials here. This tool rechecks the pinned remote head and returns fixBranch, fixPrUrl and sha.',
        'Provide changed relative paths, file modes and full contentBase64 (null for deletion) to publish_fix. The original branch is never overwritten. Treat a changed head as stale and stop publication.',
        `Pinned checkout HEAD: ${turn.descriptor.headSha}`,
        '', prompt,
      ].join('\n');
      // The trusted host retains the exact model input until server delivery is confirmed.
      (turn as Turn & { prompt: string }).prompt = prompt;
      return encodeBase64(encrypt(turn.target.session.encryptionKey, turn.target.session.encryptionVariant,
        { role: 'user', content: { type: 'text', text: prompt }, localKey: `happy-automation:${runId}`, meta: { sentFrom: 'automation' } }));
    },
    dependencies: ({ descriptor, claimToken }) => {
      const turn = lookup(descriptor.runId); turn.claimToken = claimToken;
      const base = { wireVersion: 1 as const, runId: descriptor.runId, sessionId: descriptor.sessionId, claimToken };
      const dependencies: ReservationTurnDependencies = {
        now: Date.now, checkpoint: async () => {}, lease, heartbeatRun: async () => (await host.transport.heartbeat({ runId: descriptor.runId, claimToken })).ok,
        async prepare() {
          const fresh = await host.resolve(descriptor.sessionId);
          if (!fresh || fresh.running || fresh.session.metadata.path !== turn.target.session.metadata.path || fresh.processedSeq !== fresh.session.seq
            || (descriptor.agent === 'claude' ? fresh.session.metadata.claudeSessionId : fresh.session.metadata.codexThreadId) !== turn.nativeId) throw new Error('RESERVATION_TARGET_BUSY_OR_UNAVAILABLE');
          turn.target = fresh; return { expectedSeq: fresh.session.seq };
        },
        ...(turn.definition.payload.reservation?.commands ? {
          prepareCommands: async (input: Parameters<NonNullable<ReservationTurnDependencies['prepareCommands']>>[0]) => {
            turn.scope = { owner, runId: descriptor.runId, sessionId: descriptor.sessionId, epoch: input.epoch, descriptorHash: input.descriptorHash };
            const commands = turn.definition.payload.reservation!.commands!;
            turn.monitor = new ReservationNativeMonitor(containers, { scope: { ...turn.scope, role: 'preparation' }, image: host.image, userSignal: turn.controller.signal,
              workspace: { root: host.directory, descriptor, nativeId: turn.nativeId, sourceTranscript: turn.transcript, broker: { url: '', token: '' }, model: turn.model,
                projectEnvironment: turn.definition.environmentVariables, protectedDirectories: [turn.target.home, dirname(host.directory), turn.target.environment.CLAUDE_CONFIG_DIR ?? join(turn.target.home, '.claude'), turn.target.environment.CODEX_HOME ?? join(turn.target.home, '.codex')] },
              allowedOrigins: commands.allowedOrigins, privateOrigins: commands.privateOrigins });
            await turn.monitor.prepare(input);
          },
          renewPreparation: async (deadline: number) => { await turn.monitor?.renew(deadline); },
          finishPreparation: async () => { await turn.monitor?.close(); },
        } : {}),
        async start(input) {
          turn.controller.signal.throwIfAborted();
          turn.scope = { owner, runId: descriptor.runId, sessionId: descriptor.sessionId, epoch: input.epoch, descriptorHash: input.descriptorHash };
          turn.auth = await resolveReservationNativeAuth({ agent: descriptor.agent, home: turn.target.home,
            environment: { ...turn.target.environment, ...await host.aiEnvironment(descriptor.sessionId) } });
          const authorize = async () => {
            turn.controller.signal.throwIfAborted();
            const response = await lease({ ...base, operation: 'heartbeat', epoch: input.epoch });
            if (!response.ok || response.value.state !== 'RUNNING' || response.value.epoch !== input.epoch || response.value.descriptorHash !== input.descriptorHash || response.value.runId !== descriptor.runId || response.value.sessionId !== descriptor.sessionId) throw new Error('RESERVATION_AUTHORITY_LOST');
          };
          const env = turn.definition.environmentVariables ?? {}, task = turn.definition.agentTaskDispatch;
          const number = (task?.input as any)?.prNumber ?? turn.definition.githubTarget?.number;
          const github = number ? await resolveReservationNativeGithub({ directory: turn.definition.payload.directory, environment: env, allowMachineDefault: !turn.definition.payload.githubTrigger?.githubCredentialId }) : undefined;
          turn.broker = await createReservationNativeBroker({ policy: host.policy?.(descriptor.sessionId), runId: descriptor.runId, agent: descriptor.agent, model: turn.model, ai: turn.auth,
            task, ...(github && number ? { github: { ...github, number, headSha: descriptor.headSha!, mode: turn.definition.githubTarget?.kind === 'issue' ? 'issue' : task && task.type !== 'review_apply.v1' ? 'review' : 'apply' } } : {}),
            connectors: await host.connectors(turn.definition.mcpContext, descriptor.sessionId), connectorPolicy: descriptor.connectorPolicy,
            requiredConnectors: descriptor.requiredConnectors, authorize,
            execute: async (command, signal) => {
              if (!turn.handle || !turn.workspace) throw new Error('RESERVATION_SCOPE_UNAVAILABLE'); signal.throwIfAborted();
              const child = await containers.execute(turn.handle, { command: '/bin/sh', args: ['-lc', command], cwd: descriptor.executionDirectory,
                uid: process.getuid!(), gid: process.getgid!(), environmentFile: turn.workspace.toolEnvFile });
              return new Promise((resolveResult, reject) => {
                let stdout = '', stderr = '', size = 0;
                const capture = (chunk: Buffer, error: boolean) => { size += chunk.length; if (size > 1024 * 1024) return; if (error) stderr += chunk; else stdout += chunk; };
                child.stdout!.on('data', chunk => capture(chunk, false)); child.stderr!.on('data', chunk => capture(chunk, true));
                child.once('error', () => reject(new Error('RESERVATION_TOOL_FAILED'))); child.once('close', exitCode => resolveResult({ stdout, stderr, exitCode }));
              });
            } });
          turn.workspace = await prepareReservationNativeWorkspace({ root: host.directory, descriptor, nativeId: turn.nativeId, sourceTranscript: turn.transcript,
            broker: turn.broker, model: turn.model, projectEnvironment: env, protectedDirectories: [turn.target.home, dirname(host.directory), turn.target.environment.CLAUDE_CONFIG_DIR ?? join(turn.target.home, '.claude'), turn.target.environment.CODEX_HOME ?? join(turn.target.home, '.codex')] });
          turn.network = await prepareReservationNativeNetwork({ scope: turn.scope, image: host.image, directory: turn.workspace.directory, brokerUrl: turn.broker.url, onPrepared: network => { turn.network = network; } });
          turn.containerAttempted = true;
          turn.handle = await containers.prepare({ scope: turn.scope, image: host.image, mounts: turn.workspace.mounts, network: turn.network.name,
            uid: process.getuid!(), gid: process.getgid!(), deadlineMonotonicMs: input.deadlineMonotonicMs });
          turn.output = new ApiSessionClient(host.token, turn.target.session, undefined, { trackShutdownStorage: true,
            reservation: { sessionId: descriptor.sessionId, authorization: input.messageAuthorization } });
          turn.output.rpcHandlerManager.registerHandler('abort', async () => { turn.controller.abort(); await turn.broker?.close(); });
          turn.controller.signal.throwIfAborted();
          return turn.handle;
        },
        renew: async value => { turn.controller.signal.throwIfAborted(); if (!turn.handle || value.handle.launchId !== turn.handle.launchId) throw new Error('RESERVATION_CONTEXT_MISMATCH'); await containers.renew(turn.handle, value.deadlineMonotonicMs); },
        async deliver(request) {
          turn.controller.signal.throwIfAborted();
          if (!turn.output) throw new Error('RESERVATION_SCOPE_UNAVAILABLE');
          // The activated lease has already confirmed active=true in the server transaction.
          if (!turn.activity) {
            turn.output.keepAlive(true, 'remote');
            turn.activity = setInterval(() => turn.output?.keepAlive(true, 'remote'), 5000); turn.activity.unref?.();
          }
          try {
            const ack = await host.deliver(request);
            turn.deliveryAttempted = ack.ok || turn.deliveryUncertain === true;
            return ack;
          } catch (error) { turn.deliveryAttempted = turn.deliveryUncertain = true; throw error; }
        },
        async wait({ signal }) {
          if (!turn.handle || !turn.workspace || !turn.output) throw new Error('RESERVATION_SCOPE_UNAVAILABLE');
          const output = turn.output; output.keepAlive(true, 'remote');
          if (descriptor.agent === 'codex') output.sendAgentMessage('codex', { type: 'task_started', id: descriptor.runId });
          try {
          const completed = await runReservationNativeProvider(containers, turn.handle, { agent: descriptor.agent, nativeId: turn.nativeId,
            prompt: (turn as Turn & { prompt: string }).prompt, model: turn.model, effort: turn.definition.payload.effort,
            cwd: descriptor.executionDirectory, uid: process.getuid!(), gid: process.getgid!(), environmentFile: turn.workspace.envFile, mcpConfig: turn.workspace.mcpConfig, signal: AbortSignal.any([signal, turn.controller.signal]),
            output: async event => {
              if (descriptor.agent === 'claude') { output.sendClaudeSessionMessage(event.raw as any); const raw = event.raw as any; if (raw.type === 'result' && typeof raw.result === 'string') turn.answer = raw.result; }
              else if (event.text) { if (event.final) turn.answer = event.text; output.sendAgentMessage('codex', { type: 'message', message: event.text }); }
            } });
          if (descriptor.agent === 'codex') output.sendAgentMessage('codex', { type: 'task_complete', id: descriptor.runId });
          turn.outcome = completed.outcome; return completed;
          } catch (error) { turn.failed = true; output.sendAgentMessage(descriptor.agent, { type: 'turn_aborted', id: descriptor.runId }); throw error; }
          finally { output.keepAlive(false, 'remote'); }
        },
        async finish(input) {
          if (turn.activity) { clearInterval(turn.activity); turn.activity = undefined; }
          turn.output?.keepAlive(false, 'remote');
          await turn.broker?.close();
          await turn.monitor?.close();
          if (!turn.containerAttempted) {
            await turn.network?.close(); await turn.workspace?.close(); await turn.auth?.close(); turns.delete(descriptor.runId);
            return { stored: true, proof: { status: 'not-started', epoch: input.epoch, descriptorHash: input.descriptorHash, verifiedAt: Date.now() } };
          }
          const stopped = turn.exit ?? await containers.stop(turn.scope!, input.handle ?? undefined);
          turn.exit = stopped;
          if (!stopped.exited) return { stored: false, proof: null };
          if (stopped.runtime) host.recordExit(descriptor.runId, { ...stopped.runtime, status: 'exited', epoch: input.epoch, descriptorHash: input.descriptorHash, verifiedAt: Date.now() });
          // Native state is imported only after the kernel execution boundary is gone.
          if (turn.deliveryAttempted) await turn.workspace?.commit(!!turn.outcome);
          if (turn.deliveryAttempted && !turn.outcome && !turn.failed) return { stored: false, proof: null };
          const stored = turn.output ? (await (turn.recovering ? turn.output.readReservationStoredOutput(turn.target.session.seq) : turn.output.flushForShutdown(10000))).stored : !turn.outcome;
          if (!stored) return { stored: false, proof: null };
          if (turn.deliveryAttempted) await host.commitCursor(descriptor.sessionId);
          await turn.output?.close(); await turn.network?.close(); await turn.workspace?.close(); await turn.auth?.close();
          if (turn.outcome) { results.set(descriptor.runId, { finalAnswer: turn.outcome !== 'SILENT' && turn.answer ? Array.from(turn.answer).slice(0, 1500).join('') : null, silent: turn.outcome === 'SILENT' }); }
          turns.delete(descriptor.runId);
          return { stored: true, proof: stopped.runtime ? { ...stopped.runtime, status: 'exited', epoch: input.epoch, descriptorHash: input.descriptorHash, verifiedAt: Date.now() }
            : { status: 'not-started', epoch: input.epoch, descriptorHash: input.descriptorHash, verifiedAt: Date.now() } };
        },
      };
      turn.cleanup = () => dependencies.finish({ handle: turn.handle ?? null, descriptor, descriptorHash: turn.scope!.descriptorHash, epoch: turn.scope!.epoch });
      return dependencies;
    },
    cancel(sessionId) {
      const selected = [...turns.values()].filter(turn => turn.descriptor.sessionId === sessionId);
      for (const turn of selected) { turn.controller.abort(); void turn.broker?.close().catch(() => {}); }
      return selected.length > 0;
    },
    takeResult(runId) { const result = results.get(runId); results.delete(runId); return result; },
    async recover(run) {
      if (!run.epoch) return { stored: false, proof: null };
      const live = turns.get(run.runId);
      if (live?.cleanup && live.scope?.epoch === run.epoch && live.scope.descriptorHash === run.descriptorHash && live.scope.sessionId === run.sessionId) { live.recovering = true; const result = await live.cleanup(); results.delete(run.runId); return result; }
      if (run.preparation && !run.preparation.cleaned) await containers.cleanupPreparation({ owner, runId: run.runId, sessionId: run.sessionId, epoch: run.epoch, descriptorHash: run.descriptorHash, role: 'preparation' }, run.preparation.engineId);
      if (run.preparation?.directory) {
        const root = await realpath(host.directory), directory = run.preparation.directory;
        if (dirname(directory) !== root || !/^turn-[A-Za-z0-9]+$/.test(basename(directory))) throw new Error('RESERVATION_PREPARATION_CONTEXT_MISMATCH');
        await rm(directory, { recursive: true, force: true });
      }
      if (run.preparation && !run.launchIntent) return { stored: true, proof: { status: 'not-started', epoch: run.epoch, descriptorHash: run.descriptorHash, verifiedAt: Date.now() } };
      const stopped = await containers.stop({ owner, runId: run.runId, sessionId: run.sessionId, epoch: run.epoch, descriptorHash: run.descriptorHash }, run.runtime);
      // Unknown output/native-state durability stays SETTLING; absence is never synthesized.
      return { stored: false, proof: stopped.exited && stopped.runtime ? { ...stopped.runtime, status: 'exited', epoch: run.epoch, descriptorHash: run.descriptorHash, verifiedAt: Date.now() } : null };
    },
  };
}
