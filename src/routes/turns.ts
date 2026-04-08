import type { Express } from 'express';

import type { AgentConfig } from '../config/schema.js';
import { Agent } from '../agent/Agent.js';
import { AgentRequestError } from '../agent/errors.js';
import { verifyRequestSignature } from '../middleware/hmac.js';
import { validateTurnLimits } from '../middleware/request-limits.js';
import { turnRequestSchema } from '../protocol/schemas.js';
import { initSse, writeSse } from '../streaming/sse.js';

export function registerTurnRoutes(app: Express, config: AgentConfig, agent: Agent) {
  app.post('/v1/task', async (req, res) => {
    const startTime = Date.now();
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        console.log('[task] client disconnected after %dms', Date.now() - startTime);
        abortController.abort();
      }
    });

    let events;
    try {
      verifyRequestSignature(req, config);
      const payload = turnRequestSchema.parse(req.body);
      validateTurnLimits(config, payload);

      events = agent.submit({
        requestId: payload.request_id,
        conversationId: payload.conversation_id,
        userMessage: payload.message,
        history: payload.history,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      if (error instanceof AgentRequestError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : 'invalid_request';
      const status =
        message === 'unauthorized' || message === 'replay_rejected' || message.startsWith('missing_header:') ? 401 :
        message === 'queue_full' ? 429 :
        message === 'request_in_progress' ? 409 :
        422;
      res.status(status).json({ error: message });
      return;
    }

    initSse(res);
    try {
      for await (const event of events) {
        writeSse(res, event);
      }
      console.log('[task] completed after %dms', Date.now() - startTime);
    } catch (error) {
      if (abortController.signal.aborted || res.writableEnded) {
        console.log('[task] aborted/closed after %dms', Date.now() - startTime);
        return;
      }
      console.error('[task] stream error after %dms', Date.now() - startTime, error);
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });
}
