import assert from 'node:assert/strict';
import test from 'node:test';
import { ShutdownController } from './shutdown.js';

test('initially not draining', () => {
  const sc = new ShutdownController();
  assert.equal(sc.isDraining(), false);
});

test('beginDrain sets draining to true', () => {
  const sc = new ShutdownController();
  sc.beginDrain();
  assert.equal(sc.isDraining(), true);
});

test('beginDrain is idempotent', () => {
  const sc = new ShutdownController();
  sc.beginDrain();
  sc.beginDrain();
  assert.equal(sc.isDraining(), true);
});
