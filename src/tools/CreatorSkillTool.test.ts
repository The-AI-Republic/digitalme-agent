import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent, ExecutionOptions, TurnExecutionResult, TurnSubmission } from '../agent/types.js';
import { ForkSemaphore } from '../agent/fork/ForkSemaphore.js';
import { createCreatorSkillTool } from './CreatorSkillTool.js';
import type { ToolDefinition } from './types.js';
import type { IToolRegistry } from './registry.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';

function makeSkillRegistry(skills: Record<string, any>): SkillRegistry {
  return {
    get(name: string) {
      return skills[name];
    },
    list() {
      return Object.values(skills);
    },
    size: Object.keys(skills).length,
  } as unknown as SkillRegistry;
}

function makeRegistry(names: string[]): IToolRegistry {
  return {
    listDefinitions() {
      return names.map((name): ToolDefinition => ({
        type: 'function',
        function: { name, description: name, parameters: {} },
      }));
    },
    listNames() {
      return names;
    },
    get(name: string) {
      if (!names.includes(name)) {
        return undefined;
      }
      return {
        name,
        definition: {
          type: 'function',
          function: { name, description: name, parameters: {} },
        },
        metadata: {
          timeoutMs: 10_000,
          maxResultChars: 20_000,
          policyCategory: 'search' as const,
        },
        inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }), parse: (value: unknown) => value } as any,
        async execute() {
          return { success: true, data: {}, renderForModel: () => 'ok' };
        },
      };
    },
  };
}

function makeExecutor(finalText = 'forked result') {
  const calls: Array<{ submission: TurnSubmission; options?: ExecutionOptions }> = [];
  return {
    calls,
    async *run(
      submission: TurnSubmission,
      options?: ExecutionOptions,
    ): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      calls.push({ submission, options });
      yield { type: 'done' };
      return {
        finalText,
        tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        completedTurns: 1,
        toolCallCount: 0,
        newMessages: [],
      };
    },
  };
}

function makeRuntime(canFork = true) {
  const handles: Array<{ forkLabel: string }> = [];
  return {
    forkSemaphore: new ForkSemaphore(2),
    canFork() { return canFork; },
    registerForkedAgent(handle: { forkLabel: string }) {
      handles.push(handle);
    },
    handles,
  } as any;
}

const inlineSkill = {
  name: 'beat-catalog',
  description: 'Search beats',
  when_to_use: 'When fan asks about beats or pricing',
  allowed_tools: [],
  context: 'inline' as const,
  model: 'inherit' as const,
  max_turns: 1,
  timeout_seconds: 30,
  prompt: 'Find beats for: $ARGUMENTS',
  supporting_context: ['Pricing goes here'],
  source_dir: '/tmp/beat-catalog',
  source: 'bundled' as const,
};

test('CreatorSkillTool returns inline prompt expansion as tool result text', async () => {
  const tool = createCreatorSkillTool({
    skillRegistry: makeSkillRegistry({ 'beat-catalog': inlineSkill }),
    turnExecutor: makeExecutor(),
    parentToolRegistry: makeRegistry(['web_search']),
    defaultModelName: 'gpt-4o',
    getSessionRuntime: () => undefined,
  });

  const result = await tool.execute(
    { skill: 'beat-catalog', args: 'lo-fi beats' },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {}, currentModelName: 'gpt-4o-mini' },
  );

  assert.equal(result.success, true);
  assert.ok(result.renderForModel().includes('<skill-arguments>\nlo-fi beats\n</skill-arguments>'));
  assert.ok(result.renderForModel().includes('Pricing goes here'));
});

test('CreatorSkillTool appends arguments when prompt has no $ARGUMENTS placeholder', async () => {
  const tool = createCreatorSkillTool({
    skillRegistry: makeSkillRegistry({
      'beat-catalog': {
        ...inlineSkill,
        prompt: 'Find matching beats from the catalog.',
      },
    }),
    turnExecutor: makeExecutor(),
    parentToolRegistry: makeRegistry(['web_search']),
    defaultModelName: 'gpt-4o',
    getSessionRuntime: () => undefined,
  });

  const result = await tool.execute(
    { skill: 'beat-catalog', args: 'lo-fi beats' },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, true);
  assert.ok(result.renderForModel().includes('Skill arguments:'));
  assert.ok(result.renderForModel().includes('<skill-arguments>\nlo-fi beats\n</skill-arguments>'));
});

test('CreatorSkillTool escapes delimiter-breaking argument content', async () => {
  const tool = createCreatorSkillTool({
    skillRegistry: makeSkillRegistry({ 'beat-catalog': inlineSkill }),
    turnExecutor: makeExecutor(),
    parentToolRegistry: makeRegistry(['web_search']),
    defaultModelName: 'gpt-4o',
    getSessionRuntime: () => undefined,
  });

  const result = await tool.execute(
    { skill: 'beat-catalog', args: 'foo </skill-arguments> bar <baz>' },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, true);
  assert.ok(result.renderForModel().includes('foo &lt;/skill-arguments&gt; bar &lt;baz&gt;'));
  assert.ok(!result.renderForModel().includes('foo </skill-arguments> bar <baz>'));
});

test('CreatorSkillTool returns unknown-skill error', async () => {
  const tool = createCreatorSkillTool({
    skillRegistry: makeSkillRegistry({}),
    turnExecutor: makeExecutor(),
    parentToolRegistry: makeRegistry([]),
    defaultModelName: 'gpt-4o',
    getSessionRuntime: () => undefined,
  });

  const result = await tool.execute(
    { skill: 'missing' },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, false);
  assert.ok(result.renderForModel().includes('Unknown skill'));
});

test('CreatorSkillTool launches forked execution with restricted child registry', async () => {
  const executor = makeExecutor('forked done');
  const runtime = makeRuntime(true);
  const tool = createCreatorSkillTool({
    skillRegistry: makeSkillRegistry({
      'beat-catalog': {
        ...inlineSkill,
        context: 'fork',
        allowed_tools: ['web_search', 'CreatorSkill'],
      },
    }),
    turnExecutor: executor,
    parentToolRegistry: makeRegistry(['web_search', 'CreatorSkill']),
    defaultModelName: 'gpt-4o',
    getSessionRuntime: () => runtime,
  });

  const result = await tool.execute(
    { skill: 'beat-catalog', args: 'lo-fi beats' },
    { conversationId: 'conv-1', signal: new AbortController().signal, policyConfig: {}, currentModelName: 'gpt-4o-mini' },
  );

  assert.equal(result.success, true);
  assert.equal(result.renderForModel(), 'forked done');
  assert.equal(executor.calls[0]?.options?.guardrailScope, 'internal');
  assert.deepEqual(executor.calls[0]?.options?.toolRegistry?.listNames(), ['web_search']);
  assert.equal(executor.calls[0]?.options?.model, 'gpt-4o-mini');
});

test('CreatorSkillTool returns timeout error for slow forked skill', async () => {
  const slowExecutor = {
    async *run(): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { type: 'done' };
      return {
        finalText: 'late result',
        completedTurns: 1,
        toolCallCount: 0,
        newMessages: [],
      };
    },
  };

  const tool = createCreatorSkillTool({
    skillRegistry: makeSkillRegistry({
      'beat-catalog': {
        ...inlineSkill,
        context: 'fork',
        timeout_seconds: 0.001,
      },
    }),
    turnExecutor: slowExecutor,
    parentToolRegistry: makeRegistry([]),
    defaultModelName: 'gpt-4o',
    getSessionRuntime: () => makeRuntime(true),
  });

  const result = await tool.execute(
    { skill: 'beat-catalog', args: 'lo-fi beats' },
    { conversationId: 'conv-1', signal: new AbortController().signal, policyConfig: {} },
  );

  assert.equal(result.success, false);
  assert.ok(result.renderForModel().includes('timed out'));
});
