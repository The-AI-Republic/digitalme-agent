import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAttributes } from './attributes.js';

test('safeAttributes allows model name', () => {
  const result = safeAttributes({ 'model.name': 'gpt-4' });
  assert.deepEqual(result, { 'model.name': 'gpt-4' });
});

test('safeAttributes allows tool attributes', () => {
  const result = safeAttributes({
    'tool.name': 'web_search',
    'tool.duration_ms': 150,
  });
  assert.deepEqual(result, { 'tool.name': 'web_search', 'tool.duration_ms': 150 });
});

test('safeAttributes allows fork attributes', () => {
  const result = safeAttributes({
    'fork.label': 'session_memory',
    'fork.duration_ms': 500,
    'fork.tool_call_count': 3,
  });
  assert.deepEqual(result, {
    'fork.label': 'session_memory',
    'fork.duration_ms': 500,
    'fork.tool_call_count': 3,
  });
});

test('safeAttributes allows hook attributes', () => {
  const result = safeAttributes({
    'hook.name': 'session_memory',
    'hook.outcome': 'success',
    'hook.duration_ms': 100,
  });
  assert.deepEqual(result, {
    'hook.name': 'session_memory',
    'hook.outcome': 'success',
    'hook.duration_ms': 100,
  });
});

test('safeAttributes allows subagent attributes', () => {
  const result = safeAttributes({
    'subagent.type': 'general-purpose',
    'subagent.duration_ms': 1200,
  });
  assert.deepEqual(result, {
    'subagent.type': 'general-purpose',
    'subagent.duration_ms': 1200,
  });
});

test('safeAttributes strips unknown keys', () => {
  const result = safeAttributes({
    'model.name': 'gpt-4',
    'user.name': 'John Doe',
    'message.content': 'secret text',
    'config.api_key': 'sk-123',
  });
  assert.deepEqual(result, { 'model.name': 'gpt-4' });
});

test('safeAttributes strips null and undefined values', () => {
  const result = safeAttributes({
    'model.name': null,
    'tool.name': undefined,
  });
  assert.deepEqual(result, {});
});

test('safeAttributes strips object values', () => {
  const result = safeAttributes({
    'model.name': 'gpt-4',
    'tool.context': { conversationId: 'conv-1' },
  });
  assert.deepEqual(result, { 'model.name': 'gpt-4' });
});

test('safeAttributes allows boolean values', () => {
  const result = safeAttributes({
    'tool.name': 'search',
    'error.is_retry': true,
  });
  assert.deepEqual(result, {
    'tool.name': 'search',
    'error.is_retry': true,
  });
});

test('safeAttributes allows terminal reason', () => {
  const result = safeAttributes({
    'terminal.reason': 'completed',
  });
  assert.deepEqual(result, { 'terminal.reason': 'completed' });
});

test('safeAttributes allows conversation.id', () => {
  const result = safeAttributes({
    'conversation.id': 'conv-123',
  });
  assert.deepEqual(result, { 'conversation.id': 'conv-123' });
});

test('safeAttributes returns empty object for all-rejected input', () => {
  const result = safeAttributes({
    'fan.email': 'test@example.com',
    'creator.config': 'sensitive',
  });
  assert.deepEqual(result, {});
});

test('safeAttributes allows number array values', () => {
  const result = safeAttributes({
    'model.latencies': [100, 200, 300],
  });
  assert.deepEqual(result, { 'model.latencies': [100, 200, 300] });
});
