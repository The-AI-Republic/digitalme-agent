# Prompt Management

## Goal

Separate prompt construction from request execution so the runtime has a clear, testable prompt-building layer.

This track is only about prompt construction, not about context reduction or compaction.

## Scope

In scope:

- system prompt composition
- dynamic prompt sections
- prompt overrides and appenders
- prompt assembly boundaries
- tool and policy hints inside prompts

## Current State

Today the prompt path is mostly:

- `src/prompts/PromptComposer.ts`
- `src/agent/TurnExecutor.ts`

Today the implementation is very small:

- `PromptComposer.compose(history, latestUserMessage)` returns the full `Message[]`
- the system prompt is one inline string:
  - `config.persona.default_system_prompt`
  - plus a generated approved-tool sentence
- `TurnExecutor` depends directly on `IPromptComposer`

That is enough for MVP, but prompt construction is still too tightly coupled to execution.

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/constants/prompts.ts`
- `/home/rich/dev/study/claudy/src/constants/systemPromptSections.ts`
- `/home/rich/dev/study/claudy/src/utils/queryContext.ts`
- `/home/rich/dev/study/claudy/src/utils/systemPrompt.ts`
- `/home/rich/dev/study/claudy/src/context.ts`

The key prompt-management patterns are:

- prompt sections instead of one monolithic prompt string
- split between base prompt and dynamic context
- explicit override and append behavior
- section-level caching instead of rebuilding the full prompt every turn
- a static prefix and dynamic tail separated by a boundary marker
- parallel fetching of prompt inputs before final assembly
- environment-aware prompt sections
- tool-aware prompt instructions
- model-aware prompt instructions where useful

## Storage Model for DigitalMe Agent

Unlike `claudy`, `digitalme-agent` does not need to keep most prompt text embedded in TypeScript.

The preferred design here is a hybrid model:

- store stable authored prompt text in Markdown files under `src/prompts/templates/`
- keep prompt selection, precedence, variable substitution, and final assembly in TypeScript

That means:

- Markdown owns prompt content
- TypeScript owns prompt mechanics

This is a better fit for `digitalme-agent` because:

- prompt wording is easier to review and iterate on
- stable public-agent instructions do not need to be buried in code
- creator-facing prompt content can be separated from runtime control flow
- the system still retains deterministic assembly, tests, and future cache-aware behavior

Do not move all prompt logic into Markdown. Template files should not own:

- precedence rules
- conditional enablement
- cache/stability metadata
- runtime context fetching
- request-scoped override policy

## Concrete First-Cut Contracts

These contracts should be treated as part of the implementation plan, not deferred to coding time.

### PromptContext

`PromptContextBuilder` should return a concrete shape like:

```ts
type PromptContext = {
  creatorName: string
  creatorDefaultSystemPrompt: string
  creatorSystemPromptOverride?: string | null
  creatorSystemPromptAppend?: string | null
  approvedToolNames: string[]
  requestSystemPromptAppend?: string | null
  modelName: string
  providerName: string
}
```

Field mapping to current code:

- `creatorName`
  - `config.persona.name`
- `creatorDefaultSystemPrompt`
  - `config.persona.default_system_prompt`
- `approvedToolNames`
  - `toolRegistry.listNames()`
- `modelName`
  - `config.model.name`
- `providerName`
  - `config.model.provider`

New config-backed fields to add:

- `creatorSystemPromptOverride`
- `creatorSystemPromptAppend`

New request-scoped field to plan for:

- `requestSystemPromptAppend`

This first cut should stay intentionally small. Do not add channel metadata or derived conversation context in this track.

### Template Variable Syntax

Use simple placeholder replacement with this syntax:

- `{{variableName}}`

Rules:

- no loops
- no conditionals
- no helper functions
- no nested expressions
- missing variables should render as empty string or fail fast in tests, depending on template criticality

This should be implemented as a very small renderer, not a full template engine.

### BuiltPrompt

Use `sections` as the source of truth.

```ts
type BuiltPromptSection = {
  name: string
  template?: string
  content: string
  cachePolicy: 'stable' | 'volatile'
  boundary: 'static' | 'dynamic'
}

type BuiltPrompt = {
  sections: BuiltPromptSection[]
  staticPrefix: string[]
  dynamicTail: string[]
  finalSystemPrompt: string[]
}
```

Relationship rules:

- `sections` is canonical
- `staticPrefix` is derived from sections where `boundary === 'static'`
- `dynamicTail` is derived from sections where `boundary === 'dynamic'`
- `finalSystemPrompt` is `[..., staticPrefix, ...dynamicTail]`

The builder should never mutate these separately after derivation.

### What Claudy Actually Does

The useful implementation details are more specific than "compose a better prompt."

#### 1. Section Registry, Not String Concatenation

`claudy` builds the default system prompt as an ordered list of named sections. Each section is declared through helpers in `systemPromptSections.ts`:

- `systemPromptSection(name, compute)`
- `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)`

This gives each prompt section:

- a stable identity
- a compute function
- an explicit cache policy

That pattern is worth copying because it makes prompt construction inspectable and testable. It also prevents hidden prompt drift from ad hoc string concatenation in runtime code.

For `digitalme-agent`, the equivalent should be:

- `PromptSectionDefinition`
  - `name`
  - `template`
  - `buildTemplateVars(context)`
  - `cachePolicy`
  - `boundary`
  - `enabledWhen(context)` optional
- `PromptSectionResolver`
  - resolves sections in a stable order
  - caches sections when safe
  - exposes the final ordered section list for tests and debugging

#### 2. Static Prefix vs Dynamic Tail

`claudy` explicitly separates:

- static, broadly cacheable prompt content
- dynamic, session-specific prompt content

It uses `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to mark that split. The practical design lesson is:

- do not treat the whole prompt as equally volatile
- keep stable behavior guidance in a reusable prefix
- keep request/session-specific sections in a smaller dynamic tail

For `digitalme-agent`, the prompt should be split into:

- `staticPrefix`
  - creator-independent public-agent operating rules
  - stable response-style rules
  - stable tool-usage rules
- `dynamicTail`
  - creator persona
  - deployment policy summary
  - enabled tool summary
  - channel/runtime facts
  - request-scoped append instructions

This does not require implementing prompt caching immediately, but the builder should preserve the boundary between stable and dynamic sections so future prompt-prefix reuse, diffing, and token analysis remain straightforward.

#### 3. Explicit Precedence Rules

`claudy` does not leave prompt precedence implicit. `buildEffectiveSystemPrompt(...)` defines a clear order:

1. override prompt replaces everything
2. coordinator prompt
3. agent prompt
4. custom prompt
5. default prompt
6. append prompt added last

The important lesson is not the exact ordering, but that ordering is explicit and centralized.

For the first cut of `digitalme-agent`, define and document this precedence path:

1. creator-level hard override
2. runtime-generated default sections
3. creator base prompt section
4. creator append instructions
5. request-scoped append instructions if later introduced

Do not allow multiple files/classes to apply overrides independently. One builder should own the final decision.

#### 4. Parallel Input Fetch Before Assembly

In `claudy`, prompt inputs are fetched in parallel:

- output style config
- environment info
- skill/tool command info
- user context
- system context

That matters because prompt construction is treated as a runtime pipeline, not a synchronous string-template helper.

For `digitalme-agent`, `PromptContextBuilder` should gather in parallel where possible:

- creator profile and persona config
- deployment policy snapshot
- enabled tool metadata summary
- channel/runtime metadata
- request-level options

The final builder should receive resolved inputs, not reach into many subsystems on its own.

#### 4.5. Templates for Authored Text, Code for Assembly

`claudy` keeps prompt sections in code because many of them are tightly coupled to feature flags, tool discovery, and runtime cache behavior.

For `digitalme-agent`, a simpler split is better:

- Markdown templates hold the actual prompt wording
- code decides:
  - which templates are active
  - what variables are injected
  - where the section appears
  - whether the section is stable or volatile

Suggested template directory:

- `src/prompts/templates/base_system.md`
- `src/prompts/templates/tone_style.md`
- `src/prompts/templates/tool_policy.md`
- `src/prompts/templates/creator_persona.md`

Template files should stay mostly content-oriented. Keep logic out of them beyond simple variable placeholders.

#### 5. Dynamic Sections Should Be Small and Named

In `claudy`, dynamic sections have stable names like:

- `session_guidance`
- `memory`
- `env_info_simple`
- `language`
- `output_style`
- `mcp_instructions`
- `scratchpad`

That pattern is useful because it makes prompt diffs legible. For `digitalme-agent`, prefer small named sections such as:

- `creator_persona`
- `agent_operating_rules`
- `tool_policy_summary`
- `channel_context`
- `runtime_capabilities`
- `request_append`

This is better than one giant `buildPromptContext()` string because it lets tests assert on exact section presence and order.

#### 6. Volatile Sections Must Be Opt-In

`claudy` treats some sections as cache-breaking on purpose, such as live MCP instructions that can change mid-session.

The useful rule is:

- default to cacheable/stable sections
- mark volatile sections explicitly
- require a reason when a section can change between turns

For `digitalme-agent`, likely volatile sections are:

- live tool availability if tools can be toggled dynamically
- request-scoped append instructions
- runtime policy deltas supplied externally

Everything else should prefer stable section output.

## Target Design for DigitalMe Agent

### Initial Section Set

The first implementation should start with only these sections:

1. `base_system`
   - template-backed
   - static
   - public-agent operating rules
2. `tone_style`
   - template-backed
   - static
   - response style and formatting expectations
3. `creator_persona`
   - template-backed
   - dynamic
   - built from `config.persona.default_system_prompt`
4. `tool_policy`
   - template-backed or code-rendered
   - dynamic
   - built from approved tool names

Defer other sections such as `channel_context` and `runtime_capabilities` until there is real input data for them.

### New Modules

- `src/prompts/SystemPromptBuilder.ts`
  - build the base system prompt from creator config and runtime capabilities
- `src/prompts/PromptSections.ts`
  - define named prompt sections, template mapping, and cache policies
- `src/prompts/TemplateLoader.ts`
  - load Markdown prompt templates from disk and cache stable templates
- `src/prompts/types.ts`
  - prompt section and prompt context types

Defer for later unless the first implementation proves the need:

- `src/prompts/TemplateRenderer.ts`
- `src/prompts/PromptContextBuilder.ts`
- `src/prompts/PromptSectionResolver.ts`

### Template Directory

- `src/prompts/templates/base_system.md`
- `src/prompts/templates/tone_style.md`
- `src/prompts/templates/tool_policy.md`
- `src/prompts/templates/creator_persona.md`

### Existing Files To Change

- `src/prompts/PromptComposer.ts`
- `src/agent/TurnExecutor.ts`
- `src/config/schema.ts`

## Proposed Prompt Layers

### 1. Base System Prompt

Built from:

- public-agent behavioral instructions
- stable tool-usage guidance
- stable tone/style guidance

This should be the most stable part of the prompt and should not depend on request-local state.

These sections should primarily come from Markdown templates rendered with minimal variables.

### 2. Dynamic Prompt Context

Built from:

- creator persona/system prompt
- deployment policy summary
- latest runtime environment facts
- enabled tool inventory summary
- optional policy hints

These sections may also use templates, but their data should come from `PromptContextBuilder`, not by having templates read runtime state directly.

### 3. Final Prompt Assembly

Assemble:

1. base system prompt
2. dynamic prompt context

Prompt assembly should allow:

- custom system override
- append-only extra instructions
- per-request optional additions

The builder should also preserve a clear boundary between:

- stable reusable sections
- request/session-scoped dynamic sections

## Builder Interface and Template Lifecycle

The prompt subsystem should expose one main entrypoint:

```ts
interface ISystemPromptBuilder {
  build(context: PromptContext): BuiltPrompt
}
```

`BuiltPrompt` is defined once in `Concrete First-Cut Contracts` above and should not be redefined elsewhere in the code or docs.

`TemplateLoader` should:

- load templates once at construction time
- cache them for the lifetime of the process
- fail fast on missing required templates

Hot-reload is not required for the first implementation.

## Suggested Data Flow

The flow should be:

1. `TurnExecutor` prepares a small `PromptContext`
2. `SystemPromptBuilder` asks `TemplateLoader` for required templates
3. `PromptSections` declares the initial ordered section definitions
4. `SystemPromptBuilder` builds section vars, renders templates, and derives `finalSystemPrompt`
5. `TurnExecutor` assembles model messages from:
   - one `system` message using `builtPrompt.finalSystemPrompt.join('\n\n')`
   - prior history
   - latest user message

That keeps prompt assembly deterministic and away from request-loop control logic.

## TurnExecutor Integration

The current call path is:

```ts
const initialMessages = this.promptComposer.compose(history, submission.userMessage)
```

The first implementation should change that shape explicitly.

Target flow:

```ts
const promptContext = {
  creatorName: this.config.persona.name,
  creatorDefaultSystemPrompt: this.config.persona.default_system_prompt,
  creatorSystemPromptOverride: this.config.persona.system_prompt_override ?? null,
  creatorSystemPromptAppend: this.config.persona.system_prompt_append ?? null,
  approvedToolNames: this.toolRegistry.listNames(),
  modelName: this.config.model.name,
  providerName: this.config.model.provider,
}

const builtPrompt = this.systemPromptBuilder.build(promptContext)

const initialMessages: Message[] = [
  {
    role: 'system',
    content: builtPrompt.finalSystemPrompt.join('\n\n'),
  },
  ...history,
  {
    role: 'user',
    content: submission.userMessage,
  },
]
```

This plan should retire `IPromptComposer` rather than keep both abstractions alive.

New dependency shape:

- `TurnExecutor` depends on `ISystemPromptBuilder`
- existing `PromptComposer` is removed after migration

Tests that currently mock `IPromptComposer` should be updated to mock `ISystemPromptBuilder` instead.

## Suggested Implementation Sequence

### Step 1: Extract SystemPromptBuilder

Files:

- new `src/prompts/SystemPromptBuilder.ts`
- new `src/prompts/PromptSections.ts`
- new `src/prompts/TemplateLoader.ts`
- update `src/agent/TurnExecutor.ts`
- update or remove `src/prompts/PromptComposer.ts`
- update `src/config/schema.ts`

Work:

- move final prompt precedence into one builder
- move stable authored prompt text into Markdown templates under `src/prompts/templates/`
- define named section-oriented prompt construction
- keep section ordering explicit in code, not implicit in call order spread across files
- retire `IPromptComposer`

### Step 2: Extract PromptContextBuilder

Work:

- only do this if prompt inputs spread across enough async sources to justify it
- until then, keep prompt-context assembly inside `TurnExecutor` or `SystemPromptBuilder`

### Step 3: Define Override and Append Semantics

Files:

- `src/prompts/SystemPromptBuilder.ts`
- `src/config/schema.ts`

Work:

- define whether request or deployment config can:
  - override system prompt
  - append to system prompt
  - add per-request guidance
- define a single precedence order and document it in code comments and tests

### Step 4: Introduce Section-Level Visibility

Files:

- `src/prompts/SystemPromptBuilder.ts`
- `src/prompts/types.ts`

Work:

- expose resolved section names in debug/test output
- make it possible to snapshot-test section ordering
- keep stable and volatile sections distinguishable

## Config Schema Changes

The current schema has only:

- `persona.default_system_prompt`

The first implementation should add:

```ts
persona: {
  name: string
  default_system_prompt: string
  system_prompt_override?: string | null
  system_prompt_append?: string | null
  tools: { ... }
}
```

Semantics:

- `default_system_prompt`
  - the creator persona content used by the `creator_persona` section
- `system_prompt_override`
  - if set, replaces the normal section assembly
- `system_prompt_append`
  - appended last after normal assembly

No deployment-level prompt fields need to be introduced in this first cut unless the deployment config already has a natural home for them.

## Testing Strategy

Add tests for:

- stable prompt assembly for the same config
- override vs append behavior
- tool-policy hints appearing in the correct prompt layer
- prompt sections remaining ordered and predictable
- template loading and rendering correctness
- missing template failure behavior
- stable vs volatile section behavior
- dynamic-tail changes not rewriting unrelated stable sections
- parallel input gathering producing deterministic final output
- `TurnExecutor` builds the system message from `ISystemPromptBuilder`
- existing tests are migrated away from `IPromptComposer`

## Risks

- overcomplicating prompt building before enough prompt variants exist
- mixing prompt construction concerns back into execution flow
- allowing section precedence to be split across multiple entrypoints
- treating all prompt sections as volatile and losing future cache leverage
- pushing runtime logic down into Markdown templates
- introducing too many prompt-specific classes before enough prompt sources exist

## Success Criteria

- prompt construction is a distinct subsystem
- prompt assembly is testable without running the request loop
- prompt override and append behavior is explicit
- prompt sections have stable names and ordering
- prompt inputs are gathered separately from final assembly
- stable prompt text lives in `src/prompts/templates/` rather than large inline strings in code
- `TurnExecutor` no longer depends on `IPromptComposer`
