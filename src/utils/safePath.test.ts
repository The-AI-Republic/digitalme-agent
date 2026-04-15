import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { assertSafePathComponent, safePath } from './safePath.js';

// --- assertSafePathComponent ---

test('assertSafePathComponent accepts simple alphanumeric id', () => {
  assert.equal(assertSafePathComponent('abc123'), 'abc123');
});

test('assertSafePathComponent accepts hyphens and underscores', () => {
  assert.equal(assertSafePathComponent('conv-id_123'), 'conv-id_123');
});

test('assertSafePathComponent accepts exactly 128 characters', () => {
  const id = 'a'.repeat(128);
  assert.equal(assertSafePathComponent(id), id);
});

test('assertSafePathComponent rejects strings longer than 128 characters', () => {
  const id = 'a'.repeat(129);
  assert.throws(() => assertSafePathComponent(id), /Unsafe path component/);
});

test('assertSafePathComponent rejects empty string', () => {
  assert.throws(() => assertSafePathComponent(''), /Unsafe path component/);
});

test('assertSafePathComponent rejects path traversal with ..', () => {
  assert.throws(() => assertSafePathComponent('..'), /Unsafe path component/);
});

test('assertSafePathComponent rejects path traversal with ../', () => {
  assert.throws(() => assertSafePathComponent('../etc'), /Unsafe path component/);
});

test('assertSafePathComponent rejects forward slashes', () => {
  assert.throws(() => assertSafePathComponent('a/b'), /Unsafe path component/);
});

test('assertSafePathComponent rejects backslashes', () => {
  assert.throws(() => assertSafePathComponent('a\\b'), /Unsafe path component/);
});

test('assertSafePathComponent rejects spaces', () => {
  assert.throws(() => assertSafePathComponent('hello world'), /Unsafe path component/);
});

test('assertSafePathComponent rejects null bytes', () => {
  assert.throws(() => assertSafePathComponent('abc\x00def'), /Unsafe path component/);
});

test('assertSafePathComponent rejects special characters', () => {
  for (const ch of ['@', '#', '$', '%', '!', '~', '*', '?', '<', '>', '|', '"', "'", '`', ';', '&']) {
    assert.throws(() => assertSafePathComponent(`id${ch}val`), /Unsafe path component/, `should reject ${ch}`);
  }
});

// --- safePath ---

test('safePath builds a valid path with safe components', () => {
  const result = safePath('/base/dir', 'conv-123', 'file_abc');
  assert.equal(result, path.join('/base/dir', 'conv-123', 'file_abc'));
});

test('safePath with single component', () => {
  const result = safePath('/base', 'id');
  assert.equal(result, path.join('/base', 'id'));
});

test('safePath throws when any component is unsafe', () => {
  assert.throws(() => safePath('/base', 'good', '../bad'), /Unsafe path component/);
});

test('safePath throws when first component is unsafe', () => {
  assert.throws(() => safePath('/base', 'bad/slash', 'good'), /Unsafe path component/);
});

test('safePath allows baseDir to contain slashes (not validated)', () => {
  const result = safePath('/var/data/storage', 'conv123');
  assert.equal(result, path.join('/var/data/storage', 'conv123'));
});
