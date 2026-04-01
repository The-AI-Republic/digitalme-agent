import assert from 'node:assert/strict';
import test from 'node:test';
import { EventQueue } from './EventQueue.js';

test('push and iterate values synchronously buffered', async () => {
  const queue = new EventQueue<string>();
  queue.push('a');
  queue.push('b');
  queue.close();

  const collected: string[] = [];
  for await (const value of queue) {
    collected.push(value);
  }
  assert.deepEqual(collected, ['a', 'b']);
});

test('push resolves a waiting consumer immediately', async () => {
  const queue = new EventQueue<number>();
  const iter = queue[Symbol.asyncIterator]();

  const promise = iter.next();
  queue.push(42);
  const result = await promise;

  assert.equal(result.value, 42);
  assert.equal(result.done, false);
});

test('close signals done to waiting consumers', async () => {
  const queue = new EventQueue<number>();
  const iter = queue[Symbol.asyncIterator]();

  const promise = iter.next();
  queue.close();
  const result = await promise;

  assert.equal(result.done, true);
});

test('close after buffered items still yields buffered items first', async () => {
  const queue = new EventQueue<string>();
  queue.push('first');
  queue.close();

  const iter = queue[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.value, 'first');
  assert.equal(first.done, false);

  const second = await iter.next();
  assert.equal(second.done, true);
});

test('push after close still buffers the value', async () => {
  const queue = new EventQueue<string>();
  queue.close();
  queue.push('late');

  // The value is buffered in the internal array but the iterator
  // returns done:true immediately since closed is already set.
  const iter = queue[Symbol.asyncIterator]();
  const result = await iter.next();
  // After close, next() checks buffered values first — 'late' was
  // pushed into the values array so it is still yielded.
  assert.equal(result.value, 'late');
  assert.equal(result.done, false);

  const end = await iter.next();
  assert.equal(end.done, true);
});

test('multiple waiters are each resolved', async () => {
  const queue = new EventQueue<number>();
  const iter = queue[Symbol.asyncIterator]();

  const p1 = iter.next();
  queue.push(1);
  const p2 = iter.next();
  queue.push(2);

  assert.equal((await p1).value, 1);
  assert.equal((await p2).value, 2);
});
