import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initMetrics,
  recordTurnCompleted,
  recordModelCall,
  recordTokens,
  recordToolCall,
  recordFork,
  recordHook,
  recordError,
} from './metrics.js';

// Initialize metrics once for all tests
initMetrics(() => 5);

test('recordTurnCompleted does not throw', () => {
  assert.doesNotThrow(() => recordTurnCompleted('gpt-4', 1500, true));
});

test('recordTurnCompleted with failure', () => {
  assert.doesNotThrow(() => recordTurnCompleted('gpt-4', 500, false));
});

test('recordModelCall does not throw', () => {
  assert.doesNotThrow(() => recordModelCall('gpt-4', true));
  assert.doesNotThrow(() => recordModelCall('gpt-4', false));
});

test('recordTokens does not throw', () => {
  assert.doesNotThrow(() => recordTokens('gpt-4', 1000, 500));
});

test('recordTokens with zero values', () => {
  assert.doesNotThrow(() => recordTokens('gpt-4', 0, 0));
});

test('recordToolCall does not throw', () => {
  assert.doesNotThrow(() => recordToolCall('web_search', 200, true));
  assert.doesNotThrow(() => recordToolCall('web_search', 5000, false));
});

test('recordFork does not throw', () => {
  assert.doesNotThrow(() => recordFork('session_memory', 'success'));
  assert.doesNotThrow(() => recordFork('session_memory', 'failed'));
  assert.doesNotThrow(() => recordFork('session_memory', 'rejected'));
});

test('recordHook does not throw', () => {
  assert.doesNotThrow(() => recordHook('session_memory', 'success'));
  assert.doesNotThrow(() => recordHook('session_memory', 'error'));
  assert.doesNotThrow(() => recordHook('session_memory', 'timeout'));
});

test('recordError does not throw', () => {
  assert.doesNotThrow(() => recordError('model_call'));
  assert.doesNotThrow(() => recordError('tool_execution'));
});
