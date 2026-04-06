# Context Management

## Goal

Manage model-facing context growth and continuity across requests without changing the platform's canonical ownership of conversation history.

This track is about context pressure, projection, summarization, and recovery.

## Scope

In scope:

- prompt projection
- summary memory
- microcompact
- reactive compact
- token thresholds
- preserved recent tail

Out of scope:

- base system prompt construction
- prompt override/append semantics

Those belong in `01_prompt_management`.

## Current State

Today the relevant runtime pieces are:

- `src/agent/SessionState.ts`
- `src/agent/TurnExecutor.ts`
- `src/prompts/PromptComposer.ts`

The baseline split between `canonicalHistory` and `promptHistory` is already valuable. This sector builds on that split.

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/query.ts`
- `/home/rich/dev/study/claudy/src/services/compact/microCompact.ts`
- `/home/rich/dev/study/claudy/src/services/compact/autoCompact.ts`
- `/home/rich/dev/study/claudy/src/utils/toolResultStorage.ts`

The most important pattern is a graduated context-management strategy:

### 1. Microcompact

- cheapest reduction
- clears or replaces stale tool results
- runs before any expensive summarization

### 2. Prompt Projection

- model-facing context is derived
- older conversation content can be summarized
- recent tail is preserved verbatim

### 3. Reactive Compact

- if context still overflows, strip/summarize and retry
- use circuit breakers and bounded retries

### 4. Threshold Bands

Do not use one boolean “too long” threshold.

Use:

- microcompact threshold
- summary/projection threshold
- overflow threshold

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/TokenBudget.ts`
  - estimate prompt pressure and compare against threshold bands
- `src/agent/Microcompact.ts`
  - clear or externalize stale large tool outputs
- `src/agent/PromptProjector.ts`
  - derive model-facing history
- `src/agent/ConversationMemoryBuilder.ts`
  - update summary memory after successful requests
- `src/agent/ReactiveCompact.ts`
  - overflow recovery and bounded retry
- `src/agent/types/memory.ts`
  - memory/projection metadata

### Existing Files To Change

- `src/agent/SessionState.ts`
- `src/agent/TurnExecutor.ts`

## Proposed Runtime Model

### Canonical History

- platform-owned source of truth
- never replaced by local summary memory

### Summary Memory

- local derived memory
- rebuildable
- helps avoid replaying the full raw conversation

### Projected Prompt Context

Should contain:

- summary memory
- recent preserved tail
- selected tool-use summaries
- latest user message

## Suggested Implementation Sequence

### Step 1: TokenBudget and Microcompact

Files:

- new `src/agent/TokenBudget.ts`
- new `src/agent/Microcompact.ts`
- update `src/agent/TurnExecutor.ts`

### Step 2: Summary Memory

Files:

- new `src/agent/ConversationMemoryBuilder.ts`
- update `src/agent/SessionState.ts`

### Step 3: PromptProjector

Files:

- new `src/agent/PromptProjector.ts`
- update `src/agent/TurnExecutor.ts`

### Step 4: ReactiveCompact

Files:

- new `src/agent/ReactiveCompact.ts`
- update `src/agent/TurnExecutor.ts`

## Testing Strategy

Add tests for:

- prompt pressure estimation
- microcompact replacing stale large outputs
- summary memory updates after request completion
- projected context preserving recent tail
- bounded retry on overflow

## Risks

- over-compacting and losing necessary recent details
- summary memory drifting from canonical history semantics
- copying `claudy` thresholds directly instead of tuning for `digitalme-agent`

## Success Criteria

- prompt growth is bounded
- recent context remains stable and understandable
- overflow recovery is bounded and testable

