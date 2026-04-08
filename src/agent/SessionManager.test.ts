import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message } from '../models/ModelClient.js';
import { testConfig as config } from '../test/fixtures.js';
import { EventQueue } from './EventQueue.js';
import type { IRolloutRecorder, RolloutEntry } from './RolloutRecorder.js';
import { SessionManager } from './SessionManager.js';
import type { AgentEvent, TurnSubmission, TurnExecutionResult } from './types.js';

class FakeTurnExecutor {
  readonly runs: Array<{ submission: TurnSubmission; promptHistory: Message[] }> = [];

  async *run(submission: TurnSubmission): AsyncGenerator<AgentEvent, TurnExecutionResult> {
    const promptHistory = submission.promptHistory ?? [];
    this.runs.push({ submission, promptHistory });
    const finalText = `answer:${submission.userMessage}`;
    yield { type: 'text_delta', content: finalText };
    yield { type: 'done' };
    return {
      finalText,
      completedTurns: 1,
      toolCallCount: 0,
      promptMessages: [
        { role: 'user', content: submission.userMessage },
        { role: 'assistant', content: finalText },
      ],
    };
  }
}

class MemoryRolloutRecorder implements IRolloutRecorder {
  readonly entries: RolloutEntry[] = [];

  async record(entry: RolloutEntry) {
    this.entries.push(entry);
  }
}

test('SessionManager reuses prompt history from the live session when platform history is empty', async () => {
  const turnExecutor = new FakeTurnExecutor();
  const rolloutRecorder = new MemoryRolloutRecorder();
  const manager = new SessionManager(config, {
    turnExecutor,
    rolloutRecorder,
  });
  const events = new EventQueue<AgentEvent>();

  const first: TurnSubmission = {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
  };
  await manager.execute(first, events);

  const second: TurnSubmission = {
    requestId: 'req-2',
    conversationId: 'conv-1',
    userMessage: 'make it shorter',
    history: [],
  };
  await manager.execute(second, events);

  assert.deepEqual(turnExecutor.runs[1]?.promptHistory, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer:hello' },
  ]);
  assert.equal(rolloutRecorder.entries.length >= 2, true);
});

test('SessionManager reseeds warm session prompt history when platform canonical history changes', async () => {
  const turnExecutor = new FakeTurnExecutor();
  const rolloutRecorder = new MemoryRolloutRecorder();
  const manager = new SessionManager(config, {
    turnExecutor,
    rolloutRecorder,
  });
  const events = new EventQueue<AgentEvent>();

  const first: TurnSubmission = {
    requestId: 'req-3',
    conversationId: 'conv-2',
    userMessage: 'hello',
    history: [],
  };
  await manager.execute(first, events);

  const second: TurnSubmission = {
    requestId: 'req-4',
    conversationId: 'conv-2',
    userMessage: 'what about the newer context',
    history: [
      { role: 'user', content: 'seeded by platform' },
      { role: 'assistant', content: 'platform reply' },
    ],
  };
  await manager.execute(second, events);

  assert.deepEqual(turnExecutor.runs[1]?.promptHistory, [
    { role: 'user', content: 'seeded by platform' },
    { role: 'assistant', content: 'platform reply' },
  ]);
  assert.equal(
    rolloutRecorder.entries.some((entry) => entry.type === 'session_reseeded'),
    true,
  );
});
