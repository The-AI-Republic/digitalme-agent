import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from './Agent.js';
import { AgentRequestError } from './errors.js';
import type { AgentEvent, TurnSubmission } from './types.js';
import type { EventQueue } from './EventQueue.js';
import { testConfig as config } from '../test/fixtures.js';

function createMockSessionManager() {
  const calls: string[] = [];
  return {
    mock: {
      async execute(_submission: TurnSubmission, events: EventQueue<AgentEvent>) {
        events.push({ type: 'done' });
      },
      getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
      beginDrain() { calls.push('beginDrain'); },
    },
    calls,
  };
}

function submission(id: string, convId = 'conv-1'): TurnSubmission {
  return { requestId: id, conversationId: convId, userMessage: 'hi', history: [] };
}

async function drain(events: EventQueue<AgentEvent>) {
  for await (const _ of events) { /* consume */ }
}

test('Agent getHealth reflects store state: activeRequestCount and draining', async () => {
  const { mock } = createMockSessionManager();
  const agent = new Agent(config, { sessionManager: mock });

  const health1 = agent.getHealth();
  assert.equal(health1.active_requests, 0);
  assert.equal(health1.draining, false);

  // Submit a request — activeRequestCount should increase
  const events = agent.submit(submission('req-1'));
  const health2 = agent.getHealth();
  assert.equal(health2.active_requests, 1);

  await drain(events);
  const health3 = agent.getHealth();
  assert.equal(health3.active_requests, 0);
  assert.equal(health3.completed_requests, 1);
});

test('Agent beginDrain sets draining in store, calls sessionManager.beginDrain', () => {
  const { mock, calls } = createMockSessionManager();
  const agent = new Agent(config, { sessionManager: mock });

  agent.beginDrain();

  assert.equal(agent.getHealth().draining, true);
  assert.deepEqual(calls, ['beginDrain']);
});

test('Agent submit rejects after beginDrain', () => {
  const { mock } = createMockSessionManager();
  const agent = new Agent(config, { sessionManager: mock });

  agent.beginDrain();

  assert.throws(
    () => agent.submit(submission('req-1')),
    (err: unknown) => err instanceof AgentRequestError && err.message === 'shutting_down',
  );
});

test('Agent submit rejects duplicate request IDs', async () => {
  let resolve: (() => void) | undefined;
  const blockingMock = {
    async execute(_submission: TurnSubmission, events: EventQueue<AgentEvent>) {
      await new Promise<void>(r => { resolve = r; });
      events.push({ type: 'done' });
    },
    getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
    beginDrain() {},
  };

  const agent = new Agent(config, { sessionManager: blockingMock });
  const events = agent.submit(submission('req-dup'));

  assert.throws(
    () => agent.submit(submission('req-dup')),
    (err: unknown) => err instanceof AgentRequestError && err.message === 'request_in_progress',
  );

  resolve?.();
  await drain(events);
});

test('store not incremented if queue.submit throws', () => {
  // Use a config with max_concurrent=0 to force queue_full
  const tightConfig = { ...config, limits: { ...config.limits, max_concurrent: 0 } };
  const { mock } = createMockSessionManager();
  const agent = new Agent(tightConfig, { sessionManager: mock });

  assert.throws(
    () => agent.submit(submission('req-1')),
    (err: unknown) => err instanceof AgentRequestError && err.message === 'queue_full',
  );

  // Store should still show 0 active requests
  assert.equal(agent.getHealth().active_requests, 0);
});

test('failed request increments failedRequests counter', async () => {
  const failingMock = {
    async execute() {
      throw new Error('boom');
    },
    getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
    beginDrain() {},
  };

  const agent = new Agent(config, { sessionManager: failingMock });
  const events = agent.submit(submission('req-fail'));
  await drain(events);

  const health = agent.getHealth();
  assert.equal(health.failed_requests, 1);
  assert.equal(health.completed_requests, 0);
  assert.equal(health.active_requests, 0);
});

test('draining flag exists only in store — queue and sessionManager have no local flag', () => {
  const { mock } = createMockSessionManager();
  const agent = new Agent(config, { sessionManager: mock });

  // Before drain
  assert.equal(agent.getHealth().draining, false);

  agent.beginDrain();

  // After drain — the single source of truth
  assert.equal(agent.getHealth().draining, true);
});

test('RuntimeListeners receive notifications on state changes', async () => {
  const requestCountChanges: Array<[number, number]> = [];
  const drainingChanges: boolean[] = [];

  const { mock } = createMockSessionManager();
  const agent = new Agent(config, {
    sessionManager: mock,
    runtimeListeners: {
      onActiveRequestCountChanged: (oldCount, newCount) => {
        requestCountChanges.push([oldCount, newCount]);
      },
      onDrainingChanged: (draining) => {
        drainingChanges.push(draining);
      },
    },
  });

  const events = agent.submit(submission('req-1'));
  assert.deepEqual(requestCountChanges, [[0, 1]]);

  await drain(events);
  assert.deepEqual(requestCountChanges, [[0, 1], [1, 0]]);

  agent.beginDrain();
  assert.deepEqual(drainingChanges, [true]);
});
