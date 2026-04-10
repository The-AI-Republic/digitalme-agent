import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptProjector } from './PromptProjector.js';
import { TokenBudget } from './TokenBudget.js';
import { generateId, type Message } from '../../models/ModelClient.js';

const tokenBudget = new TokenBudget({
  modelMetadata: { 'test-model': { contextWindowSize: 10000, maxOutputTokens: 1000 } },
  defaultContextWindowSize: 10000,
  defaultMaxOutputTokens: 1000,
  microcompactRatio: 0.5,
  projectionRatio: 0.7,
  overflowRatio: 0.9,
  safetyMargin: 1.0,
});

const projector = new PromptProjector(
  { recentTailMinMessages: 2, recentTailMaxTokens: 5000 },
  tokenBudget,
);

test('nominal pressure passes history through unchanged', () => {
  const history: Message[] = [
    { role: 'user', content: 'hello', id: generateId() },
    { role: 'assistant', content: 'hi', id: generateId() },
  ];
  const latest: Message = { role: 'user', content: 'bye', id: generateId() };
  const result = projector.project({
    fullHistory: history,
    latestUserMessage: latest,
    modelName: 'test-model',
    systemPromptTokenEstimate: 100,
    pressure: 'nominal',
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].content, 'hello');
  assert.equal(result[2].content, 'bye');
});

test('projection pressure inserts context block from session memory', () => {
  const history: Message[] = [
    { role: 'user', content: 'recent question', id: generateId() },
    { role: 'assistant', content: 'recent answer', id: generateId() },
  ];
  const latest: Message = { role: 'user', content: 'follow up', id: generateId() };
  const result = projector.project({
    fullHistory: history,
    latestUserMessage: latest,
    modelName: 'test-model',
    systemPromptTokenEstimate: 100,
    pressure: 'projection',
    sessionMemory: {
      text: 'Fan likes cats. Discussed pet adoption.',
      lastExtractedAt: Date.now(),
      lastExtractedTokenCount: 1000,
      estimatedTokens: 50,
    },
  });
  // Should have context block + recent tail + latest message
  assert.ok(result.some((m) => m.content?.includes('Context from earlier conversation')));
  assert.ok(result.some((m) => m.content?.includes('Fan likes cats')));
  assert.equal(result[result.length - 1].content, 'follow up');
});

test('projection prefers session memory over summary', () => {
  const history: Message[] = [
    { role: 'user', content: 'hi', id: generateId() },
  ];
  const latest: Message = { role: 'user', content: 'question', id: generateId() };
  const result = projector.project({
    fullHistory: history,
    latestUserMessage: latest,
    modelName: 'test-model',
    systemPromptTokenEstimate: 100,
    pressure: 'projection',
    sessionMemory: {
      text: 'SESSION_MEMORY_CONTENT',
      lastExtractedAt: Date.now(),
      lastExtractedTokenCount: 1000,
      estimatedTokens: 50,
    },
    summary: {
      text: 'SUMMARY_CONTENT',
      coversMessageCount: 10,
      generatedAt: Date.now(),
      estimatedTokens: 50,
    },
  });
  const contextBlock = result.find((m) => m.content?.includes('Context from earlier'));
  assert.ok(contextBlock?.content?.includes('SESSION_MEMORY_CONTENT'));
  assert.ok(!contextBlock?.content?.includes('SUMMARY_CONTENT'));
});

test('microcompact pressure passes history through without context block', () => {
  const history: Message[] = [
    { role: 'user', content: 'hello', id: generateId() },
  ];
  const latest: Message = { role: 'user', content: 'bye', id: generateId() };
  const result = projector.project({
    fullHistory: history,
    latestUserMessage: latest,
    modelName: 'test-model',
    systemPromptTokenEstimate: 100,
    pressure: 'microcompact',
  });
  assert.equal(result.length, 2);
  assert.ok(!result.some((m) => m.content?.includes('Context from earlier')));
});
