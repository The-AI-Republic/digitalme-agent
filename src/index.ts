import { loadConfig } from './config/loader.js';
import { Agent } from './agent/Agent.js';
import { HeartbeatService } from './heartbeat/HeartbeatService.js';
import { createServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main() {
  const config = loadConfig();
  const agent = new Agent(config);
  const app = createServer(config, agent);
  const heartbeat = new HeartbeatService(config, agent);

  const server = app.listen(config.server.port, config.server.bind, () => {
    console.log(`digitalme-agent listening on ${config.server.bind}:${config.server.port}`);
    heartbeat.start();
  });

  let shutting = false;
  const shutdown = () => {
    if (shutting) return;
    shutting = true;
    console.log('digitalme-agent shutting down…');

    heartbeat.stop();
    agent.beginDrain();
    server.close(() => {
      console.log('digitalme-agent stopped');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('digitalme-agent shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('digitalme-agent failed to start', error);
  process.exit(1);
});
