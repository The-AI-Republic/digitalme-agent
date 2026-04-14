import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAgentIdentity, initTelemetry, shutdownTelemetry, interactionContext } from './instrumentation.js';

test('deriveAgentIdentity produces a SHA-256 hex string', () => {
  const hash = deriveAgentIdentity('test-api-key');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('deriveAgentIdentity is deterministic', () => {
  const hash1 = deriveAgentIdentity('same-key');
  const hash2 = deriveAgentIdentity('same-key');
  assert.equal(hash1, hash2);
});

test('deriveAgentIdentity produces different hashes for different keys', () => {
  const hash1 = deriveAgentIdentity('key-a');
  const hash2 = deriveAgentIdentity('key-b');
  assert.notEqual(hash1, hash2);
});

test('initTelemetry returns tracer and meter', async () => {
  const providers = initTelemetry({
    serviceName: 'test-agent',
    serviceVersion: '0.0.1',
    agentIdentityHash: 'abc123',
  });

  assert.ok(providers.tracer);
  assert.ok(providers.meter);

  await shutdownTelemetry();
});

test('shutdownTelemetry is safe to call multiple times', async () => {
  await shutdownTelemetry();
  await shutdownTelemetry();
});

test('interactionContext is an AsyncLocalStorage instance', () => {
  assert.ok(interactionContext);
  assert.equal(typeof interactionContext.run, 'function');
  assert.equal(typeof interactionContext.getStore, 'function');
});
