# Forked Agents and Subagents

## Goal

Enable the DigitalMe agent to spawn background workers and specialized subagents for parallel task execution, context-efficient background processing, and delegation of specialized tasks.

This track covers the infrastructure for running multiple concurrent agent instances with proper isolation, cache sharing, and coordination.

## Scope

In scope:

- Forked agents for background tasks (session memory extraction, summarization)
- Subagent spawning for user-initiated task delegation
- Context isolation and sharing strategies
- Prompt cache optimization for forked agents
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
  await runForkedAgent({
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
         ├──► Session Memory extraction? ──► runForkedAgent
         │    (if token/tool thresholds met)
         │
         ├──► Prompt Suggestion? ──► runForkedAgent
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
  /** Maximum turns before termination */
  maxTurns?: number
  /** Maximum output tokens */
  maxOutputTokens?: number
  /** Skip transcript recording */
  skipTranscript?: boolean
}

interface ForkedAgentParams {
  /** Messages to start the forked query loop with */
  promptMessages: Message[]
  /** Parent context for cache sharing */
  parentContext: TurnContext
  /** Tools available to the forked agent */
  tools: Tool[]
  /** Permission check function */
  canUseTool: CanUseToolFn
  /** Configuration */
  config: ForkedAgentConfig
}

interface ForkedAgentResult {
  /** All messages yielded during the query loop */
  messages: Message[]
  /** Token usage across all API calls */
  totalUsage: TokenUsage
}

async function runForkedAgent(params: ForkedAgentParams): Promise<ForkedAgentResult>
```

#### `src/agent/fork/ForkedContext.ts`

```typescript
interface ForkedContextConfig {
  /** Clone file state from parent */
  cloneFileState?: boolean
  /** Share abort controller with parent */
  shareAbortController?: boolean
  /** Custom tool restrictions */
  allowedTools?: string[]
}

/**
 * Creates an isolated context for forked agents.
 * By default, all mutable state is isolated to prevent interference.
 */
function createForkedContext(
  parentContext: TurnContext,
  config?: ForkedContextConfig,
): TurnContext
```

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
  messages: Message[]
  turnContext: TurnContext
  lastResponse: AssistantMessage
  tokenUsage: TokenUsage
}

class PostTurnHookRegistry {
  register(hook: PostTurnHook): void
  unregister(hook: PostTurnHook): void
  runAll(context: PostTurnHookContext): Promise<void>
}
```

### Key Differences from Claudy

| Aspect | Claudy | DigitalMe | Rationale |
|--------|--------|-----------|-----------|
| Cache sharing | Critical for cost | Not needed | No Claude prompt cache API |
| Agent definitions | File-based (.claude/agents/) | Config-based | Simpler deployment |
| Isolation modes | worktree, remote | None initially | Focus on core functionality |
| Background execution | Complex async task system | Simple Promise-based | Sufficient for our use cases |
| Fork subagent | Experimental feature | Defer | Added complexity |

### New Modules

```
src/agent/fork/
├── ForkedAgent.ts           # Core forked agent runner
├── ForkedContext.ts         # Context isolation/creation
├── index.ts                 # Exports

src/agent/subagent/
├── AgentDefinition.ts       # Agent type definitions
├── SubagentTool.ts          # Task tool implementation
├── BuiltInAgents.ts         # Default agent types
├── index.ts                 # Exports

src/agent/hooks/
├── PostTurnHooks.ts         # Hook registry and runner
├── SessionMemoryHook.ts     # Session memory extraction hook
├── index.ts                 # Exports
```

### Existing Files To Change

#### `src/agent/TurnExecutor.ts`

Add post-turn hook execution:

```typescript
async execute(submission, events) {
  // ... existing turn execution ...

  // After successful turn completion:
  await this.hookRegistry.runAll({
    messages: this.state.getPromptHistory(),
    turnContext: this.context,
    lastResponse: response,
    tokenUsage: usage,
  })
}
```

#### `src/agent/SessionRuntime.ts`

Initialize hook registry and register session memory hook:

```typescript
constructor(config) {
  // ...
  this.hookRegistry = new PostTurnHookRegistry()

  if (config.sessionMemory?.enabled) {
    this.hookRegistry.register(createSessionMemoryHook(config.sessionMemory))
  }
}
```

#### `src/config/schema.ts`

Add forked agent and subagent configuration:

```yaml
forked_agents:
  enabled: true
  max_concurrent: 2
  default_max_turns: 50
  default_max_output_tokens: 4096

subagents:
  enabled: false  # Phase 2
  definitions: []

hooks:
  post_turn:
    enabled: true
    timeout_ms: 30000
```

## Suggested Implementation Sequence

### Step 1: ForkedContext and ForkedAgent

The foundation for running isolated agent instances.

Files:
- new `src/agent/fork/ForkedContext.ts`
- new `src/agent/fork/ForkedAgent.ts`
- new `src/agent/fork/index.ts`

Test cases:
- Forked context has isolated mutable state
- Parent abort propagates to forked agent
- Forked agent completes and returns messages
- Forked agent respects maxTurns limit
- Token usage is accumulated across turns

### Step 2: Post-Turn Hooks

Enable triggering forked agents after model responses.

Files:
- new `src/agent/hooks/PostTurnHooks.ts`
- new `src/agent/hooks/index.ts`
- update `src/agent/TurnExecutor.ts`
- update `src/agent/SessionRuntime.ts`

Test cases:
- Hooks run after successful turn completion
- Hooks don't block response to user
- Hook errors don't crash the main agent
- Hooks can be registered and unregistered
- Hook timeout is enforced

### Step 3: Session Memory Hook

Connect forked agents to session memory extraction.

Files:
- new `src/agent/hooks/SessionMemoryHook.ts`
- update `src/agent/SessionMemory.ts` (from context management track)

Test cases:
- Session memory extraction runs as forked agent
- Extraction triggers based on thresholds
- Extraction doesn't block main conversation
- Memory updates are persisted to session state

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
- **ForkedContext:** Unit tests verifying isolation of mutable state
- **ForkedAgent:** Integration tests with fake ModelClient
- **PostTurnHooks:** Unit tests for registry, integration tests for execution flow
- **SessionMemoryHook:** Integration tests with threshold triggering
- **SubagentTool:** Integration tests with fake subagent execution

## Risks

- **Concurrent execution complexity:** Multiple forked agents running simultaneously could cause race conditions. Mitigation: Use sequential execution for hooks initially, add concurrency control later.
- **Resource exhaustion:** Many forked agents could exhaust memory or API rate limits. Mitigation: Limit concurrent forked agents, implement backpressure.
- **Debugging difficulty:** Forked agent failures may be hard to trace. Mitigation: Clear logging with fork labels, transcript recording.
- **Cost unpredictability:** Forked agents add API calls. Mitigation: Make forked agents opt-in, provide usage metrics.

## Success Criteria

- Forked agents run without blocking the main conversation
- Session memory extraction works via forked agent
- Hook errors don't crash the main agent
- Token usage is tracked across all forked agents
- Forked agent lifecycle is properly managed (cleanup on session end)
