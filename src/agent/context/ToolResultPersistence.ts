import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../../models/ModelClient.js';
import type { ToolResultPersistenceConfig } from './types.js';

export class ToolResultPersistence {
  constructor(private readonly config: ToolResultPersistenceConfig) {}

  /**
   * Persist a single tool result if it exceeds the threshold.
   * Returns the original or a preview stub.
   */
  async processResult(
    toolName: string,
    toolCallId: string,
    content: string,
    conversationId: string,
  ): Promise<string> {
    const threshold = this.getThreshold(toolName);
    if (content.length <= threshold) {
      return content;
    }

    try {
      const filePath = this.getResultPath(conversationId, toolCallId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');

      const preview = this.buildPreview(content, filePath);
      return preview;
    } catch {
      // Persistence failure — return original content inline
      return content;
    }
  }

  /**
   * Enforce per-message aggregate budget across all tool results in the message array.
   * Replaces the largest tool results first until under budget.
   */
  async enforceMessageBudget(messages: Message[], conversationId: string): Promise<Message[]> {
    // Find all tool-role messages and their content sizes
    const toolMessages: Array<{ index: number; size: number }> = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'tool' && msg.content) {
        toolMessages.push({ index: i, size: msg.content.length });
      }
    }

    // Check if total exceeds budget
    const totalChars = toolMessages.reduce((sum, tm) => sum + tm.size, 0);
    if (totalChars <= this.config.perMessageBudgetChars) {
      return messages;
    }

    // Sort by size descending — persist largest first
    const sorted = [...toolMessages].sort((a, b) => b.size - a.size);
    const result = [...messages];
    let remaining = totalChars;

    for (const tm of sorted) {
      if (remaining <= this.config.perMessageBudgetChars) {
        break;
      }

      const msg = result[tm.index];
      if (!msg.content || !msg.toolCallId || !msg.toolName) {
        continue;
      }

      const persisted = await this.processResult(
        msg.toolName,
        msg.toolCallId,
        msg.content,
        conversationId,
      );

      if (persisted !== msg.content) {
        remaining -= msg.content.length - persisted.length;
        result[tm.index] = { ...msg, content: persisted };
      }
    }

    return result;
  }

  async cleanup(conversationId: string): Promise<void> {
    const dirPath = path.join(this.config.storageDir, conversationId);
    await fs.rm(dirPath, { recursive: true, force: true });
  }

  private getThreshold(toolName: string): number {
    return this.config.perToolThresholds?.[toolName] ?? this.config.defaultMaxResultChars;
  }

  private getResultPath(conversationId: string, toolCallId: string): string {
    return path.join(
      this.config.storageDir,
      conversationId,
      'tool-results',
      `${toolCallId}.txt`,
    );
  }

  private buildPreview(content: string, filePath: string): string {
    const sizeKb = Math.round(content.length / 1024);
    let preview = content.slice(0, this.config.previewSizeBytes);

    // Cut at a newline boundary when possible
    const lastNewline = preview.lastIndexOf('\n');
    if (lastNewline > this.config.previewSizeBytes * 0.5) {
      preview = preview.slice(0, lastNewline);
    }

    return [
      '<persisted-output>',
      `Output too large (${sizeKb} KB). Full output saved to: ${filePath}`,
      '',
      `Preview (first ${this.config.previewSizeBytes} bytes):`,
      preview,
      '...',
      '</persisted-output>',
    ].join('\n');
  }
}
