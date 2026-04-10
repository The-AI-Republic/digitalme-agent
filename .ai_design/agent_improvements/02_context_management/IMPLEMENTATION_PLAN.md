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
- Clean up on session eviction via `SessionManager`, plus a startup sweep for orphaned directories from agent crashes
- **Prerequisite: track `03_tool_runtime` must provide a file-read tool** so the model can retrieve full persisted results when needed. The current tool registry only has `web_search` — without a file-read tool, persisted results are not recoverable by the model. Until track 03 delivers this tool, tool result persistence should use a larger preview size or skip persistence entirely (keeping results inline but truncated).
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

**Prerequisite: Forked Agent infrastructure (track `08_forked_and_subagents`).** Session memory extraction runs as a forked agent — a background agent instance that shares the parent's conversation context but executes independently without blocking the response to the fan. This mirrors Claudy's architecture exactly: after each turn, a `PostTurnHook` checks extraction thresholds and spawns a forked agent via `runForkedAgent()` with the session memory extraction prompt. The forked agent is restricted to only the Edit tool on the session memory storage, preventing interference with the main conversation.

For DigitalMe, extraction would be triggered after each turn completion via the `PostTurnHookRegistry` (not mid-turn, since our turns are shorter than Claudy's multi-tool-call loops). The forked agent can use the main model or a cheaper model for extraction. **Storage is on disk** at `/tmp/digitalme-agent/<conversation-id>/session-memory.md` (same pattern as Claudy), with tracking metadata in memory on the `SessionMemory` instance. See the `SessionMemory.ts` target design section for the full storage model.

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
- Post-compact re-injection is minimal: only character-specific context (as user-role messages). Agent persona is owned by `SystemPromptBuilder` (always present), and tool definitions are passed via the API `tools` parameter (always present) — neither needs re-injection after compaction.
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

Context management is a **per-model-step** concern, not just a pre-turn concern. The ReAct loop calls the model multiple times per turn (once per tool cycle), and each tool result batch adds to the context. The pipeline must run before *every* `client.generate()` call, not just the first one.

**`prepareContextForModelCall(messages, lastKnownUsage)`** — a function that runs the full context preparation pipeline. Called before every model invocation inside the ReAct loop:

```
prepareContextForModelCall(messages, lastKnownUsage):
  1. Tool result persistence     enforce per-message budget on latest tool results
  2. Microcompact                clear stale tool results (no LLM, cheap)
  3. Token pressure assessment   determine which band we're in
  4. Session memory compaction   if pressure >= 'projection' and memory available
  5. Full summarization          if pressure >= 'projection' and no session memory
  6. Prompt projection           build model-facing context
  → return projected messages for API call

Post-API-call recovery (inside the ReAct loop):
  7. Reactive compact            on overflow error from API (one-shot guard)
  8. Max output recovery         on output truncation (up to 2 retries)
```

On the first model call, microcompact and projection handle the incoming history. On subsequent calls (after tool results), the same pipeline re-assesses — microcompact may now clear earlier tool results that are no longer recent, and projection may trim the recent tail if the context has grown. This ensures cheap controls are always applied before falling back to expensive ones.

Guards against infinite loops:
- Reactive compact: `hasAttemptedReactiveCompact` boolean, one attempt per turn
- Max output recovery: `maxOutputRecoveryCount` counter, max 2
- Autocompact: `consecutiveCompactFailures` counter, max 3
- Microcompact/projection: idempotent — re-running on already-compacted messages is a no-op

### New Modules

#### `src/agent/TokenBudget.ts`

Estimates prompt pressure and compares against threshold bands.

**Dynamic context window:** The model can be overridden per turn (see `TurnExecutor.ts` line 38: `options?.model ?? this.config.model.name`), so `TokenBudget` must resolve the context window size dynamically based on the active model, not a single static config value. This is done via a `ModelMetadata` registry that maps model names to their context window sizes and max output tokens.

```typescript
/** Maps model names to their capabilities. Configured in YAML. */
interface ModelMetadata {
  contextWindowSize: number;
  maxOutputTokens: number;
}

interface TokenBudgetConfig {
  modelMetadata: Record<string, ModelMetadata>;  // Model name -> capabilities
  defaultContextWindowSize: number;              // Fallback if model not in registry
  defaultMaxOutputTokens: number;                // Fallback if model not in registry
  microcompactRatio: number;        // Default: 0.5
  projectionRatio: number;          // Default: 0.7
  overflowRatio: number;            // Default: 0.9
  safetyMargin: number;             // Default: 1.33
}

type PressureBand = 'nominal' | 'microcompact' | 'projection' | 'overflow';

class TokenBudget {
  constructor(config: TokenBudgetConfig);

  // Estimate tokens for a message array
  estimateTokens(messages: Message[], lastKnownUsage?: TokenUsage): number;

  // Determine which pressure band we're in, for the given model
  assessPressure(modelName: string, messages: Message[], lastKnownUsage?: TokenUsage): PressureBand;

  // Get effective context window for a specific model (total - output reservation)
  getEffectiveWindow(modelName: string): number;
}
```

Token estimation algorithm:
1. If `lastKnownUsage` available **and the message prefix is unchanged**: use `inputTokens + outputTokens` as baseline for messages up to the last API call
2. For messages added after the last API call: estimate via `content.length / 4`
3. Multiply estimate portion by `safetyMargin`
4. Return `baseline + paddedEstimate`

**Baseline invalidation rule:** The `lastKnownUsage` baseline is only valid when the message prefix is unchanged since the last API call. Any rewrite — microcompact clearing tool results, projection dropping messages, summarization replacing history — invalidates the baseline because the token count of the rewritten prefix no longer matches the API's reported usage.

When the baseline is invalid, fall back to **full re-estimation from scratch**: estimate the entire projected message array via `content.length / 4` with `safetyMargin` applied. This is less accurate than API-grounded usage but always correct directionally.

The caller (`prepareContextForModelCall`) tracks whether any rewrite occurred during the current pipeline pass and passes a flag:

```typescript
// In prepareContextForModelCall:
const microcompactResult = microcompact.compact(messages);
const rewrote = microcompactResult.resultsCleared > 0;
// ... projection may also rewrite ...

// If any rewrite occurred, discard the baseline
const effectiveUsage = rewrote ? undefined : lastKnownUsage;
const pressure = tokenBudget.assessPressure(modelName, projectedMessages, effectiveUsage);
```

After the next successful API call, `lastKnownUsage` is refreshed from the response's `tokenUsage` and becomes the valid baseline again — until the next rewrite.

The `modelName` parameter flows from `TurnExecutor` — whatever model is active for the current turn is passed to `assessPressure()` and `getEffectiveWindow()`. If the model name is not in the registry, the defaults are used and a warning is logged.

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

Cleanup has two paths: `SessionManager` deletes the conversation temp directory on session eviction (normal path), and a startup sweep catches orphaned directories from agent crashes (see `SessionManager` changes below).

#### `src/agent/Microcompact.ts`

Clears stale tool results without an LLM call.

**Prerequisite: Message timestamps.** The `Message` interface must be extended with an optional `timestamp` field (ISO 8601 string). This follows Claudy's pattern where every message carries a timestamp. Messages should be timestamped at creation time — when the model responds, when a tool result is produced, or when a user message arrives. See changes to `src/models/ModelClient.ts` below.

**Compactable tools:** Only tool results from specific tools are eligible for clearing. Results from tools whose output the model is unlikely to re-reference after acting on them:

```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  'web_search',
  // Future tools added here as the tool registry grows:
  // 'file_read', 'web_fetch', 'code_search', etc.
]);
```

Currently the agent only has `web_search`, so the set starts small. As new tools are added (per track `03_tool_runtime`), they should be evaluated for compactability and added here.

```typescript
interface MicrocompactConfig {
  gapThresholdMinutes: number;   // Default: 60
  keepRecentResults: number;     // Default: 5
  compactableTools: Set<string>; // Tools whose results can be cleared
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

Algorithm (follows Claudy's time-based microcompact):
1. Find the last assistant message's `timestamp`
2. Compute gap: `(Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000`
3. If gap < `gapThresholdMinutes`, return messages unchanged (conversation is still active)
4. Walk messages from newest to oldest, count compactable tool-role messages
5. For compactable tool messages beyond `keepRecentResults`: replace content with `clearedMarker`
6. Only clear results where `toolName` is in `compactableTools`
7. Estimate tokens freed from cleared content
8. Return rewritten messages + stats

#### `src/agent/SessionMemory.ts`

Continuously extracts structured conversation notes for use at compaction time. **Depends on forked agent infrastructure from track `08_forked_and_subagents`** — extraction runs as a background forked agent to avoid blocking the main conversation.

**Storage model (follows Claudy's pattern):** Content is stored on disk, metadata is tracked in memory.

- **Content on disk:** The forked agent writes to `/tmp/digitalme-agent/<conversation-id>/session-memory.md` using the Edit tool. This file is the source of truth for session memory content.
- **Metadata in memory:** `SessionMemory` tracks `lastSummarizedMessageId`, `tokensAtLastExtraction`, `extractionStartedAt`, and `sessionMemoryInitialized` in memory on the `SessionMemory` instance (not on `SessionState`).
- **Read path:** When compaction needs the session memory, it calls `getMemory()` which reads the file from disk. This is fine — compaction is already expensive, one file read is negligible.
- **Write path:** Only the forked agent writes to the file, via the Edit tool.
- **Cleanup:** The file is deleted along with the rest of the conversation temp directory on session eviction (via `SessionManager`) or startup sweep.

```typescript
interface SessionMemoryConfig {
  enabled: boolean;
  extractionModel?: string;          // null = use main model
  tokensBetweenUpdates: number;      // Default: 5,000
  toolCallsBetweenUpdates: number;   // Default: 3
  minimumTokensToInit: number;       // Default: 10,000
  maxTotalTokens: number;            // Default: 8,000
  maxSectionTokens: number;          // Default: 1,500
  storagePath: string;               // e.g., /tmp/digitalme-agent/<conversation-id>/session-memory.md
}

// In-memory tracking state (not persisted)
interface SessionMemoryState {
  lastSummarizedMessageId?: string;  // Cursor for compaction boundary
  tokensAtLastExtraction: number;    // Context size when last extracted
  extractionStartedAt?: number;      // Timestamp for staleness detection
  sessionMemoryInitialized: boolean; // One-time init gate (set when tokens >= minimumTokensToInit)
  toolCallsSinceLastExtraction: number; // Counter for tool call threshold
}

class SessionMemory {
  constructor(config: SessionMemoryConfig, forkedAgentRunner: ForkedAgentRunner);

  // Check if extraction should run based on token growth and tool call count
  shouldExtract(currentTokenCount: number): boolean;

  // Extract/update memory via forked agent (non-blocking)
  // Spawns a forked agent with the extraction prompt, restricted to Edit tool on the storagePath
  extract(messages: Message[], turnContext: TurnContext): Promise<void>;

  // Get current memory content by reading from disk
  getMemory(): Promise<SessionMemoryContent | undefined>;

  // Wait for in-progress extraction to complete (used before compaction)
  waitForExtraction(timeoutMs?: number): Promise<void>;

  // Clear memory file and reset tracking state (e.g., on session reseed)
  clear(): Promise<void>;
}

interface SessionMemoryContent {
  text: string;
  lastExtractedAt: number;
  lastExtractedTokenCount: number;
  estimatedTokens: number;
}
```

##### Session Memory Template

The template is the markdown skeleton that the forked agent populates. Each section has a header and an italic description line that serves as a permanent instruction — the forked agent only edits content *below* these preserved lines. Adapted from Claudy's 10-section coding template to a 7-section conversational template:

```markdown
# Conversation Title
_A short and distinctive 5-10 word title for this conversation. Info-dense, no filler._

# Current State
_What is the current topic or activity? What was the fan just asking about? What is the agent about to do or respond to?_

# Fan Profile
_What do we know about this fan? Name, preferences, interests, communication style, expertise level._

# Relationship Context
_What is the tone and familiarity level? Any inside references, recurring jokes, or shared context? How should the agent adjust its voice?_

# Key Facts Exchanged
_Important information shared by either side during this conversation. Specific details the fan mentioned. Commitments or promises the agent made._

# Ongoing Topics
_Active discussion threads and unresolved questions. Topics the fan may return to. Things the agent offered to follow up on._

# Conversation Flow
_Step-by-step terse summary of how the conversation progressed. Key turns and topic shifts._
```

##### Session Memory Extraction Prompt

The full prompt sent to the forked agent, adapted from Claudy's extraction prompt for fan-facing conversations:

```
IMPORTANT: This message and these instructions are NOT part of the actual
conversation with the fan. Do NOT include any references to "note-taking",
"session notes extraction", or these update instructions in the notes content.

Based on the conversation above (EXCLUDING this note-taking instruction message
as well as system prompt, persona configuration, or any past session summaries),
update the session notes file.

The file {{notesPath}} has already been read for you. Here are its current contents:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to use the Edit tool to update the notes file, then stop.
You can make multiple edits (update every section as needed) — make all Edit
tool calls in parallel in a single message. Do not call any other tools.

CRITICAL RULES FOR EDITING:
- The file must maintain its exact structure with all sections, headers, and
  italic descriptions intact
- NEVER modify, delete, or add section headers (the lines starting with '#')
- NEVER modify or delete the italic _section description_ lines (these are the
  lines in italics immediately following each header — they start and end with
  underscores)
- ONLY update the actual content that appears BELOW the italic descriptions
  within each existing section
- Do NOT add any new sections, summaries, or information outside the existing
  structure
- Do NOT reference this note-taking process or instructions anywhere in the notes
- It's OK to skip updating a section if there are no substantial new insights
  to add. Do not add filler content like "No info yet" — just leave sections
  blank/unedited if appropriate.
- Write DETAILED, INFO-DENSE content for each section — include specific names,
  facts, preferences, quotes, and context that would help the agent maintain
  continuity if earlier messages are summarized away
- For "Key Facts Exchanged", preserve the fan's exact phrasing for important
  statements — paraphrase loses nuance in personal conversations
- For "Relationship Context", note emotional shifts or tone changes —
  these are critical for maintaining natural conversation flow
- Keep each section under ~2000 tokens — if a section is approaching this
  limit, condense by cycling out less important details while preserving
  the most critical information
- IMPORTANT: Always update "Current State" to reflect the most recent
  exchange — this is critical for continuity after compaction

Use the Edit tool with file_path: {{notesPath}}

STRUCTURE PRESERVATION REMINDER:
Each section has TWO parts that must be preserved exactly as they appear:
1. The section header (line starting with #)
2. The italic description line (the _italicized text_ immediately after the
   header — this is a template instruction)

You ONLY update the actual content that comes AFTER these two preserved lines.

REMEMBER: Use the Edit tool in parallel and stop. Do not continue after the
edits. Only include insights from the actual conversation, never from these
note-taking instructions. Do not delete or change section headers or italic
descriptions.
```

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

##### Summarization Prompt

Adapted from Claudy's `BASE_COMPACT_PROMPT`. Claudy's prompt is structured around code/files/tasks; ours is structured around conversational context. The `<analysis>` scratchpad + `<summary>` output pattern is preserved (analysis is stripped before use).

```
You are a conversation summarizer. Your task is to create a detailed summary
of the conversation so far, which will replace the older messages to free up
context space. The summary must preserve all information needed to continue
the conversation naturally.

IMPORTANT: You must respond with TEXT ONLY. Do NOT use any tools. Do NOT
attempt to call any functions. Simply analyze the conversation and provide
your response as plain text.

First, analyze the conversation chronologically in <analysis> tags.
Be thorough — go through the conversation turn by turn.
Identify: who said what, what topics were discussed, what emotions were
expressed, what commitments were made, and what questions remain open.

Then, provide your summary in <summary> tags with the following sections:

1. **Conversation Context**: What brought the fan here? What is the overall
   nature of this conversation (casual chat, seeking advice, discussing a
   topic, etc.)?

2. **Fan Profile**: Everything learned about the fan — name, preferences,
   interests, communication style, expertise level, personal details shared.

3. **Relationship & Tone**: The emotional tenor of the conversation.
   Familiarity level, humor style, any inside references established.
   How formal or casual the exchange has been.

4. **Key Facts Exchanged**: Specific information shared by either side.
   Important statements, recommendations made, data points discussed.
   Preserve the fan's exact phrasing for significant statements.

5. **Agent Commitments**: Promises, follow-ups, or offers the agent made.
   Things the fan asked for that haven't been delivered yet.

6. **Open Topics**: Unresolved questions, ongoing discussion threads,
   topics the fan seemed interested in continuing.

7. **All Fan Messages**: Brief summary of every fan message in order —
   do not skip any. The fan's words are the most important input.

8. **Current State**: What was happening at the end of the conversation?
   What is the fan likely to say or ask next?

IMPORTANT:
- Do NOT omit any user messages from your summary
- Do NOT include information from the system prompt or persona configuration
- Preserve specific details (names, numbers, dates, preferences) — do not
  generalize
- The summary should enable the agent to continue the conversation as if
  no compression happened
- Keep the summary concise but complete — aim for the minimum text that
  preserves all essential context

REMEMBER: Respond with text only. No tool calls. No function calls.
```

**Post-processing:** `formatCompactSummary()` strips the `<analysis>` block and extracts only the `<summary>` content. This keeps the reasoning scratchpad out of the model's context.

#### `src/agent/PromptProjector.ts`

Derives the model-facing **history** portion of the message array from raw history + summary/memory. **The system prompt is NOT owned by the projector** — `SystemPromptBuilder` remains the sole owner of system prompt construction (persona, tool policy, cache control blocks). The projector only assembles the messages that come *after* the system prompt.

This separation is important: `TurnExecutor` already uses `SystemPromptBuilder` to produce `systemPromptBlocks` with per-section cache policies. The projector must not duplicate or conflict with that output.

```typescript
interface ProjectionConfig {
  tokenBudget: TokenBudget;
  recentTailMinMessages: number;    // Default: 6
  recentTailMaxTokens: number;      // Default: varies by model
}

class PromptProjector {
  constructor(config: ProjectionConfig);

  // Build projected history (everything AFTER the system prompt)
  project(components: ProjectionInput): Message[];
}

interface ProjectionInput {
  summary?: ConversationSummary;
  sessionMemory?: SessionMemoryContent;
  fullHistory: Message[];
  latestUserMessage: string;
  modelName: string;                // For TokenBudget pressure assessment
  lastKnownUsage?: TokenUsage;
  systemPromptTokenEstimate: number; // So projector knows how much budget remains for history
}
```

Projection algorithm:
1. Calculate available budget: `tokenBudget.getEffectiveWindow(modelName) - systemPromptTokenEstimate`
2. If session memory or summary exists: insert as a user-role context block ("Context from earlier conversation:\n{memory or summary}")
3. Determine recent tail: walk backwards from end of `fullHistory` until either `recentTailMinMessages` are included or token estimate reaches available budget
4. Append recent tail messages verbatim
5. Append latest user message
6. Verify total estimate fits; if not, shrink recent tail

Output structure (history portion only — system prompt is prepended by TurnExecutor):
```
[user: "Context from earlier conversation:\n{memory or summary}"]   << only when compaction occurred
[...recent tail messages...]
[user: latest message]
```

Session memory is preferred over summary when both exist (higher fidelity, zero cost).

#### `src/agent/SessionMemoryCompact.ts`

Handles using session memory as the compaction source — the bridge between session memory extraction (background) and the compaction pipeline (on-demand). This is the module that Claudy implements in `sessionMemoryCompact.ts`. Without it, the design has no logic for *how* session memory replaces old messages during compaction.

```typescript
interface SessionMemoryCompactConfig {
  minTokens: number;            // Default: 10,000 — minimum tokens to preserve after compaction
  minTextBlockMessages: number; // Default: 5 — minimum messages with text content to keep
  maxTokens: number;            // Default: 40,000 — hard cap on preserved tokens
}

class SessionMemoryCompact {
  constructor(
    config: SessionMemoryCompactConfig,
    sessionMemory: SessionMemory,
    tokenBudget: TokenBudget,
  );

  // Attempt session memory compaction. Returns null if session memory is
  // empty or unavailable — caller should fall back to ConversationSummaryBuilder.
  tryCompact(messages: Message[]): Promise<CompactionResult | null>;
}

interface CompactionResult {
  // The compacted message array: [boundary marker] + [summary] + [preserved messages]
  messages: Message[];
  // Token count before compaction (for metrics)
  preCompactTokens: number;
  // Token count after compaction
  postCompactTokens: number;
}
```

**Compaction unit: assistant-tool-group.** In our OpenAI-style message schema, a tool interaction is represented as one assistant message (with `toolCalls: ToolCall[]`) followed by N tool-role messages (one per call, keyed by `toolCallId`). This is a 1-to-N group, not adjacent pairs. The compaction boundary must never split within a group — either the entire group is kept or the entire group is discarded.

```typescript
/**
 * An assistant-tool-group is the atomic unit of compaction:
 * one assistant message with toolCalls[] + all its tool result messages.
 *
 * Example: assistant message has toolCalls with ids ["call_1", "call_2"].
 * The group includes that assistant message + the two tool messages with
 * toolCallId "call_1" and "call_2".
 *
 * A plain assistant message (no toolCalls, just text) is its own group of size 1.
 * A plain user message is its own group of size 1.
 */
interface AssistantToolGroup {
  startIndex: number;    // Index of the assistant message in the message array
  endIndex: number;      // Index of the last tool result message (inclusive)
  messageCount: number;  // Total messages in this group
  estimatedTokens: number;
}

/** Groups a message array into atomic compaction units. */
function groupMessages(messages: Message[]): AssistantToolGroup[];
```

**Compaction algorithm (follows Claudy's `sessionMemoryCompact.ts`, adapted for OpenAI message schema):**

1. **Wait for in-progress extraction:** Call `sessionMemory.waitForExtraction(15_000)`. If extraction is stale (started >60s ago), skip waiting.
2. **Load session memory:** Call `sessionMemory.getMemory()`. If empty or content matches the bare template, return `null` (fall back to LLM summarization).
3. **Truncate oversized sections:** If any section exceeds `maxSectionTokens`, truncate to prevent the memory from consuming the entire post-compact budget.
4. **Group messages:** Call `groupMessages(messages)` to identify atomic compaction units.
5. **Calculate groups to keep:**
   - Find the group containing `lastSummarizedMessageId` (the cursor set during extraction)
   - Expand backwards (by whole groups) to meet **both** `minTokens` and `minTextBlockMessages`
   - Hard cap at `maxTokens`
   - The boundary always falls on a group boundary — never within a group
6. **Build compacted messages:**
   - Compact boundary marker (system message noting compaction occurred and pre-compact token count)
   - Summary message containing the session memory content
   - Preserved messages (all messages from the kept groups)
7. Return `CompactionResult`

**API invariant preservation:** Because the boundary algorithm operates on `AssistantToolGroup` units rather than individual messages, it is structurally impossible to:
- Discard an assistant message while keeping some of its tool results
- Keep an assistant message while discarding some of its tool results
- Orphan a tool result message without its preceding assistant tool call

#### `src/agent/PostCompactRecovery.ts`

Re-injects **conversational** context that compaction may have stripped. **Does NOT re-inject system prompt material** — the system prompt (persona, tool policy) is owned by `SystemPromptBuilder` and is always present as the first message. `PostCompactRecovery` only produces user-role messages containing context that the summary/session memory may not fully capture.

```typescript
interface PostCompactRecoveryConfig {
  maxRecoveryTokens: number;    // Default: 10,000
}

class PostCompactRecovery {
  constructor(config: PostCompactRecoveryConfig);

  // Build user-role recovery messages to insert after the compaction summary
  buildRecoveryMessages(context: RecoveryContext): Message[];
}

interface RecoveryContext {
  characterContext?: string;       // Additional character-specific context (catchphrases, style guides)
  // NOTE: persona and tool definitions are NOT here — they're in the system prompt,
  // which SystemPromptBuilder handles and TurnExecutor always includes.
}
```

After compaction, re-inject as user-role messages:
- Character-specific context that lives outside the system prompt (e.g., dynamic style guides, relationship-specific tone adjustments discovered during the conversation)

What is **NOT** re-injected here (because the system prompt already covers it):
- Agent persona/character prompt — owned by `SystemPromptBuilder`, always present
- Tool definitions — passed via `tools` parameter in the API call, always present
- Tool policy — in the system prompt, always present

This is much simpler than Claudy's version (which re-injects files, plans, skills, and CLAUDE.md content) because our agent's system prompt is always present and stable — compaction only affects the history portion.

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

#### `src/models/ModelClient.ts`

Add stable message ID and timestamp to the `Message` interface. The `id` field provides a durable identity for each message that survives array reordering, projection, and microcompact rewrites — it is the foundation for `lastSummarizedMessageId` (the compaction cursor used by session memory). The `timestamp` field is used by microcompact to determine the time gap.

```typescript
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  id?: string;             // NEW: stable UUID, set at message creation time (crypto.randomUUID())
  timestamp?: string;      // NEW: ISO 8601 timestamp, set at message creation time
}
```

Both fields should be set when messages are created:
- **User messages:** When the platform sends a turn request (use the request timestamp or `new Date().toISOString()`)
- **Assistant messages:** When the model response is received
- **Tool messages:** When the tool result is produced
- Both fields are optional for backward compatibility — messages without `id` are treated as pre-context-management messages (skipped by compaction cursor logic); microcompact skips the gap check if the last assistant message has no timestamp

**Why stable IDs are needed:** `lastSummarizedMessageId` is a cursor that says "session memory has captured everything up to this message." The forked extractor sets this cursor when it finishes extraction. Later, when compaction runs, it uses this cursor to determine which messages are covered by the session memory summary and which must be preserved verbatim. Without stable IDs, this cursor would have to be an array index, which breaks when:
- Microcompact rewrites messages (clearing tool results changes nothing about position, but other rewrites could)
- Projection reorders or drops messages
- Platform reseed replaces the array entirely

The `id` is assigned once at creation and never changes. It is *not* sent to the model API — it's internal bookkeeping only. `SessionState.clonePromptMessage()` must be updated to preserve the `id` and `timestamp` fields when cloning.

#### `src/agent/SessionState.ts`

Add summary storage (session memory content is now on disk, not in-memory — see `SessionMemory.ts` storage model):

```typescript
class SessionState {
  private canonicalHistory: HistoryMessage[];
  private promptHistory: Message[];
  private summary?: ConversationSummary;           // NEW

  // REMOVED: sessionMemory is no longer stored here — it lives on disk,
  // managed by SessionMemory. Only the summary (generated on-demand by
  // ConversationSummaryBuilder) is cached on SessionState.

  // NEW: conversation summary
  getSummary(): ConversationSummary | undefined;
  setSummary(summary: ConversationSummary): void;

  // CHANGE: reconcileWithPlatformHistory should clear summary on reseed
  // (session memory on disk is cleared via SessionMemory.clear(), called by SessionRuntime)
}
```

#### `src/agent/TurnExecutor.ts`

Integrate context management as a **per-model-step** concern inside the ReAct loop:

```
New method: prepareContextForModelCall(messages, modelName, lastKnownUsage):
  1. ToolResultPersistence.enforceMessageBudget(messages)
  2. Microcompact.compact(messages)
  3. band = TokenBudget.assessPressure(modelName, messages, lastKnownUsage)
  4. If band >= 'projection':
     a. SessionMemoryCompact.tryCompact(messages)  << try session memory first (free)
     b. If null: ConversationSummaryBuilder.summarize()  << fallback (expensive)
     c. PostCompactRecovery.buildRecoveryMessages()  << re-inject persona
  5. PromptProjector.project({ systemPrompt, memory/summary, messages })
  → return projected messages

Inside the ReAct loop (called on EVERY iteration, not just the first):
  1. projectedMessages = prepareContextForModelCall(context.messages, modelName, lastUsage)
  2. result = client.generate(projectedMessages, ...)
  3. If tool calls:
     a. Push assistant message (with id + timestamp)
     b. Execute tools, push tool results (with id + timestamp)
     c. Persist large tool results (ToolResultPersistence.processResult)
     d. Continue loop → prepareContextForModelCall runs again on next iteration

On model API error (context overflow):
  1. If not already attempted reactive compact: recover and retry
  2. If already attempted: emit error event

On model output truncation:
  1. If escalation available: retry with higher max output tokens
  2. Else if retries remaining: inject continuation message and retry
  3. Else: return what we have
```

**Why per-model-step matters:** A single turn with 5 tool calls returning 30K chars each adds ~150K chars to context. If context management only runs before the first model call, these tool results accumulate unchecked. By running `prepareContextForModelCall()` before every `client.generate()`, the cheaper controls (microcompact, projection) prevent context from ever reaching the overflow band, and reactive compact becomes a true last resort rather than the primary mid-turn defense.

#### `src/agent/SessionManager.ts`

Add cleanup hook on session eviction and startup sweep for orphaned files:

```typescript
constructor(config) {
  // ...

  // Startup sweep: clean up orphaned temp directories from previous runs
  // (e.g., after agent crash where session eviction cleanup never ran)
  this.sweepOrphanedTempFiles(config.context.tool_result_persistence.storage_dir);
}

/**
 * On startup, delete any conversation temp directories older than the session TTL.
 * Catches orphans from crashes where the normal eviction cleanup never ran.
 * Runs once, fire-and-forget — failure is non-fatal.
 */
private async sweepOrphanedTempFiles(storageDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(storageDir);
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const entry of entries) {
      const dirPath = path.join(storageDir, entry);
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    }
  } catch {
    // storageDir may not exist yet on first run — ignore
  }
}

private evictExpiredSessions() {
  // ... existing logic ...
  if (runtime.state.getLastAccessedAt() < cutoff) {
    runtime.abortForkedAgents();
    // Fire-and-forget: cleanup is best-effort. If it fails (e.g., EBUSY from
    // in-flight forked agent write), the startup sweep catches the orphan on
    // next restart. We intentionally do NOT await here because eviction runs
    // synchronously in the request path — blocking on disk I/O would add
    // latency to the fan's next turn request.
    this.cleanupConversationTempDir(conversationId).catch(() => {
      // Swallowed — startup sweep is the safety net
    });
    this.sessions.delete(conversationId);
  }
}

private async cleanupConversationTempDir(conversationId: string): Promise<void> {
  const dirPath = path.join(this.storageDir, conversationId);
  await fs.rm(dirPath, { recursive: true, force: true });
}
```

**Garbage collection strategy:**

| Path | Cleanup trigger | Async model | What it catches |
|------|----------------|-------------|-----------------|
| Normal | Session eviction (TTL or capacity) | Fire-and-forget (not awaited) | Active sessions that expire normally |
| Crash recovery | Startup sweep (agent restart) | Fire-and-forget (not awaited) | Orphaned directories from crashes or failed eviction cleanup |

**Why fire-and-forget for eviction cleanup:** Eviction runs synchronously in the request path (`evictExpiredSessions` is called at the start of `execute()`). Awaiting disk I/O would add latency to every fan request. If cleanup fails (e.g., `EBUSY` from an in-flight forked agent write, or transient I/O error), the directory is left behind and the startup sweep catches it on the next agent restart. This two-layer approach (best-effort eviction + guaranteed startup sweep) means individual cleanup failures never leak files permanently.

The startup sweep uses the same TTL as session eviction — any conversation directory with an `mtime` older than the TTL is considered orphaned and deleted. This is safe because:
- Active sessions always have fresh writes (tool results, session memory extractions)
- If the agent crashed, no session state survived in memory anyway — the files are unreachable
- The sweep is fire-and-forget; failure doesn't block startup

#### `src/agent/SessionRuntime.ts`

Orchestrate session memory extraction after turn completion via post-turn hooks and forked agents (from track `08_forked_and_subagents`):

```typescript
constructor(config) {
  // ...
  this.hookRegistry = new PostTurnHookRegistry();

  if (config.sessionMemory?.enabled) {
    // Register session memory extraction as a post-turn hook
    // The hook spawns a forked agent for non-blocking extraction
    this.hookRegistry.register(createSessionMemoryHook(
      this.sessionMemory,
      config.sessionMemory,
    ));
  }
}

async execute(submission, events) {
  // ... existing reconcile + execute ...
  
  // After successful turn completion, run post-turn hooks (fire-and-forget).
  // SessionMemoryHook checks thresholds and spawns a forked agent if needed.
  // Uses the existing PostTurnHookContext contract from track 08:
  this.hookRegistry.runAll({
    sessionState: this.state,
    sessionRuntime: this,
    forkSemaphore: this.forkSemaphore,
    turnExecutor: this.deps.turnExecutor,
    conversationId: submission.conversationId,
    lastResult: result,
  }).catch(() => {
    // Swallowed — hook errors never crash the main agent
  });
}
```

#### `src/prompts/PromptComposer.ts`

The composer's role narrows — it handles system prompt assembly while `PromptProjector` handles history projection. The `compose()` method may be refactored or the projector may wrap the composer.

#### `src/config/schema.ts`

Add context management configuration:

```yaml
context:
  # Per-model context window and output token metadata.
  # Used by TokenBudget to assess pressure for the active model.
  # The model used per turn may differ from the default (options.model override).
  model_metadata:
    gpt-4o:
      context_window_size: 128000
      max_output_tokens: 16384
    gpt-4o-mini:
      context_window_size: 128000
      max_output_tokens: 16384
    llama-3.3-70b:
      context_window_size: 131072
      max_output_tokens: 4096
    # Add entries for each model the agent may use
  default_context_window_size: 128000   # Fallback if model not in registry
  default_max_output_tokens: 4096       # Fallback if model not in registry
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

export interface CompactionResult {
  messages: Message[];
  preCompactTokens: number;
  postCompactTokens: number;
}

/**
 * Atomic unit of compaction: one assistant message (with toolCalls[]) + all
 * its corresponding tool result messages. Compaction boundaries must fall
 * between groups, never within. A plain text message is its own group of size 1.
 */
export interface AssistantToolGroup {
  startIndex: number;
  endIndex: number;
  messageCount: number;
  estimatedTokens: number;
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
  │
SessionRuntime.execute()
  │── reconcileWithPlatformHistory()
  │── state.getPromptHistory() → raw history
  │
  │── TurnExecutor.run(history, submission)
  │     │
  │     │  ┌─────────── ReAct Loop (repeats per model step) ──────────┐
  │     │  │                                                          │
  │     │  │  prepareContextForModelCall(messages, modelName, usage)   │
  │     │  │    │── ToolResultPersistence.enforceMessageBudget()       │
  │     │  │    │── Microcompact.compact()                             │
  │     │  │    │── TokenBudget.assessPressure(modelName, ...)         │
  │     │  │    │── [if projection needed]:                            │
  │     │  │    │     │── SessionMemoryCompact.tryCompact()            │
  │     │  │    │     │── ConversationSummaryBuilder.summarize()       │
  │     │  │    │     └── PostCompactRecovery.buildRecoveryMessages()  │
  │     │  │    └── PromptProjector.project()                          │
  │     │  │         → projected messages                              │
  │     │  │                                                          │
  │     │  │  client.generate(projectedMessages)                       │
  │     │  │    │── on overflow error → ReactiveCompact.recover()      │
  │     │  │    └── on output truncation → MaxOutputRecovery           │
  │     │  │                                                          │
  │     │  │  [if tool calls]:                                         │
  │     │  │    │── push assistant message (with id + timestamp)       │
  │     │  │    │── execute tools                                      │
  │     │  │    │── push tool results (with id + timestamp)            │
  │     │  │    │── ToolResultPersistence.processResult() per result   │
  │     │  │    └── continue loop                                      │
  │     │  │                                                          │
  │     │  │  [if final text]: break loop                              │
  │     │  │                                                          │
  │     │  └──────────────────────────────────────────────────────────┘
  │     │
  │     └── return TurnExecutionResult
  │
  │── [post-turn]:
  │     │── SessionMemory.extract() if shouldExtract()  << Background (forked agent)
  │     └── state.setSummary() if summary was generated
  │
  └── state.commitTask()
```

### Canonical History

- Platform-owned source of truth
- Never replaced by local summary or session memory
- Never modified by compaction — compaction only affects the projected view
- Reseeding from platform clears local summary and session memory

### Session Memory

- Content stored on disk (`/tmp/digitalme-agent/<conversation-id>/session-memory.md`), tracking metadata in memory on `SessionMemory` instance
- Continuously extracted after turns via forked agent (non-blocking)
- Preferred over one-shot summary at compaction time (zero cost, higher fidelity)
- Cleared on platform reseed
- Not persisted across agent restarts (sessions are ephemeral per TTL)

### Conversation Summary

- Generated on-demand when session memory is unavailable and context pressure requires compaction
- Fallback path — session memory compaction is preferred
- Cleared on platform reseed

### Projected Prompt Context

What the model actually sees (assembled by TurnExecutor from SystemPromptBuilder output + PromptProjector output):

```
[System prompt with persona + tool policy]  << SystemPromptBuilder (always present, never touched by compaction)
[Context from earlier conversation]         << PromptProjector: session memory or summary, only when pressure >= 'projection'
[Recent messages preserved verbatim]        << PromptProjector: last N messages
[Latest user message]                       << PromptProjector: the current turn's input
```

**Prompt ownership:** `SystemPromptBuilder` owns the system prompt (persona, tool policy, cache blocks). `PromptProjector` owns the history portion (context block + recent tail + user message). `TurnExecutor` concatenates them. Neither `PromptProjector` nor `PostCompactRecovery` generates system-level prompt content.

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

### Step 1: TokenBudget, ToolResultPersistence, Message Identity, and groupMessages

The foundation — nothing else works without token awareness, safe tool result handling, stable message IDs, and message grouping.

Files:
- new `src/agent/types/context.ts` (includes `AssistantToolGroup`, `CompactionResult`, etc.)
- new `src/agent/TokenBudget.ts` (with `ModelMetadata` registry for dynamic context window resolution)
- new `src/agent/ToolResultPersistence.ts`
- new `src/agent/groupMessages.ts` (groups message arrays into atomic `AssistantToolGroup` units)
- update `src/models/ModelClient.ts` (add `id` and `timestamp` fields to `Message` interface)
- update `src/config/schema.ts` (add context config with `model_metadata` registry)
- update `src/agent/TurnExecutor.ts` (persist tool results after each tool execution, set `id` + `timestamp` on messages)
- update `src/agent/SessionState.ts` (preserve `id` and `timestamp` in `clonePromptMessage`)
- update `src/agent/SessionManager.ts` (cleanup on eviction + startup sweep)

Test cases:
- Token estimation accuracy against known message sizes
- Pressure band boundaries at each threshold ratio
- `assessPressure` resolves correct context window from model metadata registry
- `assessPressure` uses default context window for unknown model names
- Tool result persisted when over threshold, preview returned
- Per-message budget enforcement (largest results persisted first)
- Persisted files cleaned up on session eviction
- Model can read back persisted results via file-read tool
- Startup sweep deletes orphaned directories older than session TTL
- Startup sweep ignores directories newer than session TTL (active sessions)
- Startup sweep is non-fatal if storage directory doesn't exist
- Messages get stable `id` (UUID) and `timestamp` at creation time
- `clonePromptMessage` preserves `id` and `timestamp` fields
- `groupMessages` correctly groups assistant+toolCalls message with its N tool results
- `groupMessages` treats plain text assistant/user messages as single-message groups
- `groupMessages` handles edge cases: empty array, messages without toolCalls
- Edge cases: empty content, very small messages, persistence failure (original returned)

### Step 2: Microcompact and prepareContextForModelCall

Cheap context reduction. Also introduce `prepareContextForModelCall()` — the per-model-step pipeline function that runs before every `client.generate()` call inside the ReAct loop. Initially it only contains microcompact; later steps add projection and compaction to it.

Files:
- new `src/agent/Microcompact.ts`
- new `src/agent/prepareContextForModelCall.ts` (pipeline function, starts with just microcompact)
- update `src/agent/TurnExecutor.ts` (call `prepareContextForModelCall` before every model invocation, not just the first)

Test cases:
- Tool results cleared after gap threshold
- Recent N results preserved regardless of gap
- No changes when gap is under threshold
- Correct token-freed estimation
- Messages without tool results pass through unchanged

### Step 3: Session Memory

Continuous extraction — the highest-value addition for conversational quality.

**Prerequisite:** Forked agent infrastructure from track `08_forked_and_subagents` (Phase 1: `ForkedAgent`, `ForkedContext`, and Phase 3: `PostTurnHooks`). Session memory extraction runs as a forked agent spawned by a post-turn hook — this is the same architecture Claudy uses. The forked agent shares the parent's conversation context (for cache efficiency where supported) and is restricted to only the Edit tool on the session memory storage.

Files:
- new `src/agent/SessionMemory.ts` (uses `runForkedAgent` from `src/agent/fork/`; writes to disk, tracks metadata in memory)
- new `src/agent/hooks/SessionMemoryHook.ts` (post-turn hook that checks thresholds and spawns forked agent; uses existing `PostTurnHookContext` contract)
- new `src/agent/SessionMemoryPrompt.ts` (extraction prompt template + session memory markdown template)
- update `src/agent/SessionRuntime.ts` (register session memory hook via `PostTurnHookRegistry`)

Test cases:
- Extraction triggers after configured token growth
- Extraction triggers after configured tool call count
- Extraction does not trigger before initialization threshold (10K tokens)
- Memory captures key conversational elements (fan profile, facts, topics)
- Memory cleared on platform reseed
- Memory respects size limits (per-section and total)
- Extraction runs as forked agent (non-blocking, does not delay SSE `done` event)
- Forked agent is restricted to Edit tool on memory file only
- `waitForExtraction` completes before compaction proceeds
- `shouldExtract` returns false when token growth insufficient
- Concurrent extraction requests are serialized (no overlapping forked agents)

### Step 4: SessionMemoryCompact + Summary + PromptProjector + PostCompactRecovery

The compaction and projection logic that transforms raw history into bounded model-facing context. `SessionMemoryCompact` uses session memory (from Step 3) as the compaction source. `ConversationSummaryBuilder` is the fallback when session memory is unavailable. `PromptProjector` assembles the final model-facing message array.

Files:
- new `src/agent/SessionMemoryCompact.ts`
- new `src/agent/ConversationSummaryBuilder.ts`
- new `src/agent/PromptProjector.ts`
- new `src/agent/PostCompactRecovery.ts`
- update `src/agent/SessionState.ts` (add summary storage)
- update `src/agent/SessionRuntime.ts` (orchestrate compaction + projection + summary updates)
- update `src/prompts/PromptComposer.ts` (narrow scope or integrate with projector)

Test cases:
- SessionMemoryCompact waits for in-progress extraction before compacting
- SessionMemoryCompact returns null when session memory is empty (triggers fallback)
- SessionMemoryCompact preserves assistant-tool-groups at the keep boundary (never splits a group)
- SessionMemoryCompact respects minTokens, minTextBlockMessages, maxTokens
- Projection uses session memory when available (preferred path)
- Projection falls back to summary when no session memory
- Projection omits context block when pressure is 'nominal'
- Recent tail sizing respects token budget
- Summary generation captures key conversational elements (uses full prompt)
- Summary `<analysis>` scratchpad is stripped, only `<summary>` content kept
- Post-compact recovery injects character-specific context as user-role messages (does NOT re-inject persona or tool definitions — those are owned by SystemPromptBuilder and tools API parameter)
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
- **TokenBudget:** Pure unit tests with known message sizes; verify dynamic model resolution from metadata registry; verify fallback to defaults for unknown models
- **ToolResultPersistence:** Integration tests with temp directories, verify persist + read-back + cleanup + startup sweep
- **groupMessages:** Unit tests verifying correct grouping of assistant+N tool results; edge cases (no tools, parallel tool calls, mixed text/tool messages)
- **Microcompact:** Unit tests with crafted message sequences and timestamps; verify compactable tool filtering; verify gap calculation from message timestamps
- **prepareContextForModelCall:** Integration tests verifying the full pipeline runs before each model call; verify idempotency (re-running on already-compacted messages is a no-op)
- **SessionMemory:** Integration tests with a fake ForkedAgentRunner; verify file written to disk; verify `getMemory()` reads from disk; verify `waitForExtraction()` timeout behavior
- **SessionMemoryCompact:** Unit tests for group-boundary calculation; verify `AssistantToolGroup` boundaries are never split; verify fallback to null when memory is empty; verify `waitForExtraction` is called before loading memory
- **ConversationSummaryBuilder:** Integration tests with a fake ModelClient; verify `<analysis>` stripping; verify summary captures all required sections
- **PromptProjector:** Unit tests verifying output structure at each pressure band
- **PostCompactRecovery:** Unit tests verifying character-context injection as user-role messages (NOT system prompt material — persona and tool definitions are owned by SystemPromptBuilder and tools API parameter)
- **ReactiveCompact:** Integration tests simulating overflow -> recovery flow
- **MaxOutputRecovery:** Unit tests for escalation, continuation, and circuit breaker
- **End-to-end:** TurnExecutor integration tests verifying the full per-model-step pipeline under different pressure scenarios (including multi-tool-call turns that would exceed budget without mid-loop context management)

## Risks

- **Over-compacting:** Aggressive summarization loses necessary recent details. Mitigation: always preserve a minimum recent tail, tune thresholds conservatively.
- **Summary drift:** Summary diverges from canonical history semantics over time. Mitigation: regenerate summary rather than incrementally updating; prefer session memory which is extracted with full context.
- **Session memory extraction cost:** LLM calls for extraction add latency and cost. Mitigation: extract in background (non-blocking), allow configuring a cheaper model, only extract after sufficient token growth.
- **Summarization cost:** LLM calls for summarization add latency and cost. Mitigation: session memory makes this the fallback path; allow configuring a cheaper model.
- **Threshold tuning:** Wrong thresholds cause either premature compaction (wasted quality) or late compaction (overflow errors). Mitigation: make thresholds configurable per model; start with conservative defaults.
- **Multi-model variance:** Different providers report token usage differently. Mitigation: safety margin in estimation; test with each provider.
- **Persistence disk pressure:** Large tool results accumulate on disk. Mitigation: deterministic cleanup on session eviction; configurable storage directory.
- **Persona loss after compaction:** Summary may not fully capture the agent's personality. Mitigation: The system prompt (owned by `SystemPromptBuilder`) is always present and unaffected by compaction. `PostCompactRecovery` can inject additional character-specific context as user-role messages if needed.

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
