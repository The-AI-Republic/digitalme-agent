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

For `digitalme-agent`, define and document one precedence path:

1. deployment-level hard override
2. creator base prompt
3. runtime-generated default sections
4. request-scoped append instructions

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
- `src/prompts/templates/channel_context.md`

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

### New Modules

- `src/prompts/SystemPromptBuilder.ts`
  - build the base system prompt from creator config and runtime capabilities
- `src/prompts/TemplateLoader.ts`
  - load Markdown prompt templates from disk and cache stable templates
- `src/prompts/TemplateRenderer.ts`
  - render templates with structured prompt context inputs
- `src/prompts/PromptSections.ts`
  - define named prompt sections, template mapping, and cache policies
- `src/prompts/PromptContextBuilder.ts`
  - collect dynamic prompt context
- `src/prompts/PromptSectionResolver.ts`
  - resolve sections in stable order and apply cache policy
- `src/prompts/types.ts`
  - prompt section and prompt context types

### Template Directory

- `src/prompts/templates/base_system.md`
- `src/prompts/templates/tone_style.md`
- `src/prompts/templates/tool_policy.md`
- `src/prompts/templates/creator_persona.md`
- `src/prompts/templates/channel_context.md`

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

## Recommended Prompt Assembly Contract

The prompt subsystem should expose one main entrypoint:

- `buildEffectivePrompt(input): BuiltPrompt`

Suggested return shape:

```ts
type BuiltPrompt = {
  sections: Array<{
    name: string
    template?: string
    content: string
    cachePolicy: 'stable' | 'volatile'
  }>
  staticPrefix: string[]
  dynamicTail: string[]
  finalSystemPrompt: string[]
}
```

This gives the runtime:

- a final prompt for model calls
- section-level visibility for tests
- room for future cache-aware behavior without redesigning the builder

## Suggested Data Flow

The flow should be:

1. `PromptContextBuilder` gathers prompt inputs in parallel
2. `TemplateLoader` loads the referenced Markdown templates
3. `PromptSections` declares ordered section definitions
4. `PromptSectionResolver` computes the active sections
5. `TemplateRenderer` renders the active sections with structured inputs
6. `SystemPromptBuilder` applies precedence rules
5. `PromptComposer` becomes a thin compatibility wrapper or is retired

That keeps prompt assembly deterministic and away from request-loop control logic.

## Suggested Implementation Sequence

### Step 1: Extract SystemPromptBuilder

Files:

- new `src/prompts/SystemPromptBuilder.ts`
- new `src/prompts/TemplateLoader.ts`
- new `src/prompts/TemplateRenderer.ts`
- new `src/prompts/PromptSections.ts`
- new `src/prompts/PromptSectionResolver.ts`
- update `src/prompts/PromptComposer.ts`

Work:

- move final prompt precedence into one builder
- move stable authored prompt text into Markdown templates under `src/prompts/templates/`
- define named section-oriented prompt construction
- keep section ordering explicit in code, not implicit in call order spread across files

### Step 2: Extract PromptContextBuilder

Files:

- new `src/prompts/PromptContextBuilder.ts`
- update `src/prompts/PromptComposer.ts`

Work:

- separate dynamic context gathering from static prompt text
- fetch prompt inputs in parallel where possible
- return structured inputs rather than prebuilt strings

### Step 3: Define Override and Append Semantics

Files:

- `src/prompts/PromptComposer.ts`
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

## Risks

- overcomplicating prompt building before enough prompt variants exist
- mixing prompt construction concerns back into execution flow
- allowing section precedence to be split across multiple entrypoints
- treating all prompt sections as volatile and losing future cache leverage
- pushing runtime logic down into Markdown templates

## Success Criteria

- prompt construction is a distinct subsystem
- prompt assembly is testable without running the request loop
- prompt override and append behavior is explicit
- prompt sections have stable names and ordering
- prompt inputs are gathered separately from final assembly
- stable prompt text lives in `src/prompts/templates/` rather than large inline strings in code
