import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from './loader.js';

function writeTempConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digitalme-config-'));
  const filePath = path.join(dir, 'config.yaml');
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test('loadConfig throws the missing env var name during interpolation', () => {
  const filePath = writeTempConfig(`
soul:
  name: Test Agent
  description: A test agent.
auth:
  api_key: \${DIGITALME_TEST_AUTH_KEY}
  signing_secret: secret
platform:
  base_url:
  heartbeat_interval_seconds: 20
model:
  provider: openai
  name: gpt-4o
  api_key: model-key
limits:
  max_message_length: 4000
  max_history_messages: 100
  max_turns: 10
  max_concurrent: 50
  max_pending: 1000
  max_active_sessions: 1000
  session_ttl_seconds: 1800
security:
  hmac_tolerance_seconds: 300
`);

  const originalValue = process.env.DIGITALME_TEST_AUTH_KEY;
  delete process.env.DIGITALME_TEST_AUTH_KEY;

  try {
    assert.throws(() => loadConfig(filePath), /Missing required env var: DIGITALME_TEST_AUTH_KEY/);
  } finally {
    if (originalValue === undefined) {
      delete process.env.DIGITALME_TEST_AUTH_KEY;
    } else {
      process.env.DIGITALME_TEST_AUTH_KEY = originalValue;
    }
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('loadConfig rejects removed legacy config fields with a clear error', () => {
  const filePath = writeTempConfig(`
soul:
  name: Test Agent
  description: A test agent.
auth:
  api_key: key
  signing_secret: secret
platform:
  base_url:
  heartbeat_interval_seconds: 20
model:
  provider: openai
  name: gpt-4o
  api_key: model-key
limits:
  max_message_length: 4000
  max_history_messages: 100
  max_turns: 10
  max_concurrent: 50
  max_pending: 1000
  max_active_sessions: 1000
  session_ttl_seconds: 1800
security:
  hmac_tolerance_seconds: 300
routing:
  task_models:
    summary:
      provider: openai
      name: gpt-4o-mini
      api_key: model-key
context:
  model_metadata:
    gpt-4o:
      context_window_size: 128000
      max_output_tokens: 16384
  summary:
    model: gpt-4o-mini
  session_memory:
    extraction_model: gpt-4o-mini
`);

  try {
    assert.throws(
      () => loadConfig(filePath),
      /Config contains removed fields: routing\.task_models, context\.summary\.model, context\.session_memory\.extraction_model, context\.model_metadata/,
    );
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});
