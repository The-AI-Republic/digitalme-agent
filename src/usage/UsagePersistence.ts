/**
 * File-based persistence for conversation usage snapshots.
 *
 * Stores per-conversation usage JSON so quota enforcement survives
 * process restarts. Snapshots are small (~500 bytes each).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationUsage } from './types.js';

export class UsagePersistence {
  constructor(private readonly storageDir: string) {}

  /** Save a conversation usage snapshot to disk. */
  async save(usage: ConversationUsage): Promise<void> {
    const filePath = this.getFilePath(usage.conversationId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(usage), 'utf-8');
  }

  /** Load a conversation usage snapshot from disk. Returns undefined if not found. */
  async load(conversationId: string): Promise<ConversationUsage | undefined> {
    const filePath = this.getFilePath(conversationId);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as ConversationUsage;
    } catch {
      return undefined;
    }
  }

  /** Remove a persisted snapshot (e.g. on session eviction). */
  async remove(conversationId: string): Promise<void> {
    const filePath = this.getFilePath(conversationId);
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist
    }
  }

  private getFilePath(conversationId: string): string {
    return path.join(this.storageDir, 'usage', `${conversationId}.json`);
  }
}
