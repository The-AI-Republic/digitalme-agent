# Tool Runtime

## Goal

Turn tool execution into a first-class runtime subsystem before the tool set expands.

This track should make `digitalme-agent` better at:

- executing tools consistently through a single path
- applying shared policy decisions (rate limits, content moderation, creator config)
- handling large results safely (budget, truncate, externalize)
- preparing concise tool-use context for later prompt iterations
- running safe tools concurrently when the model requests multiple tool calls

## Current State

The tool layer is intentionally minimal:

| File | Role |
|---|---|
| `src/tools/types.ts` | `Tool`, `ToolContext`, `ToolDefinition`, `ToolExecutionResult` interfaces |
| `src/tools/registry.ts` | `ToolRegistry` — config-driven Map, hardcoded WebSearchTool registration |
| `src/tools/web-search.ts` | `WebSearchTool` — DuckDuckGo Instant Answer, 5s timeout, string result |
| `src/agent/TurnExecutor.ts` | ReAct loop with inline tool dispatch (lines 89-114) |

### What works

- Clean separation: `TurnExecutor` owns the loop, tools are looked up by name.
- Abort signal propagation from request → model call → tool execution.
- `TurnState` tracks pending/resolved tool call IDs for monitoring.
- `SessionState.promptHistory` preserves tool interactions across turns.

### What will not scale

1. **Inline dispatch** — `TurnExecutor.executeTool()` is 14 lines of JSON-parse-then-call. Every cross-cutting concern (validation, timeout, policy, result budgeting) would have to be grafted onto this method.
2. **No input validation** — arguments are `Record<string, unknown>` parsed from raw JSON. Invalid input is caught only by the tool itself or not at all.
3. **String-only results** — `ToolExecutionResult.content` is a plain string. No structured data, no metadata about result size or truncation.
4. **Sequential execution** — tool calls are processed in a `for` loop. Multiple read-only calls in one model step block each other.
5. **No result budgeting** — every tool result goes verbatim into prompt history. A large search result bloats all future turns.
6. **Hardcoded registration** — adding a tool requires editing `ToolRegistry` constructor.
7. **Minimal context** — tools receive only `conversationId` and `signal`. No access to config, rate-limit state, or creator policy.

## Claudy Patterns Worth Borrowing

Claudy is a general-purpose coding agent. Its tool system is much larger than what digitalme-agent needs, but several architectural patterns are directly applicable. The key is to borrow the *shapes* without the scale.

### 1. Tool Definition Metadata

In claudy, the `Tool` type carries ~40 fields. Most are UI/permission concerns that don't apply here. The fields worth borrowing:

| Claudy field | Purpose | DigitalMe adaptation |
|---|---|---|
| `inputSchema` (Zod) | Runtime input validation | Use Zod schemas per tool; parse before execution |
| `validateInput(input, context)` | Semantic validation beyond schema | Optional hook for business-rule checks (e.g., query length limits) |
| `isConcurrencySafe(input)` | Input-dependent concurrency classification | Start with a static boolean, upgrade to per-input later |
| `isReadOnly(input)` | Marks tools that don't mutate state | Drives concurrency batching |
| `maxResultSizeChars` | Per-tool inline result budget | Hard cap before truncation or externalization |
| `mapToolResultToToolResultBlockParam()` | Normalize result for model consumption | Map `ToolExecutionResult` into a bounded message payload |
| `getToolUseSummary(input)` | Short human-readable action description | For logging and future prompt-summary projection |
| `timeoutMs` | Per-tool timeout | Override the current global 5s constant |
| `policyCategory` | Group tools by risk/cost | Feed into per-category rate limits and moderation policy |

**Key insight from claudy:** some tool properties depend on the specific input, not only the tool type. `isConcurrencySafe(input)` is the canonical example — a tool might be safe for reads but not writes. DigitalMe should model this from the start even if the first tools only return static values.

### 2. Centralized Execution Path

In claudy, `toolExecution.ts` (~1,750 lines) is the single entry point for all tool execution. Every tool goes through:

```
lookup → parse input (Zod) → validateInput → pre-hooks → policy/permission → execute(timeout, abort) → post-hooks → normalize result → persist if large → emit analytics
```

DigitalMe does not need hooks or a permission dialog, but it does need the principle: **one path, every tool, every time**. The current `TurnExecutor.executeTool()` is too thin to be that path.

### 3. Concurrency Orchestration

Claudy's `toolOrchestration.ts` partitions tool calls into batches:

```
[read-only, read-only] → run concurrently
[write]                → run alone
[read-only]            → run concurrently
```

The algorithm is simple: scan the tool call list, group consecutive concurrency-safe calls, execute each group as a batch. Non-safe calls form single-item batches.

For digitalme-agent, the model may request multiple tool calls in one step (the LLM returns `tool_calls: [...]`). Today these are executed sequentially in `TurnExecutor` lines 89-114. Once more tools exist (e.g., web search + memory lookup), concurrent execution of read-only calls is a straightforward latency win.

### 4. Result Budgeting and Externalization

Claudy's `toolResultStorage.ts` implements a two-tier budget:

- **Per-tool threshold:** `maxResultSizeChars` (default 50K chars). Results larger than this are persisted to disk and replaced with a 2KB preview.
- **Aggregate budget:** Total tool result content per message is capped. Results that push past the aggregate limit are also externalized.

The externalized result message looks like:

```
Output too large (123.4 KB). Full output saved to: /path/to/file.json

Preview (first 2 KB):
[truncated content]
```

For digitalme-agent, externalization to disk doesn't make sense (the agent is ephemeral, no local filesystem for the fan to access). Instead:

- **Truncation with summary:** cut to budget, append `[truncated — N chars omitted]`.
- **Aggregate tracking:** `ToolExecutor` tracks cumulative result size across the turn and applies progressively tighter truncation as budget is consumed.

### 5. Abort Signal Hierarchy

Claudy uses a three-level abort signal chain:

```
request abort controller (user cancels)
  └─ sibling abort controller (Bash error cascades to other tools)
       └─ per-tool abort controller (individual tool timeout/cancellation)
```

DigitalMe already propagates the request signal. The addition needed is a per-tool timeout controller that composes with the request signal:

```typescript
const toolController = new AbortController();
const timeout = setTimeout(() => toolController.abort(), tool.timeoutMs);
signal?.addEventListener('abort', () => toolController.abort(), { once: true });
```

This is essentially what `WebSearchTool` already does internally. The executor should own this pattern so individual tools don't have to.

### 6. Error Classification

Claudy classifies tool errors into telemetry-safe categories (strips file paths and sensitive content). DigitalMe should adopt a simpler version: tag errors as `validation_error`, `timeout`, `execution_error`, or `aborted` so that logging and monitoring can aggregate without leaking user data.

## Target Design

### New Files

| File | Responsibility |
|---|---|
| `src/tools/execution/ToolExecutor.ts` | Single entry point for tool execution. Owns validation, timeout, result normalization, and budget enforcement. |
| `src/tools/execution/ResultBudget.ts` | Tracks cumulative result size within a turn. Decides truncation thresholds. |
| `src/tools/execution/types.ts` | `ToolExecutionMetadata`, `NormalizedToolResult`, error classification enums. |

### Changed Files

| File | Change |
|---|---|
| `src/tools/types.ts` | Extend `Tool` interface with metadata fields. Add `ToolInputSchema` type. |
| `src/tools/registry.ts` | Accept dynamic registration. Remove hardcoded constructor logic. |
| `src/tools/web-search.ts` | Conform to extended `Tool` interface (add schema, timeout, budget, etc.). |
| `src/agent/TurnExecutor.ts` | Replace inline dispatch with `ToolExecutor.runTools()`. Support concurrent batching. |

### Not Planned

These claudy features are explicitly out of scope:

- **Hook system (pre/post tool hooks):** Claudy uses hooks for permission prompts, security classifiers, and UI progress. DigitalMe is headless and server-side; policy checks are simpler.
- **Permission/approval dialogs:** DigitalMe tools run on behalf of a creator's agent, not an interactive user. Creator config controls what's enabled, not per-call approval.
- **Streaming tool executor:** Claudy executes tools as they stream in during generation. DigitalMe waits for the full model step, which is correct for its SSE-based response model.
- **Tool search / deferred loading:** Only relevant with dozens of tools. Premature for DigitalMe.
- **UI rendering methods:** DigitalMe is API-only.

## Proposed Interfaces

### Extended Tool Interface

```typescript
import { z } from 'zod';

export interface ToolContext {
  conversationId: string;
  signal: AbortSignal;          // always provided (executor guarantees)
  config: AgentConfig;          // full agent config for policy decisions
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;   // JSON Schema for model
  };
}

export interface ToolExecutionResult {
  success: boolean;
  content: string;
}

export interface ToolMetadata {
  timeoutMs: number;                       // per-tool timeout (default: 10_000)
  maxResultChars: number;                  // inline result budget (default: 20_000)
  policyCategory: 'search' | 'memory' | 'action';
  isConcurrencySafe: boolean;              // safe to run in parallel (default: false)
}

export const DEFAULT_TOOL_METADATA: ToolMetadata = {
  timeoutMs: 10_000,
  maxResultChars: 20_000,
  policyCategory: 'search',
  isConcurrencySafe: false,
};

export interface Tool<TInput = Record<string, unknown>> {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly metadata: ToolMetadata;
  readonly inputSchema: z.ZodType<TInput>;

  execute(args: TInput, context: ToolContext): Promise<ToolExecutionResult>;

  // Optional overrides (executor provides defaults)
  validateInput?(args: TInput, context: ToolContext): string | null;
  summarizeResult?(args: TInput, result: ToolExecutionResult): string;
}
```

### ToolExecutor Types

```typescript
export type ToolErrorCategory =
  | 'validation_error'
  | 'timeout'
  | 'execution_error'
  | 'aborted'
  | 'unknown_tool';

export interface NormalizedToolResult {
  success: boolean;
  content: string;                  // possibly truncated
  truncated: boolean;
  originalChars: number;
  errorCategory?: ToolErrorCategory;
}

export interface ToolExecutionRecord {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: NormalizedToolResult;
  durationMs: number;
  summary: string;                  // short description for logging / future prompt use
}
```

### ResultBudget

```typescript
export class ResultBudget {
  private consumed = 0;

  constructor(private readonly maxTotalChars: number = 80_000) {}

  /** Returns the number of chars this result is allowed to use inline. */
  allowance(perToolMax: number): number {
    const remaining = Math.max(0, this.maxTotalChars - this.consumed);
    return Math.min(perToolMax, remaining);
  }

  consume(chars: number): void {
    this.consumed += chars;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotalChars - this.consumed);
  }
}
```

## Proposed Execution Flow

All tools execute through `ToolExecutor.runTools()`:

```
TurnExecutor receives tool_calls from model
  │
  ▼
ToolExecutor.runTools(calls, context, budget)
  │
  ├─ partition into batches by concurrency safety
  │   [safe, safe] → concurrent batch
  │   [unsafe]     → serial batch
  │
  ▼ for each batch:
  │
  ├─ for each call in batch (parallel if concurrent, sequential otherwise):
  │   │
  │   ├─ 1. Lookup tool in registry
  │   │      → unknown_tool error if missing
  │   │
  │   ├─ 2. Parse input with tool.inputSchema (Zod)
  │   │      → validation_error if parse fails
  │   │
  │   ├─ 3. Run tool.validateInput() if defined
  │   │      → validation_error if rejected
  │   │
  │   ├─ 4. Create per-tool AbortController
  │   │      → compose request signal + tool timeout
  │   │
  │   ├─ 5. Execute tool.execute(parsedInput, context)
  │   │      → catch timeout → timeout error
  │   │      → catch abort  → aborted error
  │   │      → catch other  → execution_error
  │   │
  │   ├─ 6. Normalize result
  │   │      → check budget.allowance(tool.metadata.maxResultChars)
  │   │      → truncate if needed, set truncated flag
  │   │      → budget.consume(result.content.length)
  │   │
  │   ├─ 7. Generate summary
  │   │      → tool.summarizeResult() if defined
  │   │      → else: "${toolName}(${key args}) → ${success ? 'ok' : 'failed'}"
  │   │
  │   └─ 8. Return NormalizedToolResult + ToolExecutionRecord
  │
  └─ yield results in call order (preserve model's ordering)
```

### Concurrency Batching Detail

```typescript
interface Batch {
  concurrent: boolean;
  calls: ToolCall[];
}

function partitionIntoBatches(
  calls: ToolCall[],
  registry: IToolRegistry,
): Batch[] {
  const batches: Batch[] = [];

  for (const call of calls) {
    const tool = registry.get(call.function.name);
    const safe = tool?.metadata.isConcurrencySafe ?? false;

    const last = batches[batches.length - 1];
    if (last && last.concurrent && safe) {
      last.calls.push(call);     // extend current concurrent batch
    } else {
      batches.push({ concurrent: safe, calls: [call] });
    }
  }

  return batches;
}
```

Concurrent batches use `Promise.all()` (or `Promise.allSettled()` if we want partial results). Serial batches execute one at a time. A sensible concurrency cap (e.g., 5) prevents runaway parallelism.

### Abort Signal Composition

```typescript
function createToolAbortSignal(
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  const onRequestAbort = () => controller.abort('request_aborted');
  requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', onRequestAbort);
    },
  };
}
```

This lifts the pattern currently buried inside `WebSearchTool` (lines 60-64) into shared infrastructure.

### Result Truncation

```typescript
function truncateResult(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean; originalChars: number } {
  if (content.length <= maxChars) {
    return { content, truncated: false, originalChars: content.length };
  }

  // Cut at last newline within budget to avoid mid-line breaks
  const cut = content.lastIndexOf('\n', maxChars);
  const breakpoint = cut > maxChars * 0.5 ? cut : maxChars;

  return {
    content: content.slice(0, breakpoint) + `\n[truncated — ${content.length - breakpoint} chars omitted]`,
    truncated: true,
    originalChars: content.length,
  };
}
```

## TurnExecutor Integration

After extraction, `TurnExecutor.run()` tool dispatch (currently lines 83-114) becomes:

```typescript
// Before: inline dispatch
for (const call of result.calls) {
  this.throwIfAborted(context.signal);
  toolCallCount += 1;
  activeTurn?.turnState.registerToolCall(call.id);
  const tool = this.toolRegistry.get(call.function.name);
  if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
  events.push({ type: 'tool_start', name: call.function.name, callId: call.id });
  const toolResult = await this.executeTool(call, context.conversationId, context.signal, tool);
  events.push({ type: 'tool_end', name: call.function.name, callId: call.id, success: toolResult.success });
  activeTurn?.turnState.resolveToolCall(call.id);
  context.messages.push({ role: 'tool', content: toolResult.content, toolCallId: call.id, toolName: call.function.name });
}

// After: delegated to ToolExecutor
const records = await this.toolExecutor.runTools(result.calls, {
  conversationId: context.conversationId,
  signal: context.signal,
  config: this.config,
}, this.resultBudget, {
  onToolStart: (name, callId) => {
    activeTurn?.turnState.registerToolCall(callId);
    events.push({ type: 'tool_start', name, callId });
  },
  onToolEnd: (name, callId, success) => {
    activeTurn?.turnState.resolveToolCall(callId);
    events.push({ type: 'tool_end', name, callId, success });
  },
});

toolCallCount += records.length;
for (const record of records) {
  context.messages.push({
    role: 'tool',
    content: record.result.content,
    toolCallId: record.callId,
    toolName: record.toolName,
  });
}
```

`TurnExecutor.executeTool()` private method is deleted. `ResultBudget` is created once per `run()` call and shared across all tool calls in the turn.

## WebSearchTool Migration

The existing `WebSearchTool` adapts to the new interface:

```typescript
export class WebSearchTool implements Tool<WebSearchInput> {
  readonly name = 'web_search';

  readonly metadata: ToolMetadata = {
    timeoutMs: 5_000,
    maxResultChars: 4_000,
    policyCategory: 'search',
    isConcurrencySafe: true,         // read-only, no side effects
  };

  readonly inputSchema = z.object({
    query: z.string().min(1).max(500),
  });

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: this.name,
      description: 'Look up factual public web snippets via DuckDuckGo Instant Answer.',
      parameters: zodToJsonSchema(this.inputSchema),    // derive JSON Schema from Zod
    },
  };

  // execute() no longer needs internal timeout/abort logic — executor handles it
  async execute(args: WebSearchInput, context: ToolContext): Promise<ToolExecutionResult> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', args.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '0');

    const response = await fetch(url, {
      signal: context.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return { success: false, content: `Search failed: HTTP ${response.status}.` };
    }

    // ... parse and format results (same as today) ...
  }

  summarizeResult(args: WebSearchInput, result: ToolExecutionResult): string {
    return result.success
      ? `web_search("${args.query}") → found results`
      : `web_search("${args.query}") → failed`;
  }
}
```

Key simplifications:
- `inputSchema` replaces manual `typeof args.query === 'string'` validation.
- `execute()` receives pre-validated `WebSearchInput`, not raw `Record<string, unknown>`.
- Timeout and abort signal composition moves to the executor.
- `definition.parameters` is derived from Zod schema (single source of truth).

## ToolRegistry Changes

```typescript
export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  // ... listDefinitions(), listNames(), get() unchanged ...
}

// Registration moves to a factory function or Agent setup:
export function createToolRegistry(config: AgentConfig): ToolRegistry {
  const registry = new ToolRegistry();
  if (config.persona.tools.allow_web_search) {
    registry.register(new WebSearchTool());
  }
  return registry;
}
```

`register()` becomes public. Construction and registration are separated so tests can inject tools without config gymnastics.

## Implementation Sequence

### Step 1: Extract ToolExecutor (serial only)

**Files:**
- New: `src/tools/execution/ToolExecutor.ts`, `src/tools/execution/types.ts`
- Change: `src/agent/TurnExecutor.ts`

**Work:**
- Create `ToolExecutor` with `runTools()` that processes calls sequentially.
- Move JSON parsing, tool lookup, timeout, and abort signal composition into `ToolExecutor`.
- `TurnExecutor` delegates to `ToolExecutor.runTools()` via callbacks.
- Delete `TurnExecutor.executeTool()`.

**Exit criteria:**
- No tool is dispatched directly from `TurnExecutor`.
- All existing tests pass with no behavior change.

### Step 2: Richer Tool Interface

**Files:**
- Change: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/web-search.ts`

**Work:**
- Add `ToolMetadata`, `inputSchema`, optional `validateInput`, optional `summarizeResult` to `Tool`.
- Provide `DEFAULT_TOOL_METADATA` so existing tools can adopt incrementally.
- Add Zod dependency. Derive `definition.parameters` from Zod schema.
- Make `ToolRegistry.register()` public. Extract `createToolRegistry()`.
- Migrate `WebSearchTool` to the new interface.
- `ToolExecutor` validates input via Zod before calling `execute()`.

**Exit criteria:**
- `WebSearchTool` has a Zod schema and typed `execute()` signature.
- Invalid input is caught by the executor, not the tool.

### Step 3: Result Budgeting

**Files:**
- New: `src/tools/execution/ResultBudget.ts`
- Change: `src/tools/execution/ToolExecutor.ts`, `src/agent/TurnExecutor.ts`

**Work:**
- Implement `ResultBudget` with per-turn aggregate tracking.
- `ToolExecutor` truncates results that exceed `min(tool.metadata.maxResultChars, budget.allowance())`.
- `TurnExecutor` creates a `ResultBudget` per `run()` call.
- `NormalizedToolResult` carries `truncated` and `originalChars` fields.

**Exit criteria:**
- A tool returning >20K chars has its result truncated in the prompt history.
- Cumulative tool output in a single turn is bounded.

### Step 4: Concurrent Batching

**Files:**
- Change: `src/tools/execution/ToolExecutor.ts`

**Work:**
- Implement `partitionIntoBatches()`.
- Concurrent batches use `Promise.allSettled()` with a concurrency cap.
- Events (`tool_start`, `tool_end`) still fire per-tool, in original order.
- Results are returned in the model's call order regardless of completion order.

**Exit criteria:**
- Two concurrent-safe tool calls in one model step execute in parallel.
- A non-safe tool call always executes alone.
- Ordering of tool result messages matches call order.

### Step 5: Tool-Use Summaries (optional, depends on prompt work)

**Files:**
- Change: `src/tools/execution/ToolExecutor.ts`, `src/agent/SessionState.ts`

**Work:**
- `ToolExecutionRecord.summary` is populated for every call.
- Store summaries alongside prompt history in `SessionState`.
- Future prompt projection can use summaries instead of raw tool output for older turns.

**Exit criteria:**
- Every tool execution produces a summary string.
- Summaries are accessible from `SessionState` for prompt construction.

## Testing Strategy

### Unit Tests

| What | How |
|---|---|
| Zod schema validation | Pass invalid inputs, verify `validation_error` result |
| `validateInput` rejection | Tool-specific semantic check returns error string |
| Timeout enforcement | Mock a tool that never resolves, verify timeout error after `timeoutMs` |
| Abort propagation | Abort request signal mid-execution, verify tool receives abort |
| Result truncation | Return >maxResultChars, verify truncation and `[truncated]` marker |
| Aggregate budget | Run multiple tools, verify later tools get tighter budget |
| Concurrency batching | Verify `partitionIntoBatches` groups safe calls, isolates unsafe |
| Error classification | Verify each failure mode maps to correct `ToolErrorCategory` |
| Summary generation | Verify default and custom `summarizeResult` output |

### Integration Tests

| What | How |
|---|---|
| Full turn with tool call | Model returns `tool_calls`, executor runs tool, result fed back, model produces final text |
| Concurrent execution | Two safe tools, verify wall-clock time < sum of individual durations |
| Budget across multi-turn | Run 3+ tool calls in one turn, verify cumulative truncation |

## Risks

| Risk | Mitigation |
|---|---|
| Over-engineering before enough tools exist | Steps are incremental. Stop after Step 2 if no new tools are imminent. |
| Zod dependency adds weight | Zod is ~50KB minified. Acceptable for input validation. Already common in TS ecosystems. |
| Concurrency bugs | Step 4 is last and optional. Serial path is always the fallback. |
| Budget tuning | Start with generous defaults (20K per tool, 80K per turn). Tune based on actual model context window usage. |

## Dependencies

- `zod` — input schema definition and validation
- `zod-to-json-schema` (or equivalent) — derive OpenAI-compatible JSON Schema from Zod types

## Success Criteria

1. No tool is executed directly from `TurnExecutor` — all calls go through `ToolExecutor`.
2. Every tool has a Zod input schema; invalid input is caught before `execute()`.
3. Tool results are bounded: per-tool and per-turn budgets enforced.
4. Read-only tools can run concurrently when the model requests multiple calls.
5. Every tool execution produces a typed `ToolExecutionRecord` with duration, result metadata, and summary.
