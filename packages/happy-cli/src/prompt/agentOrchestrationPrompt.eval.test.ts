import { describe, expect, it } from 'vitest';
import { buildClaudeSystemPromptOptions } from '@/claude/claudePrompt';
import { buildCodexDeveloperInstructions } from '@/codex/codexPrompt';
import { buildGeminiTurnPrompt } from '@/gemini/geminiPrompt';
import { AGENT_ORCHESTRATION_SYSTEM_PROMPT } from './agentOrchestrationPrompt';

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
