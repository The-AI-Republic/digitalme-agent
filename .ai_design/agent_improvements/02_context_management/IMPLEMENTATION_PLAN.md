# Context Management

## Goal

Manage model-facing context growth and continuity across requests without changing the platform's canonical ownership of conversation history.

This track is about context pressure, projection, summarization, and recovery.

## Scope

In scope:

- tool result persistence (not truncation)
- microcompact
- session memory (continuous extraction)
- prompt projection
- reactive compact
- token thresholds
- preserved recent tail
- max output token recovery
- post-compact context re-injection

Out of scope:

- base system prompt construction
- prompt override/append semantics

Those belong in `01_prompt_management`.

## Current State

Today the relevant runtime pieces are:

- `src/agent/SessionState.ts` — two-tier history: `canonicalHistory` (platform-authoritative `HistoryMessage[]`) and `promptHistory` (extended `Message[]` with tool metadata). Reconciliation with platform via `reconcileWithPlatformHistory()`.
- `src/agent/TurnExecutor.ts` — ReAct loop that accumulates messages unboundedly during a turn. Token usage is tracked from model responses but never constrains context.
- `src/prompts/PromptComposer.ts` — static composition: system prompt + tool policy -> history -> user message. No dynamic filtering, pruning, or token awareness.
- `src/agent/SessionRuntime.ts` — orchestrates: reconcile -> execute turn -> commit results to both histories.
- `src/agent/SessionManager.ts` — lazy TTL-based eviction (default 30 min) and capacity-based eviction (default 1000 sessions). Eviction is fire-and-forget (`sessions.delete()`), no cleanup hooks.

### Current Gaps

| Aspect | Status |
|--------|--------|
| Token budget | Tracked but never constrains context |
| Context pruning | None — messages accumulate indefinitely within a turn |
| Summarization | None |
| Session memory | None |
| History truncation | `max_history_messages` configured (default 100) but not enforced |
| Tool result sizing | No filtering, truncation, or persistence |
| Model context window awareness | Not modeled |
| Max output token recovery | None — model truncation causes incomplete responses |
| Post-compact re-injection | N/A (no compaction exists) |

## Claudy Patterns Worth Borrowing

Claudy implements a graduated, multi-layer context management strategy. Below is a detailed analysis of each layer and how it maps to DigitalMe.

### Code Organization: Centralized Context Management

Claudy's context management is **not scattered across the agent loop** — it's organized into a dedicated `src/services/compact/` directory with clean interfaces:

```
src/services/compact/
├── microCompact.ts          # Lightweight: clears old tool results (no LLM)
├── apiMicrocompact.ts       # API-native context_management config
├── autoCompact.ts           # Triggers compaction at token thresholds
├── compact.ts               # Full summarization compaction (~60KB, complex)
├── sessionMemoryCompact.ts  # Session memory-based compaction
├── grouping.ts              # Groups messages for compaction units
├── prompt.ts                # Prompts for the compaction model
├── compactWarningState.ts   # UI warning suppression state
├── compactWarningHook.ts    # Hook for compact warnings
├── postCompactCleanup.ts    # Cleanup after compaction
├── timeBasedMCConfig.ts     # Time-based microcompact configuration
└── reactiveCompact.ts       # Emergency recovery on API overflow (feature-gated)
```

**Key architectural decision:** Context management is injected into the main query loop via a `QueryDeps` interface (`src/query/deps.ts`):

```typescript
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages   // ← context mgmt injection
  autocompact: typeof autoCompactIfNeeded     // ← context mgmt injection
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

This design provides:
1. **Testability** — tests inject fakes directly instead of module-level spies
2. **Separation of concerns** — query loop doesn't know compaction internals
3. **Single responsibility** — each file in `compact/` has one job

**Compaction hierarchy in Claudy:**

| Level | File | When | Cost |
|-------|------|------|------|
| 1. Microcompact | `microCompact.ts` | Before every API call | Zero (no LLM) |
| 2. Session Memory | `sessionMemoryCompact.ts` | At autocompact trigger | Zero at trigger (pre-extracted) |
| 3. Auto-compact | `autoCompact.ts` | When tokens > threshold | High (LLM summarization) |
| 4. Reactive compact | `reactiveCompact.ts` | On API overflow error | High (emergency LLM call) |

**DigitalMe adaptation:** Follow the same pattern — create `src/agent/context/` with:
- `TokenBudget.ts` — pressure assessment
- `Microcompact.ts` — cheap clearing
- `SessionMemory.ts` — continuous extraction
- `PromptProjector.ts` — context projection
- `ReactiveCompact.ts` — overflow recovery
- `index.ts` — exports and injection interface

Inject via a `ContextDeps` interface into `TurnExecutor` or `SessionRuntime`, same pattern as Claudy's `QueryDeps`.

### Pipeline Execution Order

Claudy runs these in a strict sequence each query loop iteration. Order matters — cheap passes run first, expensive ones only when needed:

```
1. Tool result budget      (per-result, after tool execution)
2. Microcompact            (pre-API-call, no LLM needed)
3. Autocompact             (pre-API-call, LLM summarization)
4. API call                (model inference)
5. Reactive compact        (post-API-call, on overflow error)
6. Max output recovery     (post-API-call, on output truncation)
```

Each layer has a one-shot guard to prevent infinite retry loops:
- Autocompact: `consecutiveFailures` counter, max 3
- Reactive compact: `hasAttemptedReactiveCompact` boolean, resets per turn
- Max output recovery: `maxOutputTokensRecoveryCount` counter, max 3

### Layer 1: Tool Result Persistence (cheapest, per-result)

**Claudy source:** `src/utils/toolResultStorage.ts`, `src/constants/toolLimits.ts`

**The problem:** Tool results can be huge — a file read returning 200K chars, or 5 parallel tool calls each returning 40K. All of that goes into the prompt.

**Claudy's approach — persist, not truncate:** When a tool result exceeds its threshold, the full content is **saved to a file on disk**. The model receives a preview (first 2KB, cut at a newline boundary) plus the file path. The model can read the full content back via its Read tool if needed. Nothing is lost.

Two enforcement levels:

**Per-tool persistence:** Each tool has a character threshold. Results exceeding the threshold are persisted to disk and replaced with a preview stub.

```
Result > tool threshold -> persist to disk -> replace with preview + filepath
```

Claudy thresholds:
- Default per-tool cap: 50,000 characters
- Hard ceiling: 400KB (100K tokens x 4 bytes/token)
- Each tool can declare its own lower limit
- Some tools opt out (e.g., Read — persisting a file read to disk that the model reads back is circular)

The preview stub format:
```
<persisted-output>
Output too large (195 KB). Full output saved to: /tmp/.../tool-results/abc123.txt

Preview (first 2 KB):
[first 2000 characters of the actual output]
...
</persisted-output>
```

**Per-message aggregate budget:** Even after individual results are handled, a single API message can contain many tool results from parallel tool calls. Claudy enforces a budget of 200,000 characters per message. If the total exceeds the budget, the **largest results are replaced first** until under budget.

**File cleanup:** Claudy persists to `~/.claude/projects/<path>/<session-id>/tool-results/`. Cleanup runs as an in-process `setTimeout` (10 min after startup, deferred if user is active). Files older than 30 days are deleted. This is opportunistic — if the session is short, a future session's housekeeping cleans up.

**DigitalMe adaptation:** We should persist to disk, same as Claudy. Key differences:

- Persist to a session-scoped temp directory (e.g., `/tmp/digitalme-agent/<conversation-id>/tool-results/`)
- Clean up on session eviction — `SessionManager` should call a cleanup hook when deleting a session, not rely on background sweeps
- The agent already has file-reading tools, so the model can retrieve full results when needed
- Simpler than Claudy: no cache stability concerns (frozen IDs, byte-identical replay), no GrowthBook feature flags

### Layer 2: Microcompact (cheap, pre-API-call)

**Claudy source:** `src/services/compact/microCompact.ts`

Claudy's microcompact runs before every API call. It's a pure message-rewriting pass — no LLM call, no expensive I/O.

**Two microcompact strategies in Claudy:**

1. **Cached Microcompact** (primary, for Anthropic internal users):
   - Uses Claude API's `cache_edits` feature to delete tool results from server-side cache
   - Does NOT modify local message content — sends `cache_edits` directives to the API
   - Preserves the cached prompt prefix (saves money on cache misses)
   - Triggered when tool count exceeds a threshold, keeps N most recent

2. **Time-based Microcompact** (fallback):
   - Triggers when gap since last assistant message exceeds threshold (default 60 min)
   - Actually replaces tool result content with `'[Old tool result content cleared]'`
   - Used when server cache is presumed cold anyway (so no benefit to cache editing)

**Which tools get compacted** (from `microCompact.ts:41-50`):
```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

**Key insight:** This is the cheapest way to reclaim context tokens. When a fan returns after a gap, old tool results from earlier turns are dead weight.

**DigitalMe adaptation:** Use the time-based strategy only (we don't have Claude's cache_edits API):

- Clear tool result content for messages older than a configurable gap
- Preserve the N most recent tool results verbatim
- Replace cleared content with a marker like `'[Previous tool output cleared]'`
- Run this pass before prompt composition on every turn
- Define which tools are "compactable" (e.g., web search results, file reads)

### Layer 3: Session Memory (continuous extraction)

**Claudy source:** `src/services/SessionMemory/sessionMemory.ts`, `src/services/compact/sessionMemoryCompact.ts`

This is Claudy's most interesting innovation. Instead of generating a summary only at compaction time (expensive, lossy, one-shot), Claudy **continuously extracts structured notes** as the conversation progresses.

**How extraction works:**
- Runs in background after model responses, every ~5,000 tokens or 3 tool calls
- Uses a forked agent that shares prompt cache (cheap, non-blocking)
- The forked agent is given Edit-tool access to the session memory file
- Only extracts when there are no pending tool calls (safe point)
- Does not block the main conversation

**Storage format:** Structured markdown file with sections:
1. Session Title
2. Current State — active work, pending tasks, next steps
3. Task Specification — what was asked, design decisions
4. Files and Functions — important files, relevance
5. Workflow — commands, output interpretation
6. Errors and Corrections — encountered errors, fixes, failed approaches
7. Codebase and System Documentation
8. Learnings — what worked, what didn't
9. Key Results — exact output requested
10. Worklog — terse step-by-step summary

**Size management:** Per-section limit of 2,000 tokens, total file limit of 12,000 tokens.

**How it's used at compaction time:**
- When autocompact triggers, Claudy tries session memory compaction **first**
- If session memory exists and has content, it's used as the summary — **no LLM call needed at compaction time**
- Messages after the `lastSummarizedMessageId` boundary are preserved verbatim
- Falls back to traditional LLM summarization if session memory is empty or invalid

**Benefits over one-shot summarization:**

| Aspect | Session Memory | One-Shot Summary |
|--------|---------------|-----------------|
| Cost at compaction | Zero (pre-extracted) | Expensive LLM call |
| Latency at compaction | None | Blocks on API call |
| Fidelity | Incremental, captured in context | One-shot compression, lossy |
| Update frequency | Every 5K tokens | Only at compaction boundary |

**DigitalMe adaptation:** This maps very well to public-facing agent conversations. A session memory for a fan conversation would capture:

1. **Fan Profile** — name, preferences, interests learned so far
2. **Relationship Context** — tone, familiarity level, inside jokes
3. **Key Facts Exchanged** — information shared by either side
4. **Ongoing Topics** — active discussion threads, unresolved questions
5. **Agent Commitments** — promises or follow-ups the agent committed to
6. **Conversation Worklog** — terse summary of conversation flow

For DigitalMe, extraction would be triggered after each turn completion (not mid-turn, since our turns are shorter than Claudy's multi-tool-call loops). We can use the main model or a cheaper model for extraction. Storage would be in-memory on `SessionState` (not disk — our sessions are ephemeral).

### Layer 4: Auto-Compact / Summarization (expensive, LLM-powered)

**Claudy source:** `src/services/compact/autoCompact.ts`, `compact.ts`, `prompt.ts`

When context exceeds the autocompact threshold and session memory compaction is unavailable, Claudy generates a full AI summary.

**Threshold calculation** (from `autoCompact.ts`):
```typescript
// Reserve this many tokens for output during compaction
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return contextWindow - reservedTokensForSummary
}

// Buffer constants
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
}
```

So for a 200K context window model:
- Effective window: 200K - 20K (output reserve) = 180K
- Autocompact triggers at: 180K - 13K = 167K tokens

**Circuit breaker** (from `autoCompact.ts:70`):
```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

This stops retrying after 3 consecutive failures. The comment explains why:
> BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272) in a single session, wasting ~250K API calls/day globally.

**Summarization prompt:** The LLM is instructed to:
- Analyze chronologically
- Capture: primary request, key concepts, files/code, errors/fixes, all user messages, pending tasks, current work
- Output an `<analysis>` scratchpad block (stripped from final summary) followed by a `<summary>` block
- Explicitly forbidden from calling any tools (NO_TOOLS_PREAMBLE)

**Post-compact attachment recovery:** After summarization, Claudy re-injects context the model needs that the summary may not capture:
- Recently-read files (top 5 most accessed) — bounded by 50K token budget
- Active plans and skills — bounded by 25K token budget
- Tool schema re-announcements (since summary doesn't preserve tool_reference blocks)
- Session start hook results (CLAUDE.md re-injection, etc.)

**DigitalMe adaptation:**
- Summarization prompt must be tailored for conversational agents: capture relationship, tone, facts, commitments — not code state and file changes
- Post-compact re-injection should include: agent persona/character prompt, active tool definitions, any character-specific context
- Use a cheaper/faster model for summarization when configured (cost-sensitive for self-hosted creators)
- If session memory is implemented (Layer 3), this becomes a fallback path — session memory compaction is preferred

### Layer 5: Reactive Compact (emergency, post-API-error)

**Claudy source:** `src/query.ts` (error recovery pipeline)

When the model API returns a "prompt too long" error (413), Claudy attempts recovery:

**Recovery cascade:**
1. **Context collapse drain** (cheap) — release staged collapses, retry
2. **Reactive compact** (expensive) — full summarization + retry once
3. **Surface error** — if both fail, yield the error to the user

**One-shot guard:** `hasAttemptedReactiveCompact: boolean` — set to `true` after first attempt, prevents infinite loops. Resets to `false` at the start of each new turn (tool execution cycle).

**DigitalMe adaptation:** Same two-step pattern:
1. Force an aggressive compact (summarize everything except last 2-3 messages)
2. Retry the API call once
3. If still failing, return an error event to the fan via SSE

### Layer 6: Max Output Token Recovery

**Claudy source:** `src/query.ts` (lines 1188-1256)

When the model hits its output token limit mid-response, Claudy recovers:

**Stage 1 — Escalation:** If using the capped 8K default, retry with 64K max output tokens.

**Stage 2 — Continuation:** Inject a recovery message and retry (up to 3 times):
```
"Output token limit hit. Resume directly — no apology, no recap of what
you were doing. Pick up mid-thought if that is where the cut happened.
Break remaining work into smaller pieces."
```

**Stage 3 — Give up:** After 3 attempts, surface the truncated response.

**DigitalMe adaptation:** Directly applicable. The agent might generate long responses (creative content, detailed explanations). Recovery steps:
1. If using a capped output default, escalate to the model's max
2. Inject a continuation prompt and retry (max 2 attempts — shorter limit than Claudy since fan-facing responses should be concise)
3. After retries, return what we have

### Token Counting Strategy

**Claudy approach:** `src/utils/tokens.ts`

Hybrid strategy:
- **Rough estimation:** `Math.round(content.length / bytesPerToken)` where `bytesPerToken` = 4 (2 for JSON)
- **API-grounded tracking:** After each API response, actual token usage is the baseline. New messages since the last API call are estimated and added.
- **Conservative padding:** Estimates multiplied by 1.33 for safety margin

**DigitalMe adaptation:** We receive `TokenUsage` from all our model providers (OpenAI, Google, etc.). Same hybrid approach:
- Actual usage from last response + estimation for new content
- Character-length / 4 as rough estimator
- 1.33x safety margin on estimates

## Target Design for DigitalMe Agent

### Threshold Bands

Three thresholds, not one boolean:

| Band | Trigger | Action |
|------|---------|--------|
| **Microcompact** | `estimatedTokens > contextWindow * 0.5` | Clear old tool results |
| **Projection** | `estimatedTokens > contextWindow * 0.7` | Use session memory / summarize older messages, project context |
| **Overflow** | `estimatedTokens > contextWindow * 0.9` | Aggressive compact + retry |

These ratios should be configurable and tuned per model. Models with smaller context windows (e.g., 8K) need more aggressive thresholds than 128K models.

### Pipeline Execution Order

Strict sequence per turn, matching Claudy's proven ordering:

```
1. Tool result persistence     run after each tool execution (within turn)
2. Microcompact                run before prompt composition (start of turn)
3. Token pressure assessment   determine which band we're in
4. Session memory compaction   if pressure >= 'projection' and memory available
5. Full summarization          if pressure >= 'projection' and no session memory
6. Prompt projection           build model-facing context
7. API call                    model inference
8. Reactive compact            on overflow error from API (one-shot guard)
9. Max output recovery         on output truncation (up to 2 retries)
```

Guards against infinite loops:
- Reactive compact: `hasAttemptedReactiveCompact` boolean, one attempt per turn
- Max output recovery: `maxOutputRecoveryCount` counter, max 2
- Autocompact: `consecutiveCompactFailures` counter, max 3

### New Modules

#### `src/agent/TokenBudget.ts`

Estimates prompt pressure and compares against threshold bands.

```typescript
interface TokenBudgetConfig {
  contextWindowSize: number;        // From model config
  microcompactRatio: number;        // Default: 0.5
  projectionRatio: number;          // Default: 0.7
  overflowRatio: number;            // Default: 0.9
  maxOutputTokens: number;          // Reserved for model output
  safetyMargin: number;             // Default: 1.33
}

type PressureBand = 'nominal' | 'microcompact' | 'projection' | 'overflow';

class TokenBudget {
  constructor(config: TokenBudgetConfig);

  // Estimate tokens for a message array
  estimateTokens(messages: Message[], lastKnownUsage?: TokenUsage): number;

  // Determine which pressure band we're in
  assessPressure(messages: Message[], lastKnownUsage?: TokenUsage): PressureBand;

  // Get effective context window (total - output reservation)
  getEffectiveWindow(): number;
}
```

Token estimation algorithm:
1. If `lastKnownUsage` available: use `inputTokens + outputTokens` as baseline for messages up to the last API call
2. For messages added after the last API call: estimate via `content.length / 4`
3. Multiply estimate portion by `safetyMargin`
4. Return `baseline + paddedEstimate`

#### `src/agent/ToolResultPersistence.ts`

Persists large tool results to disk, replaces with preview + filepath.

```typescript
interface ToolResultPersistenceConfig {
  defaultMaxResultChars: number;       // Default: 10,000
  perToolThresholds?: Record<string, number>;  // Tool-specific overrides
  perMessageBudgetChars: number;       // Default: 30,000
  previewSizeBytes: number;            // Default: 2,000
  storageDir: string;                  // Base directory for persisted results
}

class ToolResultPersistence {
  constructor(config: ToolResultPersistenceConfig);

  // Persist a single tool result if over threshold, return preview stub
  processResult(toolName: string, toolCallId: string, content: string): Promise<string>;

  // Enforce aggregate budget across all tool results in a message
  enforceMessageBudget(messages: Message[]): Promise<Message[]>;

  // Clean up persisted files for a conversation
  cleanup(conversationId: string): Promise<void>;
}
```

Persisted file structure:
```
<storageDir>/<conversationId>/tool-results/<toolCallId>.txt
```

Preview stub format:
```
<persisted-output>
Output too large (195 KB). Full output saved to: /tmp/.../abc123.txt

Preview (first 2 KB):
[first 2000 characters, cut at newline boundary]
...
</persisted-output>
```

Cleanup is called by `SessionManager` on session eviction — no background sweep needed.

#### `src/agent/Microcompact.ts`

Clears stale tool results without an LLM call.

```typescript
interface MicrocompactConfig {
  gapThresholdMinutes: number;   // Default: 60
  keepRecentResults: number;     // Default: 5
  clearedMarker: string;         // Default: '[Previous tool output cleared]'
}

class Microcompact {
  constructor(config: MicrocompactConfig);

  // Rewrite messages: clear old tool results, preserve recent ones
  compact(messages: Message[]): MicrocompactResult;
}

interface MicrocompactResult {
  messages: Message[];
  tokensFreed: number;     // Estimated tokens reclaimed
  resultsCleared: number;  // Number of tool results cleared
}
```

Algorithm:
1. Walk messages from newest to oldest
2. Count tool-role messages encountered
3. For tool messages beyond `keepRecentResults`: if the preceding assistant message is older than `gapThresholdMinutes`, replace content with `clearedMarker`
4. Estimate tokens freed from cleared content
5. Return rewritten messages + stats

#### `src/agent/SessionMemory.ts`

Continuously extracts structured conversation notes for use at compaction time.

```typescript
interface SessionMemoryConfig {
  enabled: boolean;
  extractionModel?: string;          // null = use main model
  tokensBetweenUpdates: number;      // Default: 5,000
  maxTotalTokens: number;            // Default: 8,000
  maxSectionTokens: number;          // Default: 1,500
}

class SessionMemory {
  constructor(config: SessionMemoryConfig, modelClient: ModelClient);

  // Check if extraction should run based on token growth
  shouldExtract(currentTokenCount: number): boolean;

  // Extract/update memory from conversation messages
  extract(messages: Message[]): Promise<void>;

  // Get current memory content for use in compaction
  getMemory(): SessionMemoryContent | undefined;

  // Clear memory (e.g., on session reseed)
  clear(): void;
}

interface SessionMemoryContent {
  text: string;
  lastExtractedAt: number;
  lastExtractedTokenCount: number;
  estimatedTokens: number;
}
```

Memory template sections (tailored for fan-facing conversations):
1. **Fan Profile** — name, preferences, interests
2. **Relationship Context** — tone, familiarity, inside references
3. **Key Facts** — information exchanged by either side
4. **Ongoing Topics** — active discussions, unresolved questions
5. **Agent Commitments** — promises, follow-ups
6. **Conversation Flow** — terse summary of how the conversation progressed

Extraction prompt instructs the model to:
- Update only sections with new information (don't rewrite unchanged sections)
- Keep entries concise (facts, not prose)
- Preserve the fan's voice/phrasing for key quotes
- Flag emotional shifts or tone changes

#### `src/agent/ConversationSummaryBuilder.ts`

Generates a full summary when session memory is unavailable. Fallback path.

```typescript
interface SummaryConfig {
  summaryModel?: string;              // Separate model for summarization (cheaper)
  maxSummaryTokens: number;           // Default: 2,000
  preserveRecentMessages: number;     // Default: 10
  summaryPromptTemplate: string;      // Tailored for conversational agents
}

class ConversationSummaryBuilder {
  constructor(config: SummaryConfig, modelClient: ModelClient);

  // Generate summary of messages[0..cutoffIndex]
  summarize(messages: Message[], cutoffIndex: number): Promise<ConversationSummary>;
}

interface ConversationSummary {
  text: string;
  coversMessageCount: number;   // How many messages this summary covers
  generatedAt: number;          // Timestamp
  estimatedTokens: number;      // Token estimate of the summary itself
}
```

Summary prompt captures:
- Key facts and information exchanged
- Relationship context and emotional tone
- Ongoing topics and unresolved questions
- Fan preferences and interests
- Agent commitments and promises
- Uses `<analysis>` scratchpad (stripped) + `<summary>` output (kept), same as Claudy

#### `src/agent/PromptProjector.ts`

Derives the model-facing message array from raw history + summary/memory.

```typescript
interface ProjectionConfig {
  tokenBudget: TokenBudget;
  recentTailMinMessages: number;    // Default: 6
  recentTailMaxTokens: number;      // Default: varies by model
}

class PromptProjector {
  constructor(config: ProjectionConfig);

  // Build projected context from components
  project(components: ProjectionInput): Message[];
}

interface ProjectionInput {
  systemPrompt: string;
  summary?: ConversationSummary;
  sessionMemory?: SessionMemoryContent;
  fullHistory: Message[];
  latestUserMessage: string;
  lastKnownUsage?: TokenUsage;
}
```

Projection algorithm:
1. Start with system prompt message
2. If session memory or summary exists: insert as a context block
3. Determine recent tail: walk backwards from end of `fullHistory` until either `recentTailMinMessages` are included or token estimate reaches budget
4. Append recent tail messages verbatim
5. Append latest user message
6. Verify total estimate is under effective window; if not, shrink recent tail

Output structure:
```
[system: persona + tool policy]
[user: "Context from earlier conversation:\n{memory or summary}"]
[...recent tail messages...]
[user: latest message]
```

Session memory is preferred over summary when both exist (higher fidelity, zero cost).

#### `src/agent/PostCompactRecovery.ts`

Re-injects context that compaction may have stripped.

```typescript
interface PostCompactRecoveryConfig {
  maxRecoveryTokens: number;    // Default: 10,000
}

class PostCompactRecovery {
  constructor(config: PostCompactRecoveryConfig);

  // Build recovery messages to inject after compaction
  buildRecoveryMessages(context: RecoveryContext): Message[];
}

interface RecoveryContext {
  personaPrompt: string;           // Agent's character/persona
  activeToolDefinitions: string[]; // Currently available tools
  characterContext?: string;       // Additional character-specific context
}
```

After compaction, re-inject:
- Agent persona/character prompt (the summary may not preserve personality nuances)
- Active tool definitions (so the model knows what tools are available)
- Any character-specific context (catchphrases, style guides, etc.)

This is simpler than Claudy's version (which re-injects files, plans, skills) because our agent's critical context is the persona, not code files.

#### `src/agent/ReactiveCompact.ts`

Emergency recovery when the model API returns a context overflow error.

```typescript
interface ReactiveCompactConfig {
  maxRetries: number;                   // Default: 1
  aggressivePreserveMessages: number;   // Default: 3
}

class ReactiveCompact {
  constructor(
    config: ReactiveCompactConfig,
    summaryBuilder: ConversationSummaryBuilder,
    projector: PromptProjector,
    postCompactRecovery: PostCompactRecovery,
  );

  // Attempt aggressive compaction and retry
  recover(
    messages: Message[],
    lastKnownUsage: TokenUsage | undefined,
    systemPrompt: string,
  ): Promise<ReactiveCompactResult>;
}

interface ReactiveCompactResult {
  messages: Message[];
  summary: ConversationSummary;
  succeeded: boolean;
}
```

Algorithm:
1. Summarize everything except the last `aggressivePreserveMessages`
2. Rebuild projected context with the aggressive summary
3. Apply post-compact recovery (re-inject persona)
4. If projected context still exceeds overflow threshold, truncate the summary itself
5. Return compacted messages for retry

#### `src/agent/MaxOutputRecovery.ts`

Handles model output truncation with continuation retries.

```typescript
interface MaxOutputRecoveryConfig {
  maxRetries: number;              // Default: 2
  escalatedMaxTokens?: number;    // Default: model's max
  continuationPrompt: string;
}

class MaxOutputRecovery {
  constructor(config: MaxOutputRecoveryConfig);

  // Check if a model response was truncated
  isTruncated(result: ModelStepResult): boolean;

  // Build continuation message for retry
  buildContinuationMessage(): Message;

  // Get escalated max output tokens (if applicable)
  getEscalatedMaxTokens(): number | undefined;
}
```

Default continuation prompt:
```
"Output token limit hit. Resume directly — no apology, no recap.
Pick up mid-thought if that is where the cut happened.
Keep your response concise."
```

### Existing Files To Change

#### `src/agent/SessionState.ts`

Add session memory and summary storage:

```typescript
class SessionState {
  private canonicalHistory: HistoryMessage[];
  private promptHistory: Message[];
  private summary?: ConversationSummary;           // NEW
  private sessionMemory?: SessionMemoryContent;     // NEW

  // NEW: session memory
  getSessionMemory(): SessionMemoryContent | undefined;
  setSessionMemory(memory: SessionMemoryContent): void;

  // NEW: conversation summary
  getSummary(): ConversationSummary | undefined;
  setSummary(summary: ConversationSummary): void;

  // CHANGE: reconcileWithPlatformHistory should clear both on reseed
  // CHANGE: clear summary and memory on reseed (they may not match reseeded history)
}
```

#### `src/agent/TurnExecutor.ts`

Integrate context management into the ReAct loop:

```
Before the loop:
  1. Run microcompact on incoming history
  2. Check pressure band
  3. If pressure >= 'projection': use session memory or generate summary, project context
  4. Build initial messages via projector instead of raw composer

Inside the loop, after each tool result:
  1. Persist large tool results (ToolResultPersistence.processResult)
  2. Re-check pressure band
  3. If pressure hits 'overflow' mid-turn: run reactive compact

On model API error (context overflow):
  1. If not already attempted reactive compact: recover and retry
  2. If already attempted: emit error event

On model output truncation:
  1. If escalation available: retry with higher max output tokens
  2. Else if retries remaining: inject continuation message and retry
  3. Else: return what we have
```

#### `src/agent/SessionManager.ts`

Add cleanup hook on session eviction:

```typescript
private evictExpiredSessions() {
  // ... existing logic ...
  if (runtime.state.getLastAccessedAt() < cutoff) {
    this.cleanupSession(conversationId, runtime);  // NEW: cleanup before delete
    this.sessions.delete(conversationId);
  }
}

private async cleanupSession(conversationId: string, runtime: SessionRuntime) {
  // Clean up persisted tool result files
  await this.toolResultPersistence?.cleanup(conversationId);
}
```

#### `src/agent/SessionRuntime.ts`

Orchestrate session memory extraction after turn completion:

```typescript
async execute(submission, events) {
  // ... existing reconcile + execute ...

  // After successful turn completion:
  if (this.sessionMemory?.shouldExtract(currentTokenCount)) {
    // Non-blocking: extract in background, don't block response to fan
    void this.sessionMemory.extract(this.state.getPromptHistory());
  }
}
```

#### `src/prompts/PromptComposer.ts`

The composer's role narrows — it handles system prompt assembly while `PromptProjector` handles history projection. The `compose()` method may be refactored or the projector may wrap the composer.

#### `src/config/schema.ts`

Add context management configuration:

```yaml
context:
  context_window_size: 128000        # Model's context window
  max_output_tokens: 4096            # Reserved for output
  microcompact:
    enabled: true
    gap_threshold_minutes: 60
    keep_recent_results: 5
  tool_result_persistence:
    enabled: true
    default_max_result_chars: 10000
    per_message_budget_chars: 30000
    preview_size_bytes: 2000
    storage_dir: /tmp/digitalme-agent
  session_memory:
    enabled: true
    extraction_model: null            # null = use main model
    tokens_between_updates: 5000
    max_total_tokens: 8000
  projection:
    recent_tail_min_messages: 6
  summary:
    enabled: true
    model: null                       # null = use main model
    max_summary_tokens: 2000
    preserve_recent_messages: 10
  thresholds:
    microcompact_ratio: 0.5
    projection_ratio: 0.7
    overflow_ratio: 0.9
  reactive_compact:
    max_retries: 1
    aggressive_preserve_messages: 3
  max_output_recovery:
    max_retries: 2
```

### Types

#### `src/agent/types/context.ts` (new file)

```typescript
export type PressureBand = 'nominal' | 'microcompact' | 'projection' | 'overflow';

export interface ConversationSummary {
  text: string;
  coversMessageCount: number;
  generatedAt: number;
  estimatedTokens: number;
}

export interface SessionMemoryContent {
  text: string;
  lastExtractedAt: number;
  lastExtractedTokenCount: number;
  estimatedTokens: number;
}

export interface MicrocompactResult {
  messages: Message[];
  tokensFreed: number;
  resultsCleared: number;
}

export interface ReactiveCompactResult {
  messages: Message[];
  summary: ConversationSummary;
  succeeded: boolean;
}

export interface ProjectionInput {
  systemPrompt: string;
  summary?: ConversationSummary;
  sessionMemory?: SessionMemoryContent;
  fullHistory: Message[];
  latestUserMessage: string;
  lastKnownUsage?: TokenUsage;
}
```

## Proposed Runtime Model

### Data Flow

```
Platform sends turn request
  |
SessionRuntime.execute()
  |-- reconcileWithPlatformHistory()
  |-- state.getPromptHistory() -> raw history
  |
  |-- ToolResultPersistence.enforceMessageBudget()  << Layer 1: persist large results
  |
  |-- Microcompact.compact(history)                 << Layer 2: clear stale tool results
  |     '-- if gap > threshold: clear old results
  |
  |-- TokenBudget.assessPressure(history)            << Check pressure band
  |     |-- 'nominal' -> use history as-is
  |     |-- 'microcompact' -> already handled above
  |     |-- 'projection' -> compact + project (below)
  |     '-- 'overflow' -> aggressive compact before starting
  |
  |-- [if projection needed]:
  |     |-- SessionMemory.getMemory()                << Try session memory first (free)
  |     |-- ConversationSummaryBuilder.summarize()   << Fallback: LLM summary (expensive)
  |     '-- PostCompactRecovery.buildRecoveryMessages()  << Re-inject persona
  |
  |-- PromptProjector.project({                      << Layer 3: build model-facing context
  |     systemPrompt, memory/summary, history, userMessage
  |   })
  |     '-- [system] + [context?] + [recent tail] + [user message]
  |
  |-- TurnExecutor.run(projectedMessages)            << Execute with projected context
  |     |-- model.generate(messages)
  |     |-- tool execution -> ToolResultPersistence.processResult()
  |     |-- re-assess pressure after each tool cycle
  |     |-- on overflow error -> ReactiveCompact.recover()   << Layer 4: emergency
  |     '-- on output truncation -> MaxOutputRecovery        << Layer 5: continuation
  |
  |-- [post-turn]:
  |     |-- SessionMemory.extract() if shouldExtract()       << Background extraction
  |     '-- state.setSummary() if summary was generated
  |
  '-- state.commitTask()
```

### Canonical History

- Platform-owned source of truth
- Never replaced by local summary or session memory
- Never modified by compaction — compaction only affects the projected view
- Reseeding from platform clears local summary and session memory

### Session Memory

- Local derived state stored in `SessionState`
- Continuously extracted after turns (non-blocking)
- Preferred over one-shot summary at compaction time (zero cost, higher fidelity)
- Cleared on platform reseed
- Not persisted across agent restarts (sessions are ephemeral per TTL)

### Conversation Summary

- Generated on-demand when session memory is unavailable and context pressure requires compaction
- Fallback path — session memory compaction is preferred
- Cleared on platform reseed

### Projected Prompt Context

What the model actually sees:

```
[System prompt with persona + tool policy]
[Context from earlier conversation]         << session memory or summary, only when pressure >= 'projection'
[Recent messages preserved verbatim]        << always: last N messages
[Latest user message]                       << always: the current turn's input
```

## Key Differences from Claudy

| Aspect | Claudy | DigitalMe | Rationale |
|--------|--------|-----------|-----------|
| Cache stability | Critical — frozen IDs, byte-identical replay, cache edits | Not needed | DM uses OpenAI-compatible APIs, no prompt caching |
| Tool result persistence | Disk-based, 30-day cleanup via background sweep | Disk-based, cleanup on session eviction | DM sessions are ephemeral (30 min TTL), deterministic cleanup |
| Feature flags | GrowthBook-gated, A/B tested | Config-driven | DM is self-hosted by creators, not a SaaS product |
| Post-compact recovery | Re-inject files, plans, skills | Re-inject persona, tool definitions | DM is a conversational agent, not a coding agent |
| Summary content | Code state, file changes, task progress | Relationship, topics, tone, facts, commitments | Fan conversations vs. coding sessions |
| Session memory sections | Files, workflow, errors, codebase docs | Fan profile, relationship, key facts, ongoing topics | Conversational context vs. code context |
| Summarization model | Same model (always Claude) | Configurable (can use cheaper model) | Cost-sensitive for self-hosted creators |
| Max output recovery | 3 retries, escalation from 8K to 64K | 2 retries, escalation from configured default | Fan responses should be concise, fewer retries needed |
| Pipeline complexity | 6+ layers with context collapse, history snip | 5 layers (sufficient for conversational workload) | Simpler is better for self-hosted reliability |

## Suggested Implementation Sequence

### Step 1: TokenBudget and ToolResultPersistence

The foundation — nothing else works without token awareness and safe tool result handling.

Files:
- new `src/agent/types/context.ts`
- new `src/agent/TokenBudget.ts`
- new `src/agent/ToolResultPersistence.ts`
- update `src/config/schema.ts` (add context config)
- update `src/agent/TurnExecutor.ts` (persist tool results after each tool execution)
- update `src/agent/SessionManager.ts` (cleanup on eviction)

Test cases:
- Token estimation accuracy against known message sizes
- Pressure band boundaries at each threshold ratio
- Tool result persisted when over threshold, preview returned
- Per-message budget enforcement (largest results persisted first)
- Persisted files cleaned up on session eviction
- Model can read back persisted results via file-read tool
- Edge cases: empty content, very small messages, persistence failure (original returned)

### Step 2: Microcompact

Cheap context reduction that runs before every turn.

Files:
- new `src/agent/Microcompact.ts`
- update `src/agent/TurnExecutor.ts` (or `SessionRuntime.ts`) to run microcompact before composition

Test cases:
- Tool results cleared after gap threshold
- Recent N results preserved regardless of gap
- No changes when gap is under threshold
- Correct token-freed estimation
- Messages without tool results pass through unchanged

### Step 3: Session Memory

Continuous extraction — the highest-value addition for conversational quality.

Files:
- new `src/agent/SessionMemory.ts`
- update `src/agent/SessionState.ts` (add memory storage)
- update `src/agent/SessionRuntime.ts` (trigger extraction after turns)

Test cases:
- Extraction triggers after configured token growth
- Memory captures key conversational elements (fan profile, facts, topics)
- Memory cleared on platform reseed
- Memory respects size limits (per-section and total)
- Extraction does not block turn response (non-blocking)
- `shouldExtract` returns false when token growth insufficient

### Step 4: Summary + PromptProjector + PostCompactRecovery

The projection logic that transforms raw history into bounded model-facing context. Summary is the fallback when session memory is unavailable.

Files:
- new `src/agent/ConversationSummaryBuilder.ts`
- new `src/agent/PromptProjector.ts`
- new `src/agent/PostCompactRecovery.ts`
- update `src/agent/SessionState.ts` (add summary storage)
- update `src/agent/SessionRuntime.ts` (orchestrate projection + summary updates)
- update `src/prompts/PromptComposer.ts` (narrow scope or integrate with projector)

Test cases:
- Projection uses session memory when available (preferred path)
- Projection falls back to summary when no session memory
- Projection omits context block when pressure is 'nominal'
- Recent tail sizing respects token budget
- Summary generation captures key conversational elements
- Post-compact recovery re-injects persona and tool definitions
- Summary cleared on platform reseed

### Step 5: ReactiveCompact + MaxOutputRecovery

Emergency recovery — the last safety nets.

Files:
- new `src/agent/ReactiveCompact.ts`
- new `src/agent/MaxOutputRecovery.ts`
- update `src/agent/TurnExecutor.ts` (catch errors, attempt recovery)

Test cases:
- Overflow error triggers aggressive compact + single retry
- Second overflow after reactive compact returns error event
- One-shot guard prevents infinite retry loops
- Max output truncation triggers escalation on first occurrence
- Continuation message injected on subsequent truncations
- Circuit breaker after max retries
- Recovery messages are concise and appropriate for fan-facing context

## Testing Strategy

All new modules should use dependency injection for testability, consistent with the agent's existing patterns (fake ModelClient, fake tools).

Key test patterns:
- **TokenBudget:** Pure unit tests with known message sizes
- **ToolResultPersistence:** Integration tests with temp directories, verify persist + read-back + cleanup
- **Microcompact:** Unit tests with crafted message sequences and timestamps
- **SessionMemory:** Integration tests with a fake ModelClient that returns canned extractions
- **ConversationSummaryBuilder:** Integration tests with a fake ModelClient that returns canned summaries
- **PromptProjector:** Unit tests verifying output structure at each pressure band
- **PostCompactRecovery:** Unit tests verifying persona and tool definition re-injection
- **ReactiveCompact:** Integration tests simulating overflow -> recovery flow
- **MaxOutputRecovery:** Unit tests for escalation, continuation, and circuit breaker
- **End-to-end:** TurnExecutor integration tests verifying the full pipeline under different pressure scenarios

## Risks

- **Over-compacting:** Aggressive summarization loses necessary recent details. Mitigation: always preserve a minimum recent tail, tune thresholds conservatively.
- **Summary drift:** Summary diverges from canonical history semantics over time. Mitigation: regenerate summary rather than incrementally updating; prefer session memory which is extracted with full context.
- **Session memory extraction cost:** LLM calls for extraction add latency and cost. Mitigation: extract in background (non-blocking), allow configuring a cheaper model, only extract after sufficient token growth.
- **Summarization cost:** LLM calls for summarization add latency and cost. Mitigation: session memory makes this the fallback path; allow configuring a cheaper model.
- **Threshold tuning:** Wrong thresholds cause either premature compaction (wasted quality) or late compaction (overflow errors). Mitigation: make thresholds configurable per model; start with conservative defaults.
- **Multi-model variance:** Different providers report token usage differently. Mitigation: safety margin in estimation; test with each provider.
- **Persistence disk pressure:** Large tool results accumulate on disk. Mitigation: deterministic cleanup on session eviction; configurable storage directory.
- **Persona loss after compaction:** Summary may not fully capture the agent's personality. Mitigation: PostCompactRecovery re-injects persona prompt explicitly.

## Success Criteria

- Prompt growth is bounded relative to model context window
- Recent context remains stable and understandable across compaction events
- Tool results are never silently lost — always persisted and retrievable
- Session memory captures key relationship and conversation context
- Overflow recovery is bounded (at most 1 retry) and testable
- Output truncation recovery works (at most 2 continuation retries)
- Token estimation is within 20% of actual usage
- No degradation in conversation quality for conversations under the projection threshold
- Persisted files are cleaned up deterministically on session eviction
- Summarization latency is acceptable (< 3 seconds with a fast model)
