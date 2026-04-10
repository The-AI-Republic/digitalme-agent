import assert from 'node:assert/strict';
import test from 'node:test';

import { generateId, type Message } from '../models/ModelClient.js';
import { testConfig as config } from '../test/fixtures.js';
import { EventQueue } from './EventQueue.js';
import type { ITranscriptRecorder } from './transcript/types.js';
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
      newMessages: [
        { role: 'user', content: submission.userMessage, id: generateId() },
        { role: 'assistant', content: finalText, id: generateId() },
      ],
    };
  }
}

class MemoryTranscriptRecorder implements ITranscriptRecorder {
  readonly entries: import('./transcript/types.js').TranscriptEntry[] = [];

  async recordMessage() {}

  async recordLifecycleEvent(entry: import('./transcript/types.js').TranscriptEntry) {
    this.entries.push(entry);
  }

  async insertMessageChain() {}

  async loadTranscript() {
    return { messages: [] as Message[], leafId: null };
  }

  seedParentId() {}
}

test('SessionManager reuses prompt history from the live session when platform history is empty', async () => {
  const turnExecutor = new FakeTurnExecutor();
  const transcriptRecorder = new MemoryTranscriptRecorder();
  const manager = new SessionManager(config, {
    turnExecutor,
    transcriptRecorder,
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

  const history = turnExecutor.runs[1]?.promptHistory;
  assert.equal(history?.length, 2);
  assert.equal(history?.[0]?.role, 'user');
  assert.equal(history?.[0]?.content, 'hello');
  assert.equal(history?.[1]?.role, 'assistant');
  assert.equal(history?.[1]?.content, 'answer:hello');
  assert.equal(transcriptRecorder.entries.length >= 2, true);
});

test('SessionManager reseeds warm session prompt history when platform canonical history changes', async () => {
  const turnExecutor = new FakeTurnExecutor();
  const transcriptRecorder = new MemoryTranscriptRecorder();
  const manager = new SessionManager(config, {
    turnExecutor,
    transcriptRecorder,
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

  const reseeded = turnExecutor.runs[1]?.promptHistory;
  assert.equal(reseeded?.length, 2);
  assert.equal(reseeded?.[0]?.role, 'user');
  assert.equal(reseeded?.[0]?.content, 'seeded by platform');
  assert.equal(reseeded?.[1]?.role, 'assistant');
  assert.equal(reseeded?.[1]?.content, 'platform reply');
  // Reseeded messages should have generated id and timestamp
  assert.ok(reseeded?.[0]?.id, 'reseeded message should have an id');
  assert.ok(reseeded?.[0]?.timestamp, 'reseeded message should have a timestamp');
  assert.equal(
    transcriptRecorder.entries.some((entry) => entry.type === 'session_reseeded'),
    true,
  );
});

test('SessionManager wires the transcript recorder into the default TurnExecutor', () => {
  const transcriptRecorder = new MemoryTranscriptRecorder();
  const manager = new SessionManager(config, { transcriptRecorder });

  const turnExecutor = (manager as unknown as {
    turnExecutor: { transcriptRecorder?: ITranscriptRecorder };
  }).turnExecutor;

  assert.equal(turnExecutor.transcriptRecorder, transcriptRecorder);
});
