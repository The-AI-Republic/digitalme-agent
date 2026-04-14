import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../../models/ModelClient.js';
import type { SessionMemoryContent } from './types.js';
import { SESSION_MEMORY_TEMPLATE } from './SessionMemoryPrompt.js';

const BYTES_PER_TOKEN = 4;

export interface SessionMemoryConfig {
  enabled: boolean;
  tokensBetweenUpdates: number;
  toolCallsBetweenUpdates: number;
  minimumTokensToInit: number;
  maxTotalTokens: number;
  maxSectionTokens: number;
  storagePath: string;
}

interface SessionMemoryState {
  lastSummarizedMessageId?: string;
  tokensAtLastExtraction: number;
  extractionStartedAt?: number;
  sessionMemoryInitialized: boolean;
  toolCallsSinceLastExtraction: number;
}

export class SessionMemory {
  private state: SessionMemoryState = {
    tokensAtLastExtraction: 0,
    sessionMemoryInitialized: false,
    toolCallsSinceLastExtraction: 0,
  };

  private extractionInProgress = false;
  private extractionPromise: Promise<void> | null = null;
  /** Set by clear() — prevents getMemory() from reading stale files after reseed. */
  private cleared = false;

  constructor(private readonly config: SessionMemoryConfig) {}

  shouldExtract(currentTokenCount: number): boolean {
    if (!this.config.enabled) return false;

    // One-time init gate
    if (!this.state.sessionMemoryInitialized) {
      if (currentTokenCount < this.config.minimumTokensToInit) {
        return false;
      }
      this.state.sessionMemoryInitialized = true;
    }

    // Token growth threshold
    const tokenGrowth = currentTokenCount - this.state.tokensAtLastExtraction;
    if (tokenGrowth < this.config.tokensBetweenUpdates) {
      return false;
    }

    // Tool call threshold OR no pending tool calls in last turn
    return this.state.toolCallsSinceLastExtraction >= this.config.toolCallsBetweenUpdates;
  }

  incrementToolCalls(count: number): void {
    this.state.toolCallsSinceLastExtraction += count;
  }

  /**
   * Mark extraction as started. The caller (SessionMemoryHook) is responsible
   * for actually running the forked agent and calling `completeExtraction`.
   */
  startExtraction(currentTokenCount: number, lastMessageId?: string): void {
    this.state.extractionStartedAt = Date.now();
    this.state.tokensAtLastExtraction = currentTokenCount;
    this.state.toolCallsSinceLastExtraction = 0;
    this.state.lastSummarizedMessageId = lastMessageId ?? this.state.lastSummarizedMessageId;
    this.extractionInProgress = true;
  }

  async completeExtraction(memoryContent: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.config.storagePath), { recursive: true });
      await fs.writeFile(this.config.storagePath, memoryContent, 'utf-8');
    } finally {
      this.extractionInProgress = false;
      this.state.extractionStartedAt = undefined;
    }
  }

  async getMemory(): Promise<SessionMemoryContent | undefined> {
    if (this.cleared) return undefined;
    try {
      const text = await fs.readFile(this.config.storagePath, 'utf-8');
      if (!text || text.trim() === SESSION_MEMORY_TEMPLATE.trim()) {
        return undefined;
      }
      return {
        text,
        lastExtractedAt: Date.now(),
        lastExtractedTokenCount: this.state.tokensAtLastExtraction,
        estimatedTokens: Math.ceil(text.length / BYTES_PER_TOKEN),
      };
    } catch {
      return undefined;
    }
  }

  async waitForExtraction(timeoutMs = 15_000): Promise<void> {
    if (!this.extractionInProgress || !this.extractionPromise) return;

    // Don't wait if extraction is stale (>60s)
    if (this.state.extractionStartedAt && Date.now() - this.state.extractionStartedAt > 60_000) {
      return;
    }

    await Promise.race([
      this.extractionPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  setExtractionPromise(promise: Promise<void>): void {
    this.extractionPromise = promise;
  }

  async clear(): Promise<void> {
    this.cleared = true;
    this.state = {
      tokensAtLastExtraction: 0,
      sessionMemoryInitialized: false,
      toolCallsSinceLastExtraction: 0,
    };
    this.extractionInProgress = false;
    this.extractionPromise = null;
    try {
      await fs.unlink(this.config.storagePath);
    } catch {
      // File may not exist — the in-memory `cleared` flag prevents stale reads regardless
    }
  }

  getLastSummarizedMessageId(): string | undefined {
    return this.state.lastSummarizedMessageId;
  }

  getCurrentTemplate(): string {
    return SESSION_MEMORY_TEMPLATE;
  }
}
