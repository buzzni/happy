import { describe, expect, it } from 'vitest';

import { ConversationHistory } from './conversationHistory';

describe('ConversationHistory restart context', () => {
  it('excludes every unanswered trailing user message from a restarted session context', () => {
    const history = new ConversationHistory();
    history.addUserMessage('completed question');
    history.addAssistantMessage('completed answer');
    history.addUserMessage('first queued turn');
    history.addUserMessage('second queued turn');

    const context = history.getContextForNewSession({ excludeTrailingUserMessages: true });

    expect(context).toContain('completed question');
    expect(context).toContain('completed answer');
    expect(context).not.toContain('first queued turn');
    expect(context).not.toContain('second queued turn');
  });

  it('returns no context when only the current unanswered turn exists', () => {
    const history = new ConversationHistory();
    history.addUserMessage('current turn');

    expect(history.getContextForNewSession({ excludeTrailingUserMessages: true })).toBe('');
  });
});
