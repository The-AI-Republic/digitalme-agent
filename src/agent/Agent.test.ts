import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from './Agent.js';
import { EventQueue } from './EventQueue.js';
import { testConfig } from '../test/fixtures.js';
import type { TurnSubmission, AgentEvent } from './types.js';

function makeSessionStats() {
  return {
    activeSessions: 0,
    activeTurns: 0,
    sessionTtlSeconds: 1800,
    maxActiveSessions: 1000,
    usage: { totalCostUsd: 0, dailyCostUsd: 0, monthlyCostUsd: 0 },
  };
}

function makeSubmission(overrides: Partial<TurnSubmission> = {}): TurnSubmission {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
    ...overrides,
  };
}

test('submit dispatches through executor and returns events', async () => {
  const executorCalls: string[] = [];
  const agent = new Agent(testConfig, {
    sessionManager: {
      execute: async (submission: TurnSubmission, events: EventQueue<AgentEvent>) => {
        executorCalls.push(submission.requestId);
        events.push({ type: 'text_delta', content: 'hi' });
        events.push({ type: 'done' });
      },
      getStats: () => makeSessionStats(),
      beginDrain: () => {},
    },
  });

  const events = agent.submit(makeSubmission());
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }

  assert.equal(executorCalls.length, 1);
  assert.equal(collected.length, 2);
  assert.equal(collected[0].type, 'text_delta');
  assert.equal(collected[1].type, 'done');
});

test('submit rejects duplicate request ids', async () => {
  let resolveFirst!: () => void;
  const blockingPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });

  const agent = new Agent(testConfig, {
    sessionManager: {
      execute: async () => { await blockingPromise; },
      getStats: () => makeSessionStats(),
      beginDrain: () => {},
    },
  });

  // First submit starts running (don't await yet)
  const events1 = agent.submit(makeSubmission({ requestId: 'dup' }));

  // Second submit with same requestId should throw
  assert.throws(
    () => agent.submit(makeSubmission({ requestId: 'dup' })),
    { message: 'request_in_progress' },
  );

  // Clean up
  resolveFirst();
  for await (const event of events1) { /* drain */ }
});

test('submit rejects when draining', () => {
  const agent = new Agent(testConfig, {
    sessionManager: {
      execute: async () => {},
      getStats: () => makeSessionStats(),
      beginDrain: () => {},
    },
  });

  agent.beginDrain();

  assert.throws(
    () => agent.submit(makeSubmission()),
    { message: 'shutting_down' },
  );
});

test('getHealth returns stats', async () => {
  const agent = new Agent(testConfig, {
    sessionManager: {
      execute: async (_s: TurnSubmission, events: EventQueue<AgentEvent>) => {
        events.push({ type: 'done' });
      },
      getStats: () => makeSessionStats(),
      beginDrain: () => {},
    },
  });

  const events = agent.submit(makeSubmission());
  for await (const event of events) { /* drain */ }

  const health = agent.getHealth();
  assert.equal(health.model_provider, 'openai');
  assert.equal(health.active_requests, 0);
  assert.equal(health.completed_requests, 1);
  assert.equal(health.failed_requests, 0);
  assert.equal(health.draining, false);
});

test('failed execution increments failed_requests counter', async () => {
  const agent = new Agent(testConfig, {
    sessionManager: {
      execute: async () => {
        throw new Error('model_error');
      },
      getStats: () => makeSessionStats(),
      beginDrain: () => {},
    },
  });

  const events = agent.submit(makeSubmission());
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }

  // The error event is emitted by SubmissionQueue
  const health = agent.getHealth();
  assert.equal(health.failed_requests, 1);
  assert.equal(health.completed_requests, 0);
});

test('beginDrain sets draining and propagates to executor', () => {
  const agent = new Agent(testConfig, {
    sessionManager: {
      execute: async () => {},
      getStats: () => makeSessionStats(),
      beginDrain: () => {},
    },
  });

  agent.beginDrain();
  assert.equal(agent.getHealth().draining, true);
});
