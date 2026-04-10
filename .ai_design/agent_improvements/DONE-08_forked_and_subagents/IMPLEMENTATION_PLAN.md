# Forked Agents and Subagents

## Goal

Enable the DigitalMe agent to spawn background workers and specialized subagents for parallel task execution, context-efficient background processing, and delegation of specialized tasks.

This track covers the infrastructure for running multiple concurrent agent instances with proper isolation, bounded concurrency, and coordination.

## Scope

In scope:

- Forked agents for background tasks (session memory extraction, summarization)
- Subagent spawning for user-initiated task delegation
- Context isolation and sharing strategies
- Agent lifecycle management and cleanup

Out of scope:

- Multi-agent coordination/orchestration (swarms, teams)
- Remote agent execution
- Agent-to-agent communication protocols

## Current State

Today DigitalMe has no support for forked agents or subagents. The agent runs as a single instance per conversation session.

### Current Gaps

| Aspect | Status |
|--------|--------|
| Forked agents | None — all work runs in the main agent loop |
| Subagents | None — no task delegation capability |
| Background processing | None — extraction/summarization would block the response |
| Context isolation | N/A |
| Cache sharing | N/A |

## Claudy Patterns Worth Borrowing

Claudy implements two distinct agent spawning mechanisms that serve different purposes.

### Forked Agent vs Subagent vs Fork Subagent

Claudy has three types of spawned agents:

| Aspect | Forked Agent | Subagent (AgentTool) | Fork Subagent |
|--------|--------------|---------------------|---------------|
| **Who triggers** | Internal code | Model via Task tool | Model via Task tool (no type) |
| **Context** | Shares parent's | Fresh (own prompt) | Inherits parent's |
| **Cache sharing** | Yes | No | Yes |
| **User visible** | No | Yes | Yes |
| **Examples** | session_memory, compact | Explore, Plan | Implicit fork |

### Forked Agent Architecture

**Claudy source:** `src/utils/forkedAgent.ts`

Forked agents are used for **internal background tasks** that need to share the parent's prompt cache for cost efficiency.

**Key components:**

```typescript
// CacheSafeParams - must be identical for cache sharing
type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]  // Parent's messages for cache prefix
}

// Creates isolated context for subagent
function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext
```

**Isolation by default:**
- `readFileState` — cloned from parent
- `abortController` — new child controller (parent abort propagates)
- `setAppState`, `setResponseLength` — no-op
- `toolDecisions` — fresh

**Opt-in sharing for interactive subagents:**
```typescript
const ctx = createSubagentContext(parentContext, {
  shareSetAppState: true,      // Update shared state
  shareAbortController: true,  // Abort with parent
})
```

### When Forked Agents Are Triggered

Claudy uses forked agents for these internal tasks:

| Use Case | When Triggered | QuerySource |
|----------|----------------|-------------|
| **Session Memory** | After each turn when token/tool-call thresholds are met | `session_memory` |
| **Compaction** | When autocompact triggers | `compact` |
| **Prompt Suggestion** | After model response | `prompt_suggestion` |
| **Speculation** | Background prefetch | `speculation` |
| **Skills/Commands** | Slash command execution | `skill` |
| **Side Question** | `/btw` command | `side_question` |

**Session Memory trigger conditions:**
```typescript
// Triggers when BOTH are true:
// 1. Token growth threshold met (e.g., 5,000 tokens since last extraction)
// 2. EITHER tool-call threshold met (e.g., 3 tool calls) OR no pending tool calls

const shouldExtract =
  (hasMetTokenThreshold && hasMetToolCallThreshold) ||
  (hasMetTokenThreshold && !hasToolCallsInLastTurn)
```

### Subagent (AgentTool) Architecture

**Claudy source:** `src/tools/AgentTool/`

Subagents are **user-facing** specialized agents spawned via the Task tool.

**Key characteristics:**
- Model decides when to spawn via tool call
- Has its own system prompt (different from parent)
- Can have different tools based on agent type
- Supports foreground or background execution
- Supports isolation modes (worktree, remote)

**Schema:**
```typescript
Task({
  subagent_type: 'Explore',  // Selects agent definition
  prompt: 'Find all API endpoints',
  description: 'Explore API endpoints',
  run_in_background: true,   // Optional: async execution
  model: 'haiku',            // Optional: model override
})
```

**Available agent types in Claudy:**
- `general-purpose` — default multi-tool agent
- `Explore` — fast codebase exploration
- `Plan` — architectural planning
- `code-reviewer` — code review
- `claude-code-guide` — documentation lookup
- Custom agents defined in `.claude/agents/`

### Fork Subagent (Experimental)

**Claudy source:** `src/tools/AgentTool/forkSubagent.ts`

A hybrid that combines:
- User-visible (like subagent)
- Inherits full context (like forked agent)
- Shares prompt cache (like forked agent)

**Triggered when:** Model calls Task tool **without** `subagent_type`

**Use case from prompt:**
> Fork yourself (omit `subagent_type`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative — "will I need this output again" — not task size.

**Recursion guard:**
```typescript
// Prevents fork children from forking again
function isInForkChild(messages: Message[]): boolean {
  return messages.some(m =>
    m.message.content.includes('<fork-boilerplate>')
  )
}
```

### Post-Sampling Hooks

Claudy uses a hook system to trigger forked agents after model responses:

```typescript
// Register hook at startup
registerPostSamplingHook(extractSessionMemory)

// Hook runs after each model response
const extractSessionMemory = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  // Only run on main REPL thread
  if (querySource !== 'repl_main_thread') return

  // Check thresholds
  if (!shouldExtractMemory(messages)) return

  // Run forked agent
  runForkedAgent({
    promptMessages: [createUserMessage({ content: userPrompt })],
    cacheSafeParams: createCacheSafeParams(context),
    querySource: 'session_memory',
    forkLabel: 'session_memory',
  })
})
```

### Execution Flow

```
User sends message
       │
       ▼
┌──────────────────┐
│   Main Query     │
│     Loop         │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Model Response  │───────────────────────────────────────┐
└────────┬─────────┘                                       │
         │                                                 │
         │ ◄── Tool calls? ──►                             │
         │                                                 │
    ┌────┴────┐                                            │
    │  Yes    │                                            │
    ▼         ▼                                            │
┌────────┐  ┌────────────────┐                             │
│ Task   │  │ Other Tools    │                             │
│ Tool?  │  │ (Bash, Read..) │                             │
└────┬───┘  └────────────────┘                             │
     │                                                     │
     ▼                                                     │
┌─────────────────────┐                                    │
│ subagent_type       │                                    │
│ specified?          │                                    │
└──────┬──────────────┘                                    │
       │                                                   │
   ┌───┴───┐                                               │
   │ Yes   │ No (fork enabled)                             │
   ▼       ▼                                               │
┌──────┐ ┌───────────┐                                     │
│Subagt│ │Fork       │                                     │
│(own  │ │Subagent   │                                     │
│prompt│ │(inherits  │                                     │
│)     │ │context)   │                                     │
└──────┘ └───────────┘                                     │
                                                           │
         │◄────────── After response ──────────────────────┘
         ▼
┌──────────────────────────────────────┐
│       Post-Sampling Hooks            │
│  (run after each model response)     │
└──────────────────────────────────────┘
         │
         ├──► Session Memory extraction? ──► launchForkedAgent
         │    (if token/tool thresholds met)
         │
         ├──► Prompt Suggestion? ──► launchForkedAgent
         │
         └──► Other hooks...
```

## Target Design for DigitalMe Agent

### Phase 1: Forked Agents for Background Tasks

The immediate need is forked agents to support context management (session memory extraction, summarization) without blocking responses.

#### `src/agent/fork/ForkedAgent.ts`

```typescript
interface ForkedAgentConfig {
  /** Label for analytics and logging */
  forkLabel: string
  /** Skip transcript recording */
  skipTranscript?: boolean
}

interface LaunchForkedAgentParams {
  /** Synthetic submission for the forked execution */
  submission: TurnSubmission
  /** Shared executor instance */
  turnExecutor: Pick<TurnExecutor, 'run'>
  /** Per-invocation overrides (maxTurns, maxOutputTokens, model, toolRegistry) */
  options?: ExecutionOptions
  /** Session runtime for lifecycle tracking */
  sessionRuntime: SessionRuntime
  /** Per-session concurrency limiter */
  forkSemaphore: ForkSemaphore
  /** Called on successful completion only */
  onResult?: (result: ForkedAgentResult) => void | Promise<void>
  /** Configuration */
  config: ForkedAgentConfig
}

interface ForkedAgentResult {
  /** Token usage across all API calls */
  totalUsage: TokenUsage
  /** Final text output from the fork */
  finalText: string
}

function launchForkedAgent(params: LaunchForkedAgentParams): ForkedAgentHandle | null
```

Note: Context isolation (abort controller, tool restrictions) is handled inline by `launchForkedAgent()` — there is no separate `ForkedContext` class. Abort wiring is done via a child `AbortController` linked to the parent signal. Tool restrictions are passed via `ExecutionOptions.toolRegistry`.

### Phase 2: Subagents for Task Delegation

Later, add user-facing subagent support for specialized task delegation.

#### `src/agent/subagent/AgentDefinition.ts`

```typescript
interface AgentDefinition {
  /** Unique agent type name */
  agentType: string
  /** When the model should use this agent */
  whenToUse: string
  /** Tools available to this agent */
  tools: string[] | '*'
  /** Maximum turns */
  maxTurns: number
  /** Model to use (or 'inherit') */
  model: string | 'inherit'
  /** System prompt generator */
  getSystemPrompt: () => string | Promise<string>
}
```

#### `src/agent/subagent/SubagentTool.ts`

```typescript
interface SubagentInput {
  /** Task description */
  description: string
  /** Detailed prompt for the agent */
  prompt: string
  /** Agent type to use */
  subagent_type: string
  /** Optional model override */
  model?: 'sonnet' | 'opus' | 'haiku'
  /** Run in background */
  run_in_background?: boolean
}

const SubagentTool: Tool<SubagentInput, SubagentResult> = {
  name: 'Task',
  description: 'Launch a specialized agent to handle complex tasks',
  // ...
}
```

### Phase 3: Post-Turn Hooks

Add a hook system for triggering forked agents after model responses.

#### `src/agent/hooks/PostTurnHooks.ts`

```typescript
type PostTurnHook = (context: PostTurnHookContext) => Promise<void>

interface PostTurnHookContext {
  sessionState: SessionState
  sessionRuntime: SessionRuntime
  forkSemaphore: ForkSemaphore
  turnExecutor: Pick<TurnExecutor, 'run'>
  conversationId: string
  lastResult: TurnExecutionResult
}

class PostTurnHookRegistry {
  register(hook: PostTurnHook): void
  unregister(hook: PostTurnHook): void
  runAll(context: PostTurnHookContext): Promise<void>
}
```

Timeouts are enforced inside `PostTurnHookRegistry.runAll()`. The timeout only bounds hook launch logic; it does not cancel a fork that has already been launched.

```typescript
class PostTurnHookRegistry {
  constructor(private readonly timeoutMs: number = 30_000) {}

  async runAll(context: PostTurnHookContext): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await Promise.race([
          hook(context),
          sleep(this.timeoutMs).then(() => {
            throw new Error('post_turn_hook_timeout');
          }),
        ]);
      } catch (err) {
        logger.error(`Post-turn hook failed: ${err}`);
      }
    }
  }
}
```

### Shared Code, Independent Runtimes

All agent types (main turn, forked agent, subagent) call `run()` on the **same `TurnExecutor` instance**. Each call creates a fresh async generator with its own message array, turn counter, token tracking, and abort signal. The executor itself is stateless — `run()` reads only from its parameters and the immutable `AgentConfig`, so concurrent generator instances are safe.

Per-invocation differences (maxTurns, tools, model) are passed via `ExecutionOptions`, not by constructing separate executors.

This mirrors claudy's architecture, where main REPL, forked agents, subagents, and fork subagents all call the same `query()` async generator independently.

```
                 Same TurnExecutor instance
                          │
Main turn:     .run(httpSubmission)                    ← generator instance A
                  ↓ events forwarded to SSE stream

Forked agent:  .run(syntheticSubmission, { maxTurns: 3, toolRegistry: emptyRegistry })  ← generator instance B
                  ↓ events discarded (silent)

Subagent:      .run(subagentSubmission, { model: '...', toolRegistry: filteredRegistry })  ← generator instance C
                  ↓ events collected for parent tool result
```

The wrappers (`SessionRuntime`, `launchForkedAgent`, `SubagentTool`) handle context isolation, result delivery, and lifecycle — but the ReAct loop itself is identical.

### TurnExecutor Generator Refactor + ExecutionOptions

Before building forked agents, two refactors to `TurnExecutor`:

1. **Convert `run()` to async generator** — yields events directly instead of pushing to EventQueue
2. **Add `ExecutionOptions` parameter** — per-invocation overrides for maxTurns, maxOutputTokens, model, and tools

#### Why ExecutionOptions is needed

Today `TurnExecutor.run()` hardcodes its behavior from `AgentConfig` and `ToolRegistry` set at construction time (lines 77, 82-88 of TurnExecutor.ts). Forked agents and subagents need per-invocation overrides:

- Forked agent for session memory: `maxTurns: 3`, `maxOutputTokens: 2048`, no tools
- Forked agent for compaction: `maxTurns: 3`, `maxOutputTokens: 4096`, no tools
- Subagent: different model, different tool set, different maxTurns

Without a formal override layer, callers would either have to construct a new `TurnExecutor` with a modified `AgentConfig` (clunky, duplicates the executor) or stuff overrides into the `TurnSubmission` (wrong abstraction level).

#### ExecutionOptions interface

```typescript
interface ExecutionOptions {
  /** Override max turns (default: config.limits.max_turns) */
  maxTurns?: number;
  /** Override max output tokens (default: config.model.max_output_tokens) */
  maxOutputTokens?: number;
  /** Override model name (default: config.model.name) */
  model?: string;
  /** Override tool registry (default: this.toolRegistry) */
  toolRegistry?: IToolRegistry;
}
```

#### After (generator-based with ExecutionOptions):

```typescript
// TurnExecutor — yields events inline, accepts per-invocation overrides
async *run(
  submission: TurnSubmission,
  options?: ExecutionOptions,
  activeTurn?: ActiveTurn,
): AsyncGenerator<AgentEvent, TurnExecutionResult> {
  const maxTurns = options?.maxTurns ?? this.config.limits.max_turns;
  const maxOutputTokens = options?.maxOutputTokens ?? this.config.model.max_output_tokens;
  const modelName = options?.model ?? this.config.model.name;
  const toolRegistry = options?.toolRegistry ?? this.toolRegistry;

  // ... same ReAct loop, but uses local vars instead of this.config/this.toolRegistry ...

  while (context.turnCount < maxTurns) {
    const result = await client.generate({
      model: modelName,
      messages: context.messages,
      tools: toolRegistry.listDefinitions(),
      maxOutputTokens,
      // ...
    });

    if (result.type === 'final_text') {
      if (result.text) {
        yield { type: 'text_delta', content: result.text };
      }
      yield { type: 'done', truncated: result.truncated, tokenUsage: result.tokenUsage };
      return {
        finalText: result.text ?? '',
        tokenUsage: result.tokenUsage,
        completedTurns: context.turnCount,
        toolCallCount,
        promptMessages: [ /* ... */ ],
      };
    }

    // Tool events
    yield { type: 'tool_start', name: call.function.name, callId: call.id };
    // ... execute tool ...
    yield { type: 'tool_end', name: call.function.name, callId: call.id, success: toolResult.success };
  }
}

// Main turn — no options, uses defaults from config
const gen = turnExecutor.run(submission);

// Forked agent — overrides maxTurns, tools, maxOutputTokens
const gen = turnExecutor.run(submission, {
  maxTurns: 3,
  maxOutputTokens: 2048,
  toolRegistry: emptyToolRegistry,
});

// Subagent — overrides model and tools
const gen = turnExecutor.run(submission, {
  model: 'gpt-4o-mini',
  maxTurns: 50,
  toolRegistry: filteredRegistry,
});
```

**Helper to extract the return value:**

```typescript
async function consumeGenerator(
  gen: AsyncGenerator<AgentEvent, TurnExecutionResult>,
  onEvent: (event: AgentEvent) => void,
): Promise<TurnExecutionResult> {
  let iterResult = await gen.next();
  while (!iterResult.done) {
    onEvent(iterResult.value);
    iterResult = await gen.next();
  }
  return iterResult.value;  // The TurnExecutionResult from `return`
}
```

**What this eliminates:**
- `EventQueue` class (44 lines) — no longer needed inside TurnExecutor
- The `events` parameter on `run()` — one fewer dependency to thread
- For forked agents: no silent queue creation, no drain helper, no close/leak risk
- Constructing separate TurnExecutor instances with modified configs

**What stays:**
- `EventQueue` may still be used at the HTTP layer (SSE bridge in `routes/turns.ts` or `SessionRuntime`) — it's just no longer coupled to the executor.

#### Impact on callers

| Caller | Before | After |
|--------|--------|-------|
| `SessionRuntime.execute()` | Creates EventQueue, passes to `run()` | Iterates generator, forwards events to SSE |
| `launchForkedAgent()` | Would need new TurnExecutor instance | Passes `ExecutionOptions` with overrides |
| `SubagentTool` | Would need new TurnExecutor instance | Passes `ExecutionOptions` with model/tools |
| `routes/turns.ts` | Reads from EventQueue | Unchanged (SessionRuntime still bridges) |

### ForkedAgent Execution Detail

This section specifies how `launchForkedAgent` actually runs.

#### How it drives the query loop

Forked agents call the **same TurnExecutor instance** as the main turn, but with `ExecutionOptions` overrides. The executor is stateless — `run()` reads only from its parameters and the immutable config, so concurrent calls are safe.

The actual fork execution is handled by `launchForkedAgent()` (see "Hook ownership model" above), which builds the submission, acquires the semaphore, and wires up cleanup. The lower-level flow is:

```typescript
// Inside launchForkedAgent():

// 1. Build a synthetic TurnSubmission (no real HTTP request)
const submission: TurnSubmission = {
  requestId: `fork-${config.forkLabel}-${crypto.randomUUID()}`,
  conversationId: parentContext.conversationId,
  userMessage: '',
  history: [],
  promptHistory: promptMessages,
  signal: childAbort.signal,
};

// 2. Run via TurnExecutor generator with per-fork overrides (from options param)
const result = await consumeGenerator(
  turnExecutor.run(submission, options),
  (_event) => { /* discard — forked agents are silent */ },
);
```

**Key decisions:**
- **Same TurnExecutor instance**: Forked agents pass `ExecutionOptions` to override maxTurns, tools, etc. No need to construct separate executor instances.
- **ModelClient**: Created per `run()` invocation via `ModelClientFactory.createClient()`, matching the current executor. This avoids accidental shared mutable request state while still allowing concurrent main-turn and fork execution.
- **SystemPromptBuilder**: Reused from the same injected deps. The forked agent can use the same system prompt as the parent, or a custom one (passed via `promptMessages`).
- **No EventQueue**: The generator is consumed directly. Events are discarded (or optionally collected for logging). No queue lifecycle to manage.
- **Tools**: Per-invocation `toolRegistry` override via `ExecutionOptions`. For session memory extraction, this is an empty registry (no tools). For subagents, a filtered subset.

#### How forked agents differ from the main turn

| Aspect | Main Turn | Forked Agent |
|--------|-----------|--------------|
| TurnSubmission source | HTTP request | Synthetic (generated internally) |
| Generator consumption | Forward events to SSE stream | Discard events (silent) |
| ExecutionOptions | None (uses config defaults) | Overrides maxTurns, tools, maxOutputTokens |
| Signal | From HTTP request abort | Child AbortController linked to parent |
| Result destination | Committed to SessionState | Delivered via `onResult` callback |
| Semaphore | N/A | Acquired before launch, released in `finally` |

### Result Delivery

Forked agents produce output that needs to flow back to the session. The mechanism depends on the use case.

#### Callback-based result delivery

Each forked agent receives an `onResult` callback that is responsible for persisting the output:

```typescript
interface LaunchForkedAgentParams {
  // ... existing fields ...

  /**
   * Called when the forked agent completes successfully.
   * The callback receives the final text and collected events.
   * It is responsible for persisting the result (e.g., writing to SessionState).
   */
  onResult?: (result: ForkedAgentResult) => void | Promise<void>;
}
```

#### Per-use-case result flow

**Session memory extraction:**
```typescript
const sessionMemoryHook: PostTurnHook = async (hookContext) => {
  launchForkedAgent({
    // ... config ...
    onResult: async (agentResult) => {
      // The forked agent's finalText contains extracted memories as structured text.
      // Parse and write to SessionState's memory store.
      const memories = parseExtractedMemories(agentResult.finalText);
      hookContext.sessionState.addMemories(memories);
    },
  });
};
```

**Summarization:**
```typescript
const summarizationHook: PostTurnHook = async (hookContext) => {
  const startRevision = hookContext.sessionState.getRevision();
  launchForkedAgent({
    // ... config ...
    onResult: async (agentResult) => {
      // Replace the prompt history with the summarized version if state has not advanced.
      hookContext.sessionState.compactHistory(agentResult.finalText, startRevision);
    },
  });
};
```

**Key principle:** The forked agent itself doesn't know where its output goes. The `onResult` callback is the seam between "agent execution" and "result integration." This keeps `ForkedAgent.ts` generic and testable — tests can assert on the callback invocation without needing a real `SessionState`.

### Lifecycle and Cleanup

#### Abort propagation

```
HTTP Request abort
       │
       ▼
  Parent AbortController  ────► Parent TurnExecutor stops
       │
       ▼ (if shareAbortController: true, or default child controller)
  Child AbortController   ────► Forked agent stops
```

`launchForkedAgent()` creates a **child AbortController** linked to the parent's signal (see implementation in "Hook ownership model" section):

```typescript
// Inside launchForkedAgent():
const childAbort = new AbortController();
if (submission.signal) {
  submission.signal.addEventListener('abort', () => childAbort.abort(), { once: true });
}
// Fork runs with childAbort.signal
```

This means:
- Parent abort → forked agent aborts (always)
- Forked agent abort → parent is unaffected (one-way)

#### Tracking active forked agents

`SessionRuntime` tracks running forked agents so they can be cleaned up:

```typescript
export class SessionRuntime {
  private activeTurn?: ActiveTurn;
  private readonly activeForkedAgents = new Map<string, ForkedAgentHandle>();

  // Called by hooks when launching a forked agent
  registerForkedAgent(handle: ForkedAgentHandle): void {
    this.activeForkedAgents.set(handle.id, handle);
    handle.promise.finally(() => {
      this.activeForkedAgents.delete(handle.id);
    });
  }

  // Called during session eviction or drain
  abortForkedAgents(): void {
    for (const handle of this.activeForkedAgents.values()) {
      handle.abort();
    }
    this.activeForkedAgents.clear();
  }

  hasActiveWork(): boolean {
    return this.hasActiveTurn() || this.activeForkedAgents.size > 0;
  }
}

interface ForkedAgentHandle {
  id: string;
  forkLabel: string;
  abort: () => void;
  promise: Promise<ForkedAgentResult>;
}
```

#### Session eviction with active forked agents

Update `SessionManager.evictExpiredSessions()`:

```typescript
private evictExpiredSessions() {
  const ttlMs = this.config.limits.session_ttl_seconds * 1000;
  const cutoff = Date.now() - ttlMs;
  for (const [conversationId, runtime] of this.sessions.entries()) {
    if (runtime.hasActiveWork()) {  // Changed: checks both turns AND forked agents
      continue;
    }
    if (runtime.state.getLastAccessedAt() < cutoff) {
      runtime.abortForkedAgents();  // Belt-and-suspenders cleanup
      this.sessions.delete(conversationId);
    }
  }
}
```

#### New turn arrives while forked agent is running

Forked agents operate on a snapshot of the prompt history. A new turn modifies `SessionState` while the fork runs. Without protection, a fork's `onResult` could apply stale output to newer state — particularly dangerous for compaction (history replacement).

#### State versioning via revision counter

Add a monotonically increasing `revision` to `SessionState`. Every mutation increments it. Fork results carry the revision they started from and use a CAS (compare-and-swap) check before applying.

```typescript
// SessionState additions:
export class SessionState {
  private revision = 0;

  /** Returns current revision (snapshot point for forks). */
  getRevision(): number {
    return this.revision;
  }

  /** Increment revision on every state mutation. */
  commitTask(userMessage: string, finalText: string, promptMessages: Message[]) {
    this.revision++;
    // ... existing logic ...
  }

  reconcileWithPlatformHistory(history: HistoryMessage[]) {
    // ... existing logic ...
    if (result === 'reseeded') {
      this.revision++;
    }
    return result;
  }

  // NOTE: Session memory extraction does NOT write to SessionState.
  // The forked agent writes session memory to disk at:
  //   /tmp/digitalme-agent/<conversation-id>/session-memory.md
  // via the Edit tool. Tracking metadata (lastSummarizedMessageId, etc.)
  // is stored on the SessionMemory instance, not SessionState.
  // See track 02_context_management for the full storage model.

  /**
   * Destructive mutation — only safe if state hasn't moved on.
   * Used by compaction/summarization.
   * Returns false if revision has advanced (caller should discard result).
   */
  compactHistory(summary: string, startRevision: number): boolean {
    if (this.revision !== startRevision) {
      return false;  // State has moved on — discard stale compaction
    }
    this.revision++;
    this.promptHistory = [{ role: 'assistant', content: summary }];
    return true;
  }
}
```

#### Per-use-case safety model

| Operation | Revision check | Rationale |
|-----------|---------------|-----------|
| Session memory extraction | None — writes to disk, not SessionState | The forked agent writes to a file via the Edit tool. No in-memory state mutation. Tracking metadata is on the `SessionMemory` instance. |
| `compactHistory()` | CAS on startRevision | Destructive — replaces history. Stale compaction would discard newer turns. |

#### How forks capture the revision

The `onResult` callback captures the revision at fork launch time (via closure), then passes it to destructive operations:

```typescript
const sessionMemoryHook: PostTurnHook = async (hookContext) => {
  // Session memory extraction writes to disk via forked agent's Edit tool.
  // The forked agent is restricted to only edit the session memory file at:
  //   /tmp/digitalme-agent/<conversation-id>/session-memory.md
  // No SessionState mutation needed — the forked agent's tool calls handle persistence.
  // Tracking metadata (lastSummarizedMessageId, etc.) is updated on the
  // SessionMemory instance after the fork completes.
  launchForkedAgent({
    // ... submission, turnExecutor, forkSemaphore, sessionRuntime ...
    config: { forkLabel: 'session_memory' },
    options: {
      maxTurns: 3,
      maxOutputTokens: 2048,
      toolRegistry: sessionMemoryToolRegistry,  // Only Edit tool on memory file
    },
    onResult: async (agentResult) => {
      // Update tracking metadata (not SessionState)
      hookContext.sessionMemory.updateLastSummarizedMessageId(
        hookContext.lastMessageId,
      );
    },
  });
  // Returns immediately — fork runs in background
};

const compactionHook: PostTurnHook = async (hookContext) => {
  const startRevision = hookContext.sessionState.getRevision();

  launchForkedAgent({
    // ... submission, turnExecutor, forkSemaphore, sessionRuntime ...
    config: { forkLabel: 'compaction' },
    options: { maxTurns: 3, maxOutputTokens: 4096, toolRegistry: emptyRegistry },
    onResult: async (agentResult) => {
      const applied = hookContext.sessionState.compactHistory(
        agentResult.finalText,
        startRevision,
      );
      if (!applied) {
        logger.info('Compaction discarded: session state advanced during fork');
      }
    },
  });
  // Returns immediately — fork runs in background
};
```

### Concurrency Control

#### Where concurrency is tracked

A `ForkSemaphore` lives on `SessionRuntime` (per-conversation, not global):

```typescript
class ForkSemaphore {
  private running = 0;

  constructor(private readonly maxConcurrent: number) {}

  /** Returns true if a slot was acquired. */
  tryAcquire(): boolean {
    if (this.running >= this.maxConcurrent) return false;
    this.running++;
    return true;
  }

  release(): void {
    this.running = Math.max(0, this.running - 1);
  }
}
```

#### What happens when the limit is hit

**Drop with warning log.** Forked agents are internal background work — if the semaphore is full, the hook logs a warning and skips. No queueing, no error propagation. The work is best-effort.

#### Hook ownership model: fire-and-forget with handle-owned cleanup

There is exactly one ownership model. Hooks **launch** forked agents and return immediately. The **handle's promise** owns semaphore release and cleanup — not the hook, not the registry.

```typescript
// launchForkedAgent: the single entry point for spawning a fork.
// It acquires the semaphore, starts the fork, and wires up cleanup.
// Returns null if the semaphore is full (caller should skip).

function launchForkedAgent(params: LaunchForkedAgentParams): ForkedAgentHandle | null {
  const { forkSemaphore, sessionRuntime, turnExecutor, config, submission, options, onResult } = params;

  // 1. Acquire semaphore — if full, skip
  if (!forkSemaphore.tryAcquire()) {
    logger.warn(`[${submission.conversationId}] Skipping fork ${config.forkLabel}: max concurrent reached`);
    return null;
  }

  // 2. Create child abort controller
  const childAbort = new AbortController();

  // 3. Start the fork (not awaited — runs in background)
  const promise = (async () => {
    try {
      const result = await consumeGenerator(
        turnExecutor.run({ ...submission, signal: childAbort.signal }, options),
        (_event) => { /* discard */ },
      );
      const forkedResult: ForkedAgentResult = {
        totalUsage: result.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalText: result.finalText,
      };
      // Deliver result on success only
      await onResult?.(forkedResult);
      return forkedResult;
    } catch (err) {
      if (childAbort.signal.aborted) {
        logger.info(`Fork ${config.forkLabel} aborted`);
      } else {
        logger.error(`Fork ${config.forkLabel} failed: ${err}`);
      }
      throw err;
    } finally {
      // 4. ALWAYS release semaphore — this is the single release point
      forkSemaphore.release();
    }
  })();

  const handle: ForkedAgentHandle = {
    id: `fork-${config.forkLabel}-${crypto.randomUUID()}`,
    forkLabel: config.forkLabel,
    abort: () => childAbort.abort(),
    promise,
  };

  // 5. Register handle (auto-deregisters on completion via promise.finally in registerForkedAgent)
  sessionRuntime.registerForkedAgent(handle);

  return handle;
}
```

#### How hooks use it

Hooks are thin — they check thresholds, then call `launchForkedAgent()` and return immediately:

```typescript
// In PostTurnHookRegistry.runAll():
async runAll(context: PostTurnHookContext): Promise<void> {
  for (const hook of this.hooks) {
    try {
      await hook(context);  // Hook returns immediately after launching fork
    } catch (err) {
      logger.error(`Post-turn hook failed: ${err}`);
      // Swallow — never crash the main agent
    }
  }
}

// A hook implementation:
const sessionMemoryHook: PostTurnHook = async (hookContext) => {
  if (!shouldExtractMemory(hookContext)) return;

  const startRevision = hookContext.sessionState.getRevision();

  // Launch and return — launchForkedAgent handles semaphore, cleanup, everything
  launchForkedAgent({
    forkSemaphore: hookContext.forkSemaphore,
    sessionRuntime: hookContext.sessionRuntime,
    turnExecutor: hookContext.turnExecutor,
    config: { forkLabel: 'session_memory' },
    submission: buildMemoryExtractionSubmission(hookContext),
    options: { maxTurns: 3, maxOutputTokens: 2048, toolRegistry: emptyRegistry },
    onResult: async (result) => {
      const memories = parseExtractedMemories(result.finalText);
      hookContext.sessionState.addMemories(memories);
    },
  });
  // Returns immediately — fork runs in background
};
```

#### Ownership summary

| Concern | Owner | Mechanism |
|---------|-------|-----------|
| Semaphore acquire | `launchForkedAgent()` | `tryAcquire()` before starting |
| Semaphore release | `launchForkedAgent()` promise `finally` | Always releases, even on error/abort |
| Handle registration | `launchForkedAgent()` | Calls `sessionRuntime.registerForkedAgent()` |
| Handle deregistration | `registerForkedAgent()` | `handle.promise.finally(() => delete)` |
| Abort on drain/eviction | `SessionManager.beginDrain()` / eviction | Calls `runtime.abortForkedAgents()` |
| Result delivery | `launchForkedAgent()` promise | Calls `onResult` on success only |
| Timeout enforcement | `PostTurnHookRegistry.runAll()` | `Promise.race` with timeout on the hook call (not the fork) |

**The main conversation is never blocked by forked agent execution.**

### TurnContext Adaptation

No separate `ForkedTurnContext` class is needed. `TurnExecutor.run()` takes a `TurnSubmission` and builds its own `TurnContext` internally. Forked agents construct a synthetic `TurnSubmission` with:
- `promptHistory` — pre-built messages (the fork's starting context)
- `signal` — child abort controller's signal
- `requestId` — synthetic ID with fork label
- `conversationId` — inherited from parent
- `userMessage` / `history` — empty (unused when `promptHistory` is set)

This is sufficient — `TurnContext` is an internal detail of `TurnExecutor`, not an external interface that callers need to implement.

### Subagent Tool Permission Model

Subagents inherit tool permissions from the parent with optional restrictions:

```typescript
interface AgentDefinition {
  // ... existing fields ...

  /**
   * Tools available to this agent.
   * - '*': inherit all parent tools (default)
   * - string[]: only these tools (must be subset of parent's tools)
   *
   * A subagent can NEVER use tools the parent doesn't have.
   */
  tools: string[] | '*';

  /**
   * Tools explicitly denied to this agent.
   * Applied after `tools` resolution. Useful with tools: '*' to
   * allow everything except specific tools.
   */
  disallowedTools?: string[];
}
```

Resolution logic:
```typescript
function resolveSubagentTools(
  definition: AgentDefinition,
  parentRegistry: IToolRegistry,
): IToolRegistry {
  const parentNames = new Set(parentRegistry.listNames());
  const disallowed = new Set(definition.disallowedTools ?? []);

  let allowed: Set<string>;
  if (definition.tools === '*') {
    allowed = parentNames;
  } else {
    // Intersect with parent — never escalate
    allowed = new Set(definition.tools.filter(t => parentNames.has(t)));
  }

  // Apply denials
  for (const name of disallowed) {
    allowed.delete(name);
  }

  return createFilteredRegistry(parentRegistry, allowed);
}
```

### Default Configuration Values by Use Case

| Use Case | maxTurns | maxOutputTokens | Tools | Priority |
|----------|----------|-----------------|-------|----------|
| Session memory extraction | 3 | 2048 | none (text generation only) | Low |
| Summarization / compaction | 3 | 4096 | none | Low |
| Subagent (general) | 50 | 8192 | inherited | Normal |
| Subagent (explore/search) | 20 | 4096 | read-only subset | Normal |

### Key Differences from Claudy

| Aspect | Claudy | DigitalMe | Rationale |
|--------|--------|-----------|-----------|
| Query loop shape | `async *query()` generator | `async *run()` generator | Same pattern — cleanest for both streaming and silent consumption |
| Cache sharing | Critical for cost | Not needed | No Claude prompt cache API |
| Agent definitions | File-based (.claude/agents/) | Config-based | Simpler deployment |
| Isolation modes | worktree, remote | None initially | Focus on core functionality |
| Background execution | Complex async task system | Simple Promise-based | Sufficient for our use cases |
| Fork subagent | Experimental feature | Defer | Added complexity |

### New Modules

```
src/agent/fork/
├── ForkedAgent.ts           # Core launchForkedAgent() function
├── ForkSemaphore.ts         # Per-session concurrency limiter
├── index.ts                 # Exports

src/agent/subagent/           # Phase 2
├── AgentDefinition.ts       # Agent type definitions
├── SubagentTool.ts          # Task tool implementation
├── BuiltInAgents.ts         # Default agent types
├── index.ts                 # Exports

src/agent/hooks/
├── PostTurnHooks.ts         # Hook registry and runner
├── index.ts                 # Exports
```

### Existing Files To Change

#### `src/agent/TurnExecutor.ts`

Two changes: (1) convert `run()` to async generator, (2) add `ExecutionOptions` parameter.

```typescript
// New: per-invocation overrides
interface ExecutionOptions {
  maxTurns?: number;
  maxOutputTokens?: number;
  model?: string;
  toolRegistry?: IToolRegistry;
}

// Change run() from:
//   async run(submission, events, activeTurn?): Promise<TurnExecutionResult>
// To:
async *run(
  submission: TurnSubmission,
  options?: ExecutionOptions,
  activeTurn?: ActiveTurn,
): AsyncGenerator<AgentEvent, TurnExecutionResult> {
  // Resolve per-invocation overrides:
  const maxTurns = options?.maxTurns ?? this.config.limits.max_turns;
  const maxOutputTokens = options?.maxOutputTokens ?? this.config.model.max_output_tokens;
  const modelName = options?.model ?? this.config.model.name;
  const toolRegistry = options?.toolRegistry ?? this.toolRegistry;

  // Same ReAct loop body, but:
  //   this.config.limits.max_turns  →  maxTurns (local)
  //   this.config.model.name        →  modelName (local)
  //   this.toolRegistry             →  toolRegistry (local)
  //   events.push(x)                →  yield x
  //   return result                 →  return result (generator return value)
  // Drop the `events` parameter entirely.
}
```

#### `src/agent/SessionRuntime.ts`

Three changes: (1) consume TurnExecutor as generator, (2) integrate hooks, (3) track forked agents.

Hook execution happens here (not in TurnExecutor) because:
1. SessionRuntime owns the `SessionState` that hooks need to write results to
2. Hooks must run **after** the turn result is committed to state
3. Hooks are fire-and-forget — they must not block the response to the user

```typescript
export class SessionRuntime {
  private activeTurn?: ActiveTurn;
  private readonly activeForkedAgents = new Map<string, ForkedAgentHandle>();
  private readonly forkSemaphore: ForkSemaphore;
  private readonly hookRegistry: PostTurnHookRegistry;
  private readonly hooksEnabled: boolean;
  private readonly forksEnabled: boolean;

  constructor(
    readonly state: SessionState,
    private readonly deps: SessionRuntimeDeps,
    hookRegistry?: PostTurnHookRegistry,
    config?: AgentConfig,
  ) {
    this.hookRegistry = hookRegistry ?? new PostTurnHookRegistry(config?.hooks.post_turn.timeout_ms ?? 30_000);
    this.forkSemaphore = new ForkSemaphore(config?.forked_agents.max_concurrent ?? 2);
    this.hooksEnabled = config?.hooks.post_turn.enabled ?? true;
    this.forksEnabled = config?.forked_agents.enabled ?? true;
  }

  async execute(submission: TurnSubmission, events: EventQueue<AgentEvent>) {
    // ... existing code: reconcile, create activeTurn, rollout recording ...

    try {
      // Consume TurnExecutor generator, forwarding events to the SSE EventQueue
      const result = await consumeGenerator(
        this.deps.turnExecutor.run(submission, undefined, activeTurn),
        (event) => events.push(event),
      );

      this.commitResult(submission, result, activeTurn);

      // Fire-and-forget: launch post-turn hooks AFTER committing result
      // This does NOT block the response — events are already yielded to SSE
      if (this.hooksEnabled && this.forksEnabled) {
        this.hookRegistry.runAll({
          sessionState: this.state,
          sessionRuntime: this,
          forkSemaphore: this.forkSemaphore,
          turnExecutor: this.deps.turnExecutor,
          conversationId: submission.conversationId,
          lastResult: result,
        }).catch((err) => {
          logger.error(`Post-turn hooks failed: ${err}`);
        });
      }

      // ... existing rollout recording ...
    }
    // ...
  }

  registerForkedAgent(handle: ForkedAgentHandle): void { /* ... */ }
  abortForkedAgents(): void { /* ... */ }
  hasActiveWork(): boolean { /* ... */ }
}
```

Note: `SessionRuntime.execute()` still takes an `EventQueue` parameter — it's the SSE bridge to the HTTP route. The change is that `TurnExecutor` no longer knows about `EventQueue`; `SessionRuntime` is the adapter between the generator and the SSE stream.

#### `src/agent/SessionManager.ts`

Two changes: (1) eviction respects active forked agents, (2) drain aborts all forked agents.

```typescript
private evictExpiredSessions() {
  // ... existing code ...
  for (const [conversationId, runtime] of this.sessions.entries()) {
    if (runtime.hasActiveWork()) {  // Changed from hasActiveTurn()
      continue;
    }
    if (runtime.state.getLastAccessedAt() < cutoff) {
      runtime.abortForkedAgents();  // Belt-and-suspenders cleanup
      this.sessions.delete(conversationId);
    }
  }
}

beginDrain() {
  this.draining = true;

  // Abort all forked agents across all sessions.
  // Existing in-flight HTTP turns are not force-cancelled by drain in the
  // current runtime; drain rejects new submissions and lets active turns
  // complete. Background forks have no equivalent external coordination, so
  // they must be cancelled explicitly to avoid orphaned work during shutdown.
  for (const runtime of this.sessions.values()) {
    runtime.abortForkedAgents();
  }
}
```

#### `src/config/schema.ts`

Add forked agent and subagent configuration:

```typescript
// Add to agentConfigSchema:
forked_agents: z.object({
  enabled: z.boolean().default(true),
  max_concurrent: z.number().int().positive().default(2),
}).default({}),

hooks: z.object({
  post_turn: z.object({
    enabled: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(30000),
  }).default({}),
}).default({}),

// Phase 2 (not yet):
// subagents: z.object({ ... }).default({}),
```

#### `src/agent/types.ts`

Add forked agent types:

```typescript
export interface ForkedAgentResult {
  totalUsage: TokenUsage;
  finalText: string;
}

export interface ForkedAgentHandle {
  id: string;
  forkLabel: string;
  abort: () => void;
  promise: Promise<ForkedAgentResult>;
}
```

## Suggested Implementation Sequence

### Step 1: TurnExecutor generator refactor + ExecutionOptions + state versioning

Three foundational changes before building forked agents:

1. Convert `TurnExecutor.run()` from EventQueue-push to async generator
2. Add `ExecutionOptions` parameter for per-invocation overrides (maxTurns, model, tools)
3. Add revision counter to `SessionState` for safe fork result integration

Files:
- update `src/agent/TurnExecutor.ts` — convert `run()` to `async *run()`, add `ExecutionOptions` param, drop `events` param
- update `src/agent/types.ts` — add `ExecutionOptions`, `consumeGenerator` helper
- update `src/agent/SessionRuntime.ts` — consume generator via `consumeGenerator()`, forward events to EventQueue
- update `src/agent/SessionState.ts` — add `revision` counter, `getRevision()`, CAS-guarded `compactHistory()`

Test cases:
- Generator yields `text_delta` and `done` events in correct order
- Generator yields `tool_start`/`tool_end` events during tool execution
- Generator return value contains `TurnExecutionResult`
- `ExecutionOptions.maxTurns` overrides config default
- `ExecutionOptions.toolRegistry` overrides default registry
- `ExecutionOptions.maxOutputTokens` overrides config default
- No options → uses config defaults (backwards compatible)
- `consumeGenerator` forwards all events and returns the result
- Existing `SessionRuntime` → SSE flow still works end-to-end
- Abort signal terminates the generator
- `SessionState.revision` increments on `commitTask` and `reconcileWithPlatformHistory`
- `SessionState.compactHistory()` succeeds when revision matches, returns false when stale
- `SessionState.addMemories()` succeeds regardless of revision

Note: `EventQueue` is NOT deleted — it's still used as the SSE bridge between `SessionRuntime` and the HTTP route. It's just no longer passed into `TurnExecutor`.

### Step 2: ForkedAgent runner (`launchForkedAgent`)

The single entry point for spawning forks. Owns semaphore acquire/release, abort wiring, handle registration, result delivery, and cleanup.

Files:
- new `src/agent/fork/ForkedAgent.ts` — `launchForkedAgent()` function
- new `src/agent/fork/ForkSemaphore.ts`
- new `src/agent/fork/index.ts`
- update `src/agent/types.ts` — add `ForkedAgentResult`, `ForkedAgentHandle`

Test cases:
- Forked agent completes and returns `ForkedAgentResult` with finalText
- `ExecutionOptions` overrides are passed through to `TurnExecutor.run()`
- Forked agent discards yielded events (no EventQueue, no side effects)
- `onResult` callback is invoked on success
- `onResult` callback is NOT invoked on abort or error
- Semaphore is acquired before fork starts
- Semaphore is released in `finally` (on success, error, and abort)
- Returns `null` when semaphore is full (caller skips)
- Handle is registered on SessionRuntime and auto-deregistered on completion
- Child abort controller fires when parent aborts

### Step 3: Post-Turn Hooks + Lifecycle integration

Enable triggering forked agents after model responses. Wire up drain and eviction.

Files:
- new `src/agent/hooks/PostTurnHooks.ts`
- new `src/agent/hooks/index.ts`
- update `src/agent/SessionRuntime.ts` — integrate hook registry, fork tracking, semaphore
- update `src/agent/SessionManager.ts` — use `hasActiveWork()` for eviction, abort forks on drain
- update `src/config/schema.ts` — add `forked_agents` and `hooks` config sections

Test cases:
- Hooks run after successful turn completion
- Hooks don't block response to user (fire-and-forget)
- Hook errors don't crash the main agent (caught and logged)
- Hooks can be registered and unregistered
- Hook timeout is enforced
- Session eviction skips sessions with active forked agents
- `abortForkedAgents()` cancels all running forks on session teardown
- `beginDrain()` aborts all forked agents across all sessions
- Orphaned forks do not survive after drain completes

### Step 4: Subagent Tool (Phase 2)

Add user-facing task delegation capability.

Files:
- new `src/agent/subagent/AgentDefinition.ts`
- new `src/agent/subagent/SubagentTool.ts`
- new `src/agent/subagent/BuiltInAgents.ts`
- new `src/agent/subagent/index.ts`
- update `src/tools/index.ts`

Test cases:
- Subagent spawns with specified agent type
- Subagent has its own system prompt
- Subagent result is returned to parent
- Background subagent runs async
- Model override is respected

## Testing Strategy

All new modules should use dependency injection for testability.

Key test patterns:
- **ForkedAgent (`launchForkedAgent`):** Integration tests with fake ModelClient, unit tests for semaphore/abort/handle lifecycle
- **PostTurnHooks:** Unit tests for registry, integration tests for execution flow
- **SubagentTool:** Integration tests with fake subagent execution

## Risks

- **Concurrent execution complexity:** Multiple forked agents running simultaneously could cause race conditions. Mitigation: Use sequential execution for hooks initially, add concurrency control later.
- **Resource exhaustion:** Many forked agents could exhaust memory or API rate limits. Mitigation: Limit concurrent forked agents, implement backpressure.
- **Debugging difficulty:** Forked agent failures may be hard to trace. Mitigation: Clear logging with fork labels, transcript recording.
- **Cost unpredictability:** Forked agents add API calls. Mitigation: Make forked agents opt-in, provide usage metrics.

## Success Criteria

- Forked agents run without blocking the main conversation
- Hook errors don't crash the main agent
- Token usage is tracked across all forked agents
- Forked agent lifecycle is properly managed (cleanup on drain and eviction)
- Stale fork results cannot corrupt session state (revision CAS guard)
- Semaphore release is guaranteed on all code paths
- Main conversation flow is unchanged when forks/hooks are disabled
