import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from './server.js';
import { Agent } from './agent/Agent.js';
import { testConfig } from './test/fixtures.js';

function makeSessionStats() {
  return {
    activeSessions: 0,
    activeTurns: 0,
    sessionTtlSeconds: 1800,
    maxActiveSessions: 1000,
    usage: { totalCostUsd: 0, dailyCostUsd: 0, monthlyCostUsd: 0 },
  };
}

test('createServer returns an express app with expected routes', () => {
  const agent = new Agent(testConfig, {
    sessionManager: { execute: async () => {}, getStats: () => makeSessionStats(), beginDrain: () => {} },
  });
  const app = createServer(testConfig, agent);

  // Express app should be a function (request handler)
  assert.equal(typeof app, 'function');

  // Verify routes are registered by checking the router stack
  const routes = (app as any)._router.stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      method: Object.keys(layer.route.methods)[0],
      path: layer.route.path,
    }));

  assert.ok(routes.some((r: any) => r.method === 'get' && r.path === '/health'));
  assert.ok(routes.some((r: any) => r.method === 'post' && r.path === '/verify'));
  assert.ok(routes.some((r: any) => r.method === 'post' && r.path === '/v1/task'));
});

test('createServer sets up JSON body parser with rawBody', async () => {
  const agent = new Agent(testConfig, {
    sessionManager: { execute: async () => {}, getStats: () => makeSessionStats(), beginDrain: () => {} },
  });
  const app = createServer(testConfig, agent);

  // Verify json middleware is configured by checking the middleware stack
  const jsonMiddleware = (app as any)._router.stack
    .filter((layer: any) => layer.name === 'jsonParser');
  assert.ok(jsonMiddleware.length > 0, 'JSON parser middleware should be registered');
});
