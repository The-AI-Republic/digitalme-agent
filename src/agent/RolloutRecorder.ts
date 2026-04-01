import crypto from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export interface RolloutEntry {
  type: string;
  conversationId: string;
  taskId: string;
  turnId?: number;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export interface IRolloutRecorder {
  record(entry: RolloutEntry): Promise<void>;
}

function sanitizeData(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}...<truncated>` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeData(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeData(item)]),
    );
  }
  return value;
}

function conversationFileName(conversationId: string) {
  const hash = crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 16);
  return `${hash}.jsonl`;
}

export class RolloutRecorder implements IRolloutRecorder {
  private readonly baseDir: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(baseDir = path.join(process.cwd(), '.digital_me_agent', 'rollouts')) {
    this.baseDir = baseDir;
  }

  async record(entry: RolloutEntry) {
    const filePath = path.join(this.baseDir, conversationFileName(entry.conversationId));
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      data: sanitizeData(entry.data),
    }) + '\n';

    const previous = this.writes.get(filePath) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.baseDir, { recursive: true });
        await appendFile(filePath, line, 'utf8');
      });

    this.writes.set(filePath, write);
    await write;
  }
}
