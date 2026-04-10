import test from 'node:test';
import assert from 'node:assert/strict';

import { SubmissionQueue } from './SubmissionQueue.js';
import type { AgentEvent, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';
import { testConfig as config } from '../test/fixtures.js';
import { initialProcessRuntimeState } from './ProcessRuntimeState.js';

const getState = () => initialProcessRuntimeState();

async function collectEvents(queue: EventQueue<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

test('SubmissionQueue serializes submissions within one conversation', async () => {
  const queue = new SubmissionQueue(config, getState);
  const executionOrder: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });

  const run = (submission: TurnSubmission) => async (events: EventQueue<AgentEvent>) => {
    executionOrder.push(`start:${submission.requestId}`);
    if (submission.requestId === 'req-1') {
      firstStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    executionOrder.push(`end:${submission.requestId}`);
    events.push({ type: 'done' });
  };

  const submission1: TurnSubmission = {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'first',
    history: [],
  };
  const submission2: TurnSubmission = {
    requestId: 'req-2',
    conversationId: 'conv-1',
    userMessage: 'second',
    history: [],
  };

  const events1 = queue.submit(submission1, run(submission1));
  const events2 = queue.submit(submission2, run(submission2));

  await firstStartedPromise;
  assert.deepEqual(executionOrder, ['start:req-1']);

  releaseFirst?.();

  await Promise.all([collectEvents(events1), collectEvents(events2)]);
  assert.deepEqual(executionOrder, ['start:req-1', 'end:req-1', 'start:req-2', 'end:req-2']);
});

test('SubmissionQueue allows different conversations to run concurrently', async () => {
  const queue = new SubmissionQueue(config, getState);
  const started: string[] = [];

  const run = (submission: TurnSubmission) => async (events: EventQueue<AgentEvent>) => {
    started.push(submission.requestId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push({ type: 'done' });
  };

  const events1 = queue.submit({
    requestId: 'req-a',
    conversationId: 'conv-a',
    userMessage: 'A',
    history: [],
  }, run({
    requestId: 'req-a',
    conversationId: 'conv-a',
    userMessage: 'A',
    history: [],
  }));

  const events2 = queue.submit({
    requestId: 'req-b',
    conversationId: 'conv-b',
    userMessage: 'B',
    history: [],
  }, run({
    requestId: 'req-b',
    conversationId: 'conv-b',
    userMessage: 'B',
    history: [],
  }));

  await Promise.all([collectEvents(events1), collectEvents(events2)]);
  assert.deepEqual(started.sort(), ['req-a', 'req-b']);
});
