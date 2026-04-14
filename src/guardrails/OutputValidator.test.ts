import test from 'node:test';
import assert from 'node:assert/strict';

import { validateOutput } from './OutputValidator.js';
import type { GuardrailConfig } from './types.js';

function makeConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return {
    enabled: true,
    blocked_keywords: [],
    response_rules: { max_response_length: 2000, block_external_links: false },
    pii_detection: { enabled: false, block_in_input: true, block_in_output: true },
    jailbreak_detection: { enabled: false },
    messages: {
      input_blocked: 'input blocked',
      output_blocked: 'output blocked',
    },
    ...overrides,
  };
}

// --- Disabled ---

test('validateOutput passes everything when guardrails disabled', () => {
  const config = makeConfig({ enabled: false });
  const result = validateOutput('buy crypto at http://evil.com with SSN 123-45-6789', config);
  assert.equal(result.action, 'send');
  assert.equal(result.violations.length, 0);
});

// --- Blocked keywords (critical) ---

test('validateOutput blocks output containing blocked keywords', () => {
  const config = makeConfig({ blocked_keywords: ['buy crypto'] });
  const result = validateOutput('You should buy crypto now!', config);
  assert.equal(result.action, 'block');
  assert.ok(result.violations.some((v) => v.category === 'blocked_keyword'));
  assert.ok(result.violations.some((v) => v.severity === 'critical'));
  assert.equal(result.replacementResponse, 'output blocked');
});

test('validateOutput keyword matching is case-insensitive', () => {
  const config = makeConfig({ blocked_keywords: ['Send Money'] });
  const result = validateOutput('Please SEND MONEY to this address', config);
  assert.equal(result.action, 'block');
});

test('validateOutput keyword matching does not trigger on substrings', () => {
  const config = makeConfig({ blocked_keywords: ['kill', 'ass'] });
  const result = validateOutput('The assistant has a skill issue', config);
  assert.equal(result.action, 'send');
});

// --- PII leakage (critical) ---

test('validateOutput blocks output with email PII', () => {
  const config = makeConfig({
    pii_detection: { enabled: true, block_in_input: true, block_in_output: true },
  });
  const result = validateOutput('Contact them at user@example.com', config);
  assert.equal(result.action, 'block');
  assert.ok(result.violations.some((v) => v.category === 'pii'));
});

test('validateOutput blocks output with phone PII', () => {
  const config = makeConfig({
    pii_detection: { enabled: true, block_in_input: true, block_in_output: true },
  });
  const result = validateOutput('Their number is 555-123-4567', config);
  assert.equal(result.action, 'block');
  assert.ok(result.violations.some((v) => v.category === 'pii'));
});

test('validateOutput allows separator-free numbers that are not phone numbers', () => {
  const config = makeConfig({
    pii_detection: { enabled: true, block_in_input: true, block_in_output: true },
  });
  const result = validateOutput('Order number 1234567890 is ready', config);
  assert.equal(result.action, 'send');
});

test('validateOutput blocks output with credit card PII', () => {
  const config = makeConfig({
    pii_detection: { enabled: true, block_in_input: true, block_in_output: true },
  });
  const result = validateOutput('Card number: 4111-1111-1111-1111', config);
  assert.equal(result.action, 'block');
});

test('validateOutput skips PII check when block_in_output is false', () => {
  const config = makeConfig({
    pii_detection: { enabled: true, block_in_input: true, block_in_output: false },
  });
  const result = validateOutput('Contact user@example.com', config);
  assert.equal(result.action, 'send');
});

test('validateOutput allows separator-free SSN-like numbers', () => {
  const config = makeConfig({
    pii_detection: { enabled: true, block_in_input: true, block_in_output: true },
  });
  const result = validateOutput('Reference 123 45 6789', config);
  assert.equal(result.action, 'send');
});

// --- External links (medium — modify) ---

test('validateOutput strips external links when block_external_links is true', () => {
  const config = makeConfig({
    response_rules: { max_response_length: 2000, block_external_links: true },
  });
  const result = validateOutput('Check out https://example.com for more info', config);
  assert.equal(result.action, 'modify');
  assert.ok(result.modifiedText);
  assert.ok(!result.modifiedText.includes('https://example.com'));
  assert.ok(result.modifiedText.includes('[link removed]'));
});

test('validateOutput allows text without links when block_external_links is true', () => {
  const config = makeConfig({
    response_rules: { max_response_length: 2000, block_external_links: true },
  });
  const result = validateOutput('No links here', config);
  assert.equal(result.action, 'send');
});

// --- Response length (low — modify) ---

test('validateOutput truncates text exceeding max_response_length', () => {
  const config = makeConfig({
    response_rules: { max_response_length: 20, block_external_links: false },
  });
  const longText = 'A'.repeat(50);
  const result = validateOutput(longText, config);
  assert.equal(result.action, 'modify');
  assert.ok(result.modifiedText);
  assert.ok(result.modifiedText.length <= 20);
  assert.ok(result.modifiedText.endsWith('...'));
});

test('validateOutput does not truncate text within length limit', () => {
  const config = makeConfig({
    response_rules: { max_response_length: 100, block_external_links: false },
  });
  const result = validateOutput('Short response', config);
  assert.equal(result.action, 'send');
});

// --- Combined violations ---

test('validateOutput critical violation overrides medium violations', () => {
  const config = makeConfig({
    blocked_keywords: ['forbidden'],
    response_rules: { max_response_length: 2000, block_external_links: true },
  });
  const result = validateOutput('forbidden https://example.com', config);
  assert.equal(result.action, 'block');
  assert.equal(result.violations.length, 2);
});

test('validateOutput combines link stripping and truncation', () => {
  const config = makeConfig({
    response_rules: { max_response_length: 50, block_external_links: true },
  });
  const text = 'Check https://example.com and ' + 'A'.repeat(100);
  const result = validateOutput(text, config);
  assert.equal(result.action, 'modify');
  assert.ok(result.modifiedText);
  assert.ok(result.modifiedText.length <= 50);
  assert.ok(!result.modifiedText.includes('https://'));
});

// --- Clean passthrough ---

test('validateOutput passes clean text', () => {
  const config = makeConfig({
    blocked_keywords: ['bad'],
    pii_detection: { enabled: true, block_in_input: true, block_in_output: true },
    response_rules: { max_response_length: 2000, block_external_links: true },
  });
  const result = validateOutput('Here is a helpful response about meditation.', config);
  assert.equal(result.action, 'send');
  assert.equal(result.violations.length, 0);
});
