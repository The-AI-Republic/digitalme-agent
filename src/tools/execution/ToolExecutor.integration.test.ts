import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { ToolExecutor, type ToolExecutorCallbacks } from './ToolExecutor.js';
import { DefaultToolPolicyChecker, type IToolPolicyChecker } from './ToolPolicyChecker.js';
import { ResultBudget } from './ResultBudget.js';
import type { Tool, ToolContext, ToolExecutionResult, ToolMetadata } from '../types.js';
import type { IToolRegistry } from '../registry.js';
import type { ToolCall } from '../../models/ModelClient.js';

// --- Helpers ---

function makeTool(name: string, opts: {
  concurrencySafe?: boolean;
  delayMs?: number;
  resultText?: string;
  maxResultChars?: number;
} = {}): Tool {
  return {
    name,
    definition: { type: 'function', function: { name, description: 'test', parameters: {} } },
    metadata: {
      timeoutMs: 10_000,
      maxResultChars: opts.maxResultChars ?? 20_000,
      policyCategory: 'search',
    },
    inputSchema: z.object({ query: z.string().optional() }),
    ...(opts.concurrencySafe !== undefined
      ? { isConcurrencySafe: () => opts.concurrencySafe! }
      : {}),
    async execute(args, ctx) {
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.delayMs);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      const text = opts.resultText ?? `result-from-${name}`;
      return { success: true, data: { name }, renderForModel: () => text };
    },
  };
}

function makeRegistry(tools: Tool[]): IToolRegistry {
  const map = new Map(tools.map(t => [t.name, t]));
  return {
    listDefinitions: () => tools.map(t => t.definition),
    listNames: () => tools.map(t => t.name),
    get: (name) => map.get(name),
  };
}

function makeCall(name: string, id: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function makeContext(signal?: AbortSignal): ToolContext {
  return {
    conversationId: 'conv-1',
    signal: signal ?? new AbortController().signal,
    policyConfig: {},
  };
}

// --- Integration tests ---

test('integration: full turn with one tool call produces correct record', async () => {
  const tool = makeTool('search');
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const events: string[] = [];
  const callbacks: ToolExecutorCallbacks = {
    onToolStart: (name, callId) => events.push(`start:${name}:${callId}`),
    onToolEnd: (name, callId) => events.push(`end:${name}:${callId}`),
  };

  const records = await executor.runTools(
    [makeCall('search', 'c1', { query: 'test' })],
    makeContext(), new ResultBudget(), callbacks,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]!.toolName, 'search');
  assert.equal(records[0]!.modelContent, 'result-from-search');
  assert.equal(records[0]!.result.success, true);
  assert.deepEqual(events, ['start:search:c1', 'end:search:c1']);
});

test('integration: tool result content equals record.modelContent', async () => {
  const tool = makeTool('search', { resultText: 'custom-rendered-output' });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('search', 'c1')],
    makeContext(), new ResultBudget(), { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.equal(records[0]!.modelContent, 'custom-rendered-output');
});

test('integration: result budget is fresh per request (separate instances)', async () => {
  const tool = makeTool('search', { resultText: 'x'.repeat(500) });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());

  // First run with tight budget
  const budget1 = new ResultBudget(100);
  const records1 = await executor.runTools(
    [makeCall('search', 'c1')],
    makeContext(), budget1, { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.ok(records1[0]!.modelContent.length <= 100);

  // Second run with fresh budget — should not be affected by first
  const budget2 = new ResultBudget(100);
  const records2 = await executor.runTools(
    [makeCall('search', 'c2')],
    makeContext(), budget2, { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.ok(records2[0]!.modelContent.length <= 100);
});

test('integration: two concurrent-safe tools complete faster than serial sum', async () => {
  const tool = makeTool('slow', { concurrencySafe: true, delayMs: 50 });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());

  const start = Date.now();
  const records = await executor.runTools(
    [makeCall('slow', 'c1'), makeCall('slow', 'c2')],
    makeContext(), new ResultBudget(), { onToolStart: () => {}, onToolEnd: () => {} },
  );
  const elapsed = Date.now() - start;

  assert.equal(records.length, 2);
  assert.ok(elapsed < 120, `Expected parallel (~50ms), got ${elapsed}ms`);
});

test('integration: concurrent result array preserves call order', async () => {
  let idx = 0;
  const tool: Tool = {
    name: 'ordered',
    definition: { type: 'function', function: { name: 'ordered', description: 'test', parameters: {} } },
    metadata: { timeoutMs: 10_000, maxResultChars: 20_000, policyCategory: 'search' },
    inputSchema: z.object({ query: z.string().optional() }),
    isConcurrencySafe: () => true,
    async execute(_args, ctx) {
      const myIdx = idx++;
      await new Promise(r => setTimeout(r, myIdx === 0 ? 60 : 10));
      return { success: true, data: { idx: myIdx }, renderForModel: () => `result-${myIdx}` };
    },
  };
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('ordered', 'first'), makeCall('ordered', 'second')],
    makeContext(), new ResultBudget(), { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.equal(records[0]!.callId, 'first');
  assert.equal(records[1]!.callId, 'second');
});

test('integration: concurrent real-time events reflect completion order', async () => {
  let idx = 0;
  const tool: Tool = {
    name: 'timed',
    definition: { type: 'function', function: { name: 'timed', description: 'test', parameters: {} } },
    metadata: { timeoutMs: 10_000, maxResultChars: 20_000, policyCategory: 'search' },
    inputSchema: z.object({ query: z.string().optional() }),
    isConcurrencySafe: () => true,
    async execute(_args, ctx) {
      const myIdx = idx++;
      await new Promise(r => setTimeout(r, myIdx === 0 ? 80 : 10));
      return { success: true, data: {}, renderForModel: () => `ok-${myIdx}` };
    },
  };
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const endEvents: string[] = [];
  const records = await executor.runTools(
    [makeCall('timed', 'slow'), makeCall('timed', 'fast')],
    makeContext(), new ResultBudget(),
    { onToolStart: () => {}, onToolEnd: (_, callId) => endEvents.push(callId) },
  );
  // Fast tool should finish first in real-time
  assert.equal(endEvents[0], 'fast');
  assert.equal(endEvents[1], 'slow');
  // But records are in call order
  assert.equal(records[0]!.callId, 'slow');
  assert.equal(records[1]!.callId, 'fast');
});

test('integration: policy-rejected call produces error record with no execution', async () => {
  let executed = false;
  const tool = makeTool('guarded');
  (tool as any).execute = async () => {
    executed = true;
    return { success: true, data: {}, renderForModel: () => 'ok' };
  };
  const policyChecker: IToolPolicyChecker = {
    checkPolicy: () => ({ allowed: false, reason: 'rate limited' }),
  };
  const executor = new ToolExecutor(makeRegistry([tool]), policyChecker);
  const records = await executor.runTools(
    [makeCall('guarded', 'c1')],
    makeContext(), new ResultBudget(), { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.equal(executed, false);
  assert.equal(records[0]!.result.errorCategory, 'policy_rejected');
});

test('integration: aggregate budget bounds multi-tool prompt content', async () => {
  const tool = makeTool('big', { concurrencySafe: true, resultText: 'x'.repeat(500) });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const budget = new ResultBudget(300);
  const records = await executor.runTools(
    [makeCall('big', 'c1'), makeCall('big', 'c2'), makeCall('big', 'c3')],
    makeContext(), budget,
    { onToolStart: () => {}, onToolEnd: () => {} },
  );
  const total = records.reduce((sum, r) => sum + r.modelContent.length, 0);
  assert.ok(total <= 300, `Expected total <= 300, got ${total}`);
});

test('integration: mixed batch sequence (safe, safe, unsafe, safe)', async () => {
  const executionOrder: string[] = [];
  const safe = makeTool('safe');
  (safe as any).isConcurrencySafe = () => true;
  (safe as any).execute = async () => {
    executionOrder.push('safe');
    return { success: true, data: {}, renderForModel: () => 'ok' };
  };
  const unsafe = makeTool('unsafe');
  (unsafe as any).isConcurrencySafe = () => false;
  (unsafe as any).execute = async () => {
    executionOrder.push('unsafe');
    return { success: true, data: {}, renderForModel: () => 'ok' };
  };
  const registry = makeRegistry([safe, unsafe]);
  const executor = new ToolExecutor(registry, new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [
      makeCall('safe', 'c1'),
      makeCall('safe', 'c2'),
      makeCall('unsafe', 'c3'),
      makeCall('safe', 'c4'),
    ],
    makeContext(), new ResultBudget(), { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.equal(records.length, 4);
  assert.equal(executionOrder.length, 4);
  // All should execute
  assert.equal(executionOrder.filter(e => e === 'safe').length, 3);
  assert.equal(executionOrder.filter(e => e === 'unsafe').length, 1);
});

test('integration: abort during a turn stops in-flight tool', async () => {
  const controller = new AbortController();
  const tool = makeTool('blocking', { delayMs: 5000 });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());

  setTimeout(() => controller.abort(), 30);

  const records = await executor.runTools(
    [makeCall('blocking', 'c1')],
    makeContext(controller.signal), new ResultBudget(),
    { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.equal(records[0]!.result.errorCategory, 'aborted');
});

test('integration: no-tool calls returns empty records', async () => {
  const executor = new ToolExecutor(makeRegistry([]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [], makeContext(), new ResultBudget(),
    { onToolStart: () => {}, onToolEnd: () => {} },
  );
  assert.equal(records.length, 0);
});
