import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRequestError } from './errors.js';

test('AgentRequestError has correct name and statusCode', () => {
  const err = new AgentRequestError('not_found', 404);
  assert.equal(err.name, 'AgentRequestError');
  assert.equal(err.message, 'not_found');
  assert.equal(err.statusCode, 404);
  assert.ok(err instanceof Error);
});
