import express from 'express';

import type { AgentConfig } from './config/schema.js';
import { Agent } from './agent/Agent.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerVerifyRoutes } from './routes/verify.js';
import { registerTurnRoutes } from './routes/turns.js';
import { registerUsageRoutes } from './routes/usage.js';

export function createServer(config: AgentConfig, agent: Agent) {
  const app = express();

  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));

  registerHealthRoutes(app, agent);
  registerVerifyRoutes(app, config);
  registerTurnRoutes(app, config, agent);
  registerUsageRoutes(app, config, agent);

  return app;
}
