import test from 'node:test';
import assert from 'node:assert/strict';

import { PostTurnHookRegistry } from './PostTurnHooks.js';
import type { PostTurnHookContext } from './PostTurnHooks.js';

function makeFakeContext(): PostTurnHookContext {
  return {
    sessionState: {} as PostTurnHookContext['sessionState'],
    sessionRuntime: { registerForkedAgent() {} },
    forkSemaphore: {} as PostTurnHookContext['forkSemaphore'],
    turnExecutor: {} as PostTurnHookContext['turnExecutor'],
    conversationId: 'conv-test',
    lastResult: {
      finalText: 'done',
      completedTurns: 1,
      toolCallCount: 0,
      promptMessages: [],
    },
  };
}

test('PostTurnHookRegistry runs hooks after registration', async () => {
  const registry = new PostTurnHookRegistry();
  let called = false;

  registry.register(async () => { called = true; });
  await registry.runAll(makeFakeContext());

  assert.equal(called, true);
});

test('PostTurnHookRegistry runs hooks sequentially', async () => {
  const registry = new PostTurnHookRegistry();
  const order: number[] = [];

  registry.register(async () => { order.push(1); });
  registry.register(async () => { order.push(2); });
  registry.register(async () => { order.push(3); });
  await registry.runAll(makeFakeContext());

  assert.deepEqual(order, [1, 2, 3]);
});

test('PostTurnHookRegistry swallows hook errors', async () => {
  const registry = new PostTurnHookRegistry();
  let secondCalled = false;

  registry.register(async () => { throw new Error('hook crash'); });
  registry.register(async () => { secondCalled = true; });

  // Should not throw
  await registry.runAll(makeFakeContext());

  // Second hook still runs
  assert.equal(secondCalled, true);
});

test('PostTurnHookRegistry unregister removes hook', async () => {
  const registry = new PostTurnHookRegistry();
  let called = false;

  const hook = async () => { called = true; };
  registry.register(hook);
  registry.unregister(hook);
  await registry.runAll(makeFakeContext());

  assert.equal(called, false);
  assert.equal(registry.size, 0);
});

test('PostTurnHookRegistry enforces timeout on hooks', async () => {
  const registry = new PostTurnHookRegistry(50); // 50ms timeout
  let hookFinished = false;

  registry.register(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    hookFinished = true;
  });

  // Should not throw — timeout is caught
  await registry.runAll(makeFakeContext());

  // Hook was interrupted by timeout
  assert.equal(hookFinished, false);
});

test('PostTurnHookRegistry passes context to hooks', async () => {
  const registry = new PostTurnHookRegistry();
  let receivedConversationId: string | null = null;

  registry.register(async (ctx) => {
    receivedConversationId = ctx.conversationId;
  });

  await registry.runAll(makeFakeContext());
  assert.equal(receivedConversationId, 'conv-test');
});
