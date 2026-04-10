import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { ToolExecutor, type ToolExecutorCallbacks } from './ToolExecutor.js';
import { DefaultToolPolicyChecker, type IToolPolicyChecker } from './ToolPolicyChecker.js';
import { ResultBudget } from './ResultBudget.js';
import type { Tool, ToolContext, ToolExecutionResult, ToolMetadata, ToolDefinition } from '../types.js';
import type { IToolRegistry } from '../registry.js';
import type { ToolCall } from '../../models/ModelClient.js';
import type { ToolPolicyDecision } from './types.js';

// --- Test helpers ---

function makeTool(overrides: Partial<{
  name: string;
  timeoutMs: number;
  maxResultChars: number;
  isConcurrencySafe: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecutionResult>;
  validateInput: ((args: Record<string, unknown>, ctx: ToolContext) => string | null) | undefined;
  summarizeResult: ((args: Record<string, unknown>, result: ToolExecutionResult) => string) | undefined;
}> = {}): Tool {
  const name = overrides.name ?? 'test_tool';
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description: 'test', parameters: {} },
    },
    metadata: {
      timeoutMs: overrides.timeoutMs ?? 10_000,
      maxResultChars: overrides.maxResultChars ?? 20_000,
      policyCategory: 'search',
    },
    inputSchema: z.object({ query: z.string().optional() }),
    execute: overrides.execute ?? (async (args) => ({
      success: true,
      data: args,
      renderForModel: () => `result:${JSON.stringify(args)}`,
    })),
    ...(overrides.isConcurrencySafe !== undefined
      ? { isConcurrencySafe: () => overrides.isConcurrencySafe! }
      : {}),
    ...(overrides.validateInput ? { validateInput: overrides.validateInput } : {}),
    ...(overrides.summarizeResult ? { summarizeResult: overrides.summarizeResult } : {}),
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

function makeCall(name: string, args: Record<string, unknown> = {}, id?: string): ToolCall {
  return {
    id: id ?? `call-${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeContext(): ToolContext {
  return {
    conversationId: 'conv-1',
    signal: new AbortController().signal,
    policyConfig: {},
  };
}

function noopCallbacks(): ToolExecutorCallbacks {
  return {
    onToolStart: () => {},
    onToolEnd: () => {},
  };
}

// --- Unknown tool ---

test('ToolExecutor returns unknown_tool for missing tool', async () => {
  const executor = new ToolExecutor(makeRegistry([]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('nonexistent', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]!.result.errorCategory, 'unknown_tool');
  assert.equal(records[0]!.result.success, false);
});

// --- Invalid JSON ---

test('ToolExecutor returns validation_error for invalid JSON arguments', async () => {
  const tool = makeTool();
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const call: ToolCall = {
    id: 'c1', type: 'function',
    function: { name: 'test_tool', arguments: '{invalid json' },
  };
  const records = await executor.runTools(
    [call], makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'validation_error');
});

// --- Schema validation failure ---

test('ToolExecutor returns validation_error for schema failure', async () => {
  const tool: Tool = {
    name: 'strict_tool',
    definition: { type: 'function', function: { name: 'strict_tool', description: 'test', parameters: {} } },
    metadata: { timeoutMs: 5000, maxResultChars: 1000, policyCategory: 'search' },
    inputSchema: z.object({ count: z.number() }),
    async execute() {
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  };
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('strict_tool', { count: 'not-a-number' }, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'validation_error');
});

// --- validateInput rejection ---

test('ToolExecutor returns validation_error for validateInput rejection', async () => {
  const tool = makeTool({
    validateInput: () => 'query too short',
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', { query: 'x' }, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'validation_error');
  assert.ok(records[0]!.modelContent.includes('query too short'));
});

// --- Policy rejection ---

test('ToolExecutor returns policy_rejected when policy denies', async () => {
  const tool = makeTool();
  const policyChecker: IToolPolicyChecker = {
    checkPolicy: () => ({ allowed: false, reason: 'rate limit exceeded' }),
  };
  const executor = new ToolExecutor(makeRegistry([tool]), policyChecker);
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'policy_rejected');
});

// --- tool.execute() is never called for failures ---

test('tool.execute is not called for validation/policy failures', async () => {
  let executeCalled = false;
  const tool = makeTool({
    execute: async () => {
      executeCalled = true;
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
    validateInput: () => 'blocked',
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(executeCalled, false);
});

// --- Timeout ---

test('ToolExecutor returns timeout for slow tools', async () => {
  const tool = makeTool({
    timeoutMs: 50,
    execute: async (_args, ctx) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'timeout');
});

// --- Request abort ---

test('ToolExecutor returns aborted when request signal fires', async () => {
  const controller = new AbortController();
  const tool = makeTool({
    execute: async (_args, ctx) => {
      await new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());

  // Abort after 20ms
  setTimeout(() => controller.abort(), 20);

  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    { conversationId: 'conv-1', signal: controller.signal, policyConfig: {} },
    new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'aborted');
});

test('ToolExecutor returns aborted when request signal is already aborted', async () => {
  let executeCalled = false;
  const tool = makeTool({
    execute: async (_args, ctx) => {
      executeCalled = true;
      await new Promise((resolve, reject) => {
        if (ctx.signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        ctx.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());

  // Signal is already aborted before runTools
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
    new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'aborted');
});

// --- Generic exception ---

test('ToolExecutor returns execution_error for generic exceptions', async () => {
  const tool = makeTool({
    execute: async () => { throw new Error('something broke'); },
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.result.errorCategory, 'execution_error');
  assert.ok(records[0]!.modelContent.includes('something broke'));
});

// --- renderForModel ---

test('renderForModel is called for successful execution', async () => {
  let renderCalled = false;
  const tool = makeTool({
    execute: async () => ({
      success: true,
      data: { v: 42 },
      renderForModel: () => { renderCalled = true; return 'rendered-output'; },
    }),
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(renderCalled, true);
  assert.equal(records[0]!.modelContent, 'rendered-output');
});

// --- Summary ---

test('default summary is generated when summarizeResult not defined', async () => {
  const tool = makeTool();
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', { query: 'hi' }, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.ok(records[0]!.summary.includes('test_tool'));
  assert.ok(records[0]!.summary.includes('ok'));
});

test('custom summarizeResult overrides default', async () => {
  const tool = makeTool({
    summarizeResult: (_args, result) => `custom: ${result.success}`,
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.summary, 'custom: true');
});

// --- Callbacks ---

test('onToolStart and onToolEnd are called', async () => {
  const tool = makeTool();
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const events: string[] = [];
  const callbacks: ToolExecutorCallbacks = {
    onToolStart: (name, callId) => events.push(`start:${name}:${callId}`),
    onToolEnd: (name, callId) => events.push(`end:${name}:${callId}`),
  };
  await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), callbacks,
  );
  assert.deepEqual(events, ['start:test_tool:c1', 'end:test_tool:c1']);
});

// --- Serial budget enforcement ---

test('serial execution truncates large results', async () => {
  const tool = makeTool({
    maxResultChars: 100,
    execute: async () => ({
      success: true,
      data: {},
      renderForModel: () => 'x'.repeat(500),
    }),
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.ok(records[0]!.modelContent.length <= 100);
  assert.equal(records[0]!.result.truncated, true);
});

// --- Concurrency ---

test('concurrent-safe tools run in parallel', async () => {
  const delays: number[] = [];
  const tool = makeTool({
    isConcurrencySafe: true,
    execute: async () => {
      const start = Date.now();
      await new Promise(r => setTimeout(r, 50));
      delays.push(Date.now() - start);
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const start = Date.now();
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1'), makeCall('test_tool', {}, 'c2')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  const elapsed = Date.now() - start;
  assert.equal(records.length, 2);
  // If parallel, total time should be roughly 50ms, not 100ms
  assert.ok(elapsed < 120, `Expected parallel execution, took ${elapsed}ms`);
});

test('results are returned in call order regardless of completion order', async () => {
  let callCount = 0;
  const tool = makeTool({
    isConcurrencySafe: true,
    execute: async () => {
      const idx = callCount++;
      // First call takes longer
      await new Promise(r => setTimeout(r, idx === 0 ? 60 : 10));
      return { success: true, data: { idx }, renderForModel: () => `result-${idx}` };
    },
  });
  const executor = new ToolExecutor(makeRegistry([tool]), new DefaultToolPolicyChecker());
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'first'), makeCall('test_tool', {}, 'second')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(records[0]!.callId, 'first');
  assert.equal(records[1]!.callId, 'second');
});

test('unsafe tool runs alone even between safe tools', async () => {
  const executionOrder: string[] = [];
  const safeTool = makeTool({
    name: 'safe',
    isConcurrencySafe: true,
    execute: async () => {
      executionOrder.push('safe');
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const unsafeTool = makeTool({
    name: 'unsafe',
    isConcurrencySafe: false,
    execute: async () => {
      executionOrder.push('unsafe');
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const registry = makeRegistry([safeTool, unsafeTool]);
  const executor = new ToolExecutor(registry, new DefaultToolPolicyChecker());
  await executor.runTools(
    [
      makeCall('safe', {}, 'c1'),
      makeCall('safe', {}, 'c2'),
      makeCall('unsafe', {}, 'c3'),
      makeCall('safe', {}, 'c4'),
    ],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  // safe+safe run as batch, unsafe alone, safe alone
  assert.equal(executionOrder.length, 4);
});

// --- Policy-rejected calls don't execute ---

test('policy-rejected calls produce error records without execution', async () => {
  let executeCalled = false;
  const tool = makeTool({
    execute: async () => {
      executeCalled = true;
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  });
  const policyChecker: IToolPolicyChecker = {
    checkPolicy: () => ({ allowed: false, reason: 'denied' }),
  };
  const executor = new ToolExecutor(makeRegistry([tool]), policyChecker);
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1')],
    makeContext(), new ResultBudget(), noopCallbacks(),
  );
  assert.equal(executeCalled, false);
  assert.equal(records[0]!.result.errorCategory, 'policy_rejected');
});

// --- Aggregate budget under concurrency ---

test('concurrent aggregate budget truncates largest results', async () => {
  let callIdx = 0;
  const originalTool = makeTool({
    isConcurrencySafe: true,
    maxResultChars: 10_000,
    execute: async () => {
      const idx = callIdx++;
      const content = idx === 0 ? 'x'.repeat(200) : 'y'.repeat(50);
      return { success: true, data: {}, renderForModel: () => content };
    },
  });
  const executor = new ToolExecutor(makeRegistry([originalTool]), new DefaultToolPolicyChecker());
  const budget = new ResultBudget(150);
  const records = await executor.runTools(
    [makeCall('test_tool', {}, 'c1'), makeCall('test_tool', {}, 'c2')],
    makeContext(), budget, noopCallbacks(),
  );
  // Total should be <= 150
  const total = records.reduce((sum, r) => sum + r.modelContent.length, 0);
  assert.ok(total <= 150, `Expected total <= 150, got ${total}`);
});
