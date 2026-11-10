import { describe, expect, it } from 'vitest';
import { buildClaudeSystemPromptOptions } from '@/claude/claudePrompt';
import { buildCodexDeveloperInstructions } from '@/codex/codexPrompt';
import { buildGeminiTurnPrompt } from '@/gemini/geminiPrompt';
import { AGENT_ORCHESTRATION_SYSTEM_PROMPT } from './agentOrchestrationPrompt';
import packageJson from '../../package.json';

const BUNDLED_SAYCODE_CLI_VERSION: string = packageJson.dependencies['@buzzni/saycode-cli'];

const routingScenarios = [
  ['이 작업을 자식 에이전트에게 맡겨줘', 'happy agent spawn --prompt <text>'],
  ['이 대화를 새 Codex 대화로 이어가줘', 'happy agent spawn --handoff'],
  ['끝난 자식에게 테스트도 해달라고 추가 지시해줘', 'happy agent prompt <id> <text>'],
  ['응답 중인 자식에게 범위를 줄이라고 방향을 바꿔줘', 'happy agent steer <id> <text>'],
  ['지금 응답 중인 자식을 멈춰줘', 'happy agent stop <id>'],
  ['자식 진행 상황을 알려줘', 'happy agent wait <id> --until <state>'],
  ['두 reviewer 중 하나에게 보내줘', 'matches more than one child, ask the user which one'],
  ['이 사소한 오타를 고쳐줘', 'Do not create or stop children for ordinary or trivial work'],
] as const;

describe('natural-language child orchestration routing eval (T14)', () => {
  it.each(routingScenarios)('%s -> %s', (_request, expectedPlan) => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain(expectedPlan);
  });

  it('lets a human-started hub prompt verified own siblings, and only a Claude or Codex hub steer or abort them', () => {
    // saycode-cli 0.9.10 opens own-sibling steer and turn-abort stop to a depth 0 broker hub.
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('from a human-started hub you may also prompt a sibling that `happy agent ls` marks `own-sibling`');
    // The CLI opens sibling steer/stop only on the broker path (Claude, Codex); Gemini, opencode and grok hubs share this prompt.
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('from a human-started Claude or Codex hub you may also steer or stop it');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('its stop only aborts the live turn');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).not.toContain('Steer and stop are only for your proven descendants');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain("name the target conversation's title and full id to the user");
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Never control your parent, other people\'s sessions, or sessions whose ownership is unproven');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).not.toContain('Do not control siblings');
  });

  it('advertises sibling steer and stop only with a bundled saycode-cli that enforces them', () => {
    const [major, minor, patch] = BUNDLED_SAYCODE_CLI_VERSION.split('.').map(Number);
    const atLeast0910 = major > 0 || minor > 9 || (minor === 9 && patch >= 10);
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT.includes('you may also steer or stop it')).toBe(atLeast0910);
  });

  // aplus-dev-studio specs/cross-machine-agent-delegation R15 — gated on whoami, never a local fallback, one hop.
  it('offers another work PC only when whoami lists delegation targets', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Only when whoami lists `delegation.targets`');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('`happy agent spawn --machine <target> --project <path-on-that-pc> --prompt <text>`');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('never create the child on this PC instead');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('A session started by delegation never uses `--machine` again');
  });

  // saycode-cli agentRemoteReach: a child sealed to its own PC answers only stop; other verbs fail remote_session_sealed.
  it('tells the model a sealed remote child answers only stop and cannot be collected before reporting', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).not.toContain('then use the same wait/read/prompt/steer/stop');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('If `ls` marks the child sealed (end-to-end encrypted on that PC), only `stop` reaches it');
    // Seq observation and multi-id wait take other paths, and broker gates may refuse first, so the reason is not guaranteed.
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('`read`/`prompt`/`steer`/`wait` cannot reach it (usually remote_session_sealed)');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('tell the user to open it in Desktop');
    // A remote child that is not sealed keeps every verb.
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('then control it with the usual verbs');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain(
      'to collect the result before reporting completion (not possible for a sealed remote child — see delegation)',
    );
  });

  // aplus-dev-studio specs/cross-machine-agent-delegation R17–R20 (A8) — own conversations on a linked PC: read and prompt only.
  // The line arrives with the saycode-cli that lists and relays them (0.9.17); the bump that bundles it must add it.
  it('lets the model read and prompt the user\'s own conversations on a linked PC only with a bundled saycode-cli that relays them', () => {
    const [major, minor, patch] = BUNDLED_SAYCODE_CLI_VERSION.split('.').map(Number);
    const atLeast0917 = major > 0 || minor > 9 || (minor === 9 && patch >= 17);
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT.includes('`reach: "owned-remote"`')).toBe(atLeast0917);
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT.includes('you may `read`, `wait` and `prompt` it, but never `steer` or `stop` it')).toBe(atLeast0917);
    // Seq observation reads committed server history, which a relayed session cannot offer (Desktop R19).
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT.includes('use plain `wait`/`read` for it, not `--after-seq`')).toBe(atLeast0917);
  });

  it('routes an explicitly durable child away from provider-native subagents', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('visible, reopenable, or controllable later');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('MUST use `happy agent`');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Do not use provider-native `Task`, `Agent`, or `spawn_agent`');
  });

  it('does not equate an internal native worker with a Saycode child session', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('one-turn internal decomposition');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('never describe it as a Saycode child session');
  });

  it('uses command JSON rather than model inference as success evidence', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain("Treat the command's JSON result as the only success evidence");
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Never claim that the child is visible in Desktop');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Do not substitute a provider-native subagent');
  });

  it('preserves explicit agent, canonical model, and effort through spawn and result collection', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain(
      'happy agent spawn --prompt <text> --agent <agent> --model <canonical-model-id> --effort <level>',
    );
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Do not shorten or alias the model id');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('happy agent wait <returned-session-id>');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('happy agent read <returned-session-id>');
    const whoami = AGENT_ORCHESTRATION_SYSTEM_PROMPT.indexOf('happy agent whoami');
    const spawn = AGENT_ORCHESTRATION_SYSTEM_PROMPT.indexOf(
      'happy agent spawn --prompt <text> --agent <agent> --model <canonical-model-id> --effort <level>',
    );
    const wait = AGENT_ORCHESTRATION_SYSTEM_PROMPT.indexOf('happy agent wait <returned-session-id>');
    expect(whoami).toBeLessThan(spawn);
    expect(spawn).toBeLessThan(wait);
  });

  it('never invents omitted spawn selections and requires a discoverable model catalog', () => {
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('include only the corresponding flags');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('Never invent an omitted agent, model, or effort');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('spawnModelOptions');
    expect(AGENT_ORCHESTRATION_SYSTEM_PROMPT).toContain('missing from `whoami`');
  });
});

describe.each([
  {
    provider: 'Claude',
    compose: (enabled: boolean, agentOrchestration?: boolean) => buildClaudeSystemPromptOptions({
      saycodeSystemPrompt: '',
      agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
      saycodeSystemPromptEnabled: enabled,
      saycodePromptBlocks: agentOrchestration === undefined ? undefined : { agentOrchestration },
    }).appendSystemPrompt,
  },
  {
    provider: 'Codex',
    compose: (enabled: boolean, agentOrchestration?: boolean) => buildCodexDeveloperInstructions({
      agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
      mode: {
        saycodeSystemPromptEnabled: enabled,
        saycodePromptBlocks: agentOrchestration === undefined ? undefined : { agentOrchestration },
      },
    }),
  },
  {
    provider: 'Gemini',
    compose: (enabled: boolean, agentOrchestration?: boolean) => buildGeminiTurnPrompt({
      userText: 'USER',
      agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
      saycodeSystemPromptEnabled: enabled,
      saycodePromptBlocks: agentOrchestration === undefined ? undefined : { agentOrchestration },
      isNewSession: true,
      hasTitle: true,
    }),
  },
])('$provider orchestration prompt lifecycle (T13, T15)', ({ compose }) => {
  it('injects the common block independently from the master setting', () => {
    expect(compose(true)).toContain('happy agent whoami');
    expect(compose(false)).toContain('happy agent whoami');
  });

  it('removes the common block only after its explicit block toggle is off', () => {
    expect(compose(true, false) ?? '').not.toContain('happy agent');
    expect(compose(false, false) ?? '').not.toContain('happy agent');
  });

  it.each([
    'facade or embedded command is missing',
    'not_agent_env',
    'spawn_limit_exceeded',
    'spawn_depth_exceeded',
    'unsupported/old verb',
  ])('keeps capability failure honest: %s', (signal) => {
    const prompt = compose(true);
    expect(prompt).toContain(signal);
    expect(prompt).toContain('Do not install another CLI');
    expect(prompt).toContain('claim an action succeeded when it did not run');
  });
});
