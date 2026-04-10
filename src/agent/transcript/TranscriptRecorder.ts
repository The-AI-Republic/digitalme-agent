import crypto from 'node:crypto';
import { mkdir, appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { generateId, type Message } from '../../models/ModelClient.js';
import type {
  ITranscriptRecorder,
  TranscriptEntry,
  MessageEntry,
  RecordMessageOpts,
} from './types.js';

const MAX_TRANSCRIPT_READ_SIZE = 50 * 1024 * 1024; // 50 MB
const FLUSH_INTERVAL_MS = 100;
const MAX_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB

function conversationHash(conversationId: string): string {
  return crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 16);
}

/**
 * Per-file write queue that batches I/O.
 */
class FileWriteQueue {
  private buffer: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath: string) {}

  enqueue(line: string): Promise<void> {
    this.buffer.push(line);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
    // Return a promise that resolves after the next flush
    return this.scheduleFlush();
  }

  private async scheduleFlush(): Promise<void> {
    // Chain onto the current write
    const prev = this.writing;
    this.writing = prev.then(() => this.doFlush());
    return this.writing;
  }

  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Grab current buffer and reset
    const lines = this.buffer;
    this.buffer = [];

    const chunk = lines.join('');
    if (chunk.length > MAX_CHUNK_SIZE) {
      // Split into smaller pieces if needed (unlikely but safe)
      for (const line of lines) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, 'utf8');
      }
    } else {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, chunk, 'utf8');
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.doFlush();
  }
}

export class TranscriptRecorder implements ITranscriptRecorder {
  private readonly baseDir: string;
  private readonly writeQueues = new Map<string, FileWriteQueue>();
  /** Per-conversation last parent ID for chain tracking. */
  private readonly lastParentId = new Map<string, string | null>();
  /** Per-conversation dedup sets (message.id → true). Lazily loaded from disk. */
  private readonly messageSets = new Map<string, Set<string>>();
  /** Tracks whether dedup set has been loaded from disk for a conversation. */
  private readonly dedupLoaded = new Set<string>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.digital_me_agent', 'rollouts');
  }

  async recordMessage(
    conversationId: string,
    message: Message,
    opts?: RecordMessageOpts,
  ): Promise<void> {
    // Two-layer dedup: check if already recorded
    await this.ensureDedupLoaded(conversationId);
    const dedupSet = this.getOrCreateDedupSet(conversationId);
    if (dedupSet.has(message.id)) {
      return;
    }

    // Determine parentId
    let parentId: string | null;
    if (opts?.parentOverride !== undefined) {
      parentId = opts.parentOverride;
    } else {
      parentId = this.lastParentId.get(conversationId) ?? null;
    }

    const entry: MessageEntry = {
      type: 'message',
      conversationId,
      taskId: opts?.taskId,
      turnId: opts?.turnId,
      timestamp: message.timestamp ?? new Date().toISOString(),
      parentId,
      message,
      isSidechain: opts?.isSidechain,
      agentId: opts?.agentId,
      artifactRef: opts?.artifactRef,
    };

    const filePath = this.getFilePath(conversationId, opts?.isSidechain, opts?.agentId);
    await this.appendEntry(filePath, entry);

    // Advance parent cursor: tool results with parentOverride still advance the cursor
    this.lastParentId.set(conversationId, message.id);

    // Update dedup set
    dedupSet.add(message.id);
  }

  async recordLifecycleEvent(entry: TranscriptEntry): Promise<void> {
    // Lifecycle events do NOT advance the parent chain
    const filePath = this.getMainFilePath(entry.conversationId);
    await this.appendEntry(filePath, entry);
  }

  async insertMessageChain(
    conversationId: string,
    messages: Message[],
    isSidechain?: boolean,
    agentId?: string,
    startingParentId?: string | null,
  ): Promise<void> {
    await this.ensureDedupLoaded(conversationId);
    const dedupSet = this.getOrCreateDedupSet(conversationId);

    let currentParentId = startingParentId ?? this.lastParentId.get(conversationId) ?? null;
    const filePath = this.getFilePath(conversationId, isSidechain, agentId);

    for (const message of messages) {
      if (dedupSet.has(message.id)) {
        // Already recorded — skip but track as potential parent
        currentParentId = message.id;
        continue;
      }

      const entry: MessageEntry = {
        type: 'message',
        conversationId,
        timestamp: message.timestamp ?? new Date().toISOString(),
        parentId: currentParentId,
        message,
        isSidechain,
        agentId,
      };

      await this.appendEntry(filePath, entry);
      dedupSet.add(message.id);
      currentParentId = message.id;
    }

    // Update parent cursor
    if (currentParentId !== null) {
      this.lastParentId.set(conversationId, currentParentId);
    }
  }

  async loadTranscript(conversationId: string): Promise<{ messages: Message[]; leafId: string | null }> {
    const filePath = this.getMainFilePath(conversationId);

    // Safety: check file size before reading
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_TRANSCRIPT_READ_SIZE) {
        return { messages: [], leafId: null };
      }
    } catch {
      return { messages: [], leafId: null };
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return { messages: [], leafId: null };
    }

    // Parse JSONL into MessageEntry map, tracking line order for tiebreaking
    const entries = new Map<string, MessageEntry & { _lineIndex: number }>();
    const referencedParents = new Set<string>();
    let lineIndex = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message?.id && !entry.isSidechain) {
          entries.set(entry.message.id, { ...entry, _lineIndex: lineIndex } as MessageEntry & { _lineIndex: number });
          if (entry.parentId) {
            referencedParents.add(entry.parentId);
          }
        }
        lineIndex++;
      } catch {
        lineIndex++;
        // Tolerate malformed lines
        continue;
      }
    }

    if (entries.size === 0) {
      return { messages: [], leafId: null };
    }

    // Find the leaf: newest non-sidechain message that is not referenced as parentId.
    // Use line order as tiebreaker when timestamps match.
    let leaf: (MessageEntry & { _lineIndex: number }) | null = null;
    for (const entry of entries.values()) {
      if (!referencedParents.has(entry.message.id)) {
        if (!leaf || entry.timestamp > leaf.timestamp
            || (entry.timestamp === leaf.timestamp && entry._lineIndex > leaf._lineIndex)) {
          leaf = entry;
        }
      }
    }

    if (!leaf) {
      // All messages are referenced — pick the newest
      for (const entry of entries.values()) {
        if (!leaf || entry.timestamp > leaf.timestamp
            || (entry.timestamp === leaf.timestamp && entry._lineIndex > leaf._lineIndex)) {
          leaf = entry;
        }
      }
    }

    if (!leaf) {
      return { messages: [], leafId: null };
    }

    // Walk backwards via parentId
    const chain: MessageEntry[] = [];
    const seen = new Set<string>();
    let current: MessageEntry | undefined = leaf;

    while (current) {
      if (seen.has(current.message.id)) {
        // Cycle detected
        break;
      }
      seen.add(current.message.id);
      chain.push(current);
      if (!current.parentId) break;
      current = entries.get(current.parentId);
    }

    chain.reverse();

    // Recover orphaned parallel tool results
    const chainIds = new Set(chain.map(e => e.message.id));
    const assistantIds = new Set(
      chain.filter(e => e.message.role === 'assistant' && e.message.toolCalls)
        .map(e => e.message.id),
    );

    const orphans: MessageEntry[] = [];
    for (const entry of entries.values()) {
      if (chainIds.has(entry.message.id)) continue;
      if (entry.parentId && assistantIds.has(entry.parentId)) {
        orphans.push(entry);
      }
    }

    // Insert orphans after their shared parent
    if (orphans.length > 0) {
      for (const orphan of orphans) {
        const parentIndex = chain.findIndex(e => e.message.id === orphan.parentId);
        if (parentIndex >= 0) {
          // Find the last tool result after this parent
          let insertAt = parentIndex + 1;
          while (insertAt < chain.length && chain[insertAt].parentId === orphan.parentId) {
            insertAt++;
          }
          chain.splice(insertAt, 0, orphan);
          chainIds.add(orphan.message.id);
        }
      }
    }

    // Filter unresolved tool uses
    const toolResultCallIds = new Set(
      chain.filter(e => e.message.role === 'tool' && e.message.toolCallId)
        .map(e => e.message.toolCallId!),
    );

    const filteredChain = chain.filter(entry => {
      if (entry.message.role === 'assistant' && entry.message.toolCalls) {
        // Check if all tool calls have results
        const allResolved = entry.message.toolCalls.every(tc => toolResultCallIds.has(tc.id));
        return allResolved;
      }
      return true;
    });

    // Strip transcript metadata, return Message[]
    const messages: Message[] = filteredChain.map(entry => entry.message);

    // Interrupted turn detection: if last message is user, append synthetic continuation
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages.push({
        role: 'assistant',
        content: '[Session resumed — previous response was interrupted.]',
        id: generateId(),
        timestamp: new Date().toISOString(),
        synthetic: true,
      });
    }

    const leafId = filteredChain.length > 0
      ? filteredChain[filteredChain.length - 1].message.id
      : null;

    // Rebuild dedup set from loaded entries
    const dedupSet = this.getOrCreateDedupSet(conversationId);
    for (const entry of entries.values()) {
      dedupSet.add(entry.message.id);
    }
    this.dedupLoaded.add(conversationId);

    return { messages, leafId };
  }

  seedParentId(conversationId: string, leafId: string): void {
    this.lastParentId.set(conversationId, leafId);
  }

  // ----- Private helpers -----

  private getMainFilePath(conversationId: string): string {
    return path.join(this.baseDir, `${conversationHash(conversationId)}.jsonl`);
  }

  private getFilePath(conversationId: string, isSidechain?: boolean, agentId?: string): string {
    if (isSidechain && agentId) {
      const hash = conversationHash(conversationId);
      return path.join(this.baseDir, hash, 'subagents', `agent-${agentId}.jsonl`);
    }
    return this.getMainFilePath(conversationId);
  }

  private getOrCreateDedupSet(conversationId: string): Set<string> {
    let set = this.messageSets.get(conversationId);
    if (!set) {
      set = new Set();
      this.messageSets.set(conversationId, set);
    }
    return set;
  }

  private async ensureDedupLoaded(conversationId: string): Promise<void> {
    if (this.dedupLoaded.has(conversationId)) return;

    const filePath = this.getMainFilePath(conversationId);
    try {
      const content = await readFile(filePath, 'utf8');
      const dedupSet = this.getOrCreateDedupSet(conversationId);
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'message' && entry.message?.id) {
            dedupSet.add(entry.message.id);
          }
        } catch {
          continue;
        }
      }
    } catch {
      // File doesn't exist yet — that's fine
    }

    this.dedupLoaded.add(conversationId);
  }

  private getOrCreateQueue(filePath: string): FileWriteQueue {
    let queue = this.writeQueues.get(filePath);
    if (!queue) {
      queue = new FileWriteQueue(filePath);
      this.writeQueues.set(filePath, queue);
    }
    return queue;
  }

  private async appendEntry(filePath: string, entry: unknown): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    const queue = this.getOrCreateQueue(filePath);
    await queue.enqueue(line);
  }
}
