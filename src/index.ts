import { loadConfig } from './config/loader.js';
import { Agent } from './agent/Agent.js';
import { HeartbeatService } from './heartbeat/HeartbeatService.js';
import { createServer } from './server.js';
import { initTelemetry, shutdownTelemetry, deriveAgentIdentity } from './telemetry/instrumentation.js';
import { initMetrics } from './telemetry/metrics.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;
const TELEMETRY_FLUSH_TIMEOUT_MS = 5_000;

async function main() {
  const config = loadConfig();

  // Initialize telemetry before starting the server
  const agentIdentity = deriveAgentIdentity(config.auth.api_key);
  initTelemetry({
    serviceName: 'digitalme-agent',
    serviceVersion: '0.1.0',
    agentIdentityHash: agentIdentity,
  });

  const agent = new Agent(config);
  // Initialize metrics — session gauge callback pulls from agent health
  initMetrics(() => {
    const health = agent.getHealth();
    return (health.sessions as { activeSessions?: number })?.activeSessions ?? 0;
  });

  const app = createServer(config, agent);
  const heartbeat = new HeartbeatService(config, agent);

  const server = app.listen(config.server.port, config.server.bind, () => {
    console.log(`digitalme-agent listening on ${config.server.bind}:${config.server.port}`);
    heartbeat.start();
  });

  let shutting = false;
  const shutdown = async () => {
    if (shutting) return;
    shutting = true;
    console.log('digitalme-agent shutting down…');

    heartbeat.stop();
    agent.beginDrain();

    setTimeout(() => {
      console.error('digitalme-agent shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    // 1. Close HTTP server (stop accepting new requests)
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } catch {
      // Server close failed — continue to telemetry flush and shutdown anyway.
    }

    // 2. Flush telemetry with dedicated timeout (5s from 30s shutdown budget)
    try {
      await Promise.race([
        shutdownTelemetry(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('telemetry flush timeout')), TELEMETRY_FLUSH_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // Flush failed or timed out — proceed with exit
    }

    console.log('digitalme-agent stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error) => {
  console.error('digitalme-agent failed to start', error);
  process.exit(1);
});
