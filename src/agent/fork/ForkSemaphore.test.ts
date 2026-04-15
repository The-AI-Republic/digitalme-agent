import test from 'node:test';
import assert from 'node:assert/strict';

import { ForkSemaphore } from './ForkSemaphore.js';

test('tryAcquire succeeds when below limit', () => {
  const sem = new ForkSemaphore(3);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.getRunning(), 1);
});

test('tryAcquire succeeds up to maxConcurrent', () => {
  const sem = new ForkSemaphore(2);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.getRunning(), 2);
});

test('tryAcquire fails when at maxConcurrent', () => {
  const sem = new ForkSemaphore(2);
  sem.tryAcquire();
  sem.tryAcquire();
  assert.equal(sem.tryAcquire(), false);
  assert.equal(sem.getRunning(), 2);
});

test('release decrements running count', () => {
  const sem = new ForkSemaphore(3);
  sem.tryAcquire();
  sem.tryAcquire();
  assert.equal(sem.getRunning(), 2);

  sem.release();
  assert.equal(sem.getRunning(), 1);
});

test('release allows new acquire after freeing slot', () => {
  const sem = new ForkSemaphore(1);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), false);

  sem.release();
  assert.equal(sem.tryAcquire(), true);
});

test('release never goes below zero', () => {
  const sem = new ForkSemaphore(2);
  sem.release();
  sem.release();
  sem.release();
  assert.equal(sem.getRunning(), 0);
});

test('getRunning starts at zero', () => {
  const sem = new ForkSemaphore(5);
  assert.equal(sem.getRunning(), 0);
});

test('maxConcurrent of 1 acts as mutex', () => {
  const sem = new ForkSemaphore(1);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), false);
  assert.equal(sem.tryAcquire(), false);
  sem.release();
  assert.equal(sem.tryAcquire(), true);
});

test('acquire and release cycle maintains correct count', () => {
  const sem = new ForkSemaphore(3);
  sem.tryAcquire(); // 1
  sem.tryAcquire(); // 2
  sem.tryAcquire(); // 3
  assert.equal(sem.tryAcquire(), false);

  sem.release(); // 2
  sem.release(); // 1
  assert.equal(sem.getRunning(), 1);
  assert.equal(sem.tryAcquire(), true); // 2
  assert.equal(sem.tryAcquire(), true); // 3
  assert.equal(sem.tryAcquire(), false);
});
