# Track 03 -- Tool Runtime Remediation Plan

## Status

Track 03 is already implemented at the subsystem level. The remaining work is **targeted completion and cleanup**, not a fresh implementation of the original design.

This document is implementation-ready and only covers the validated gaps that still matter in the current codebase.

## Validated Remaining Gaps

### Gap 1: Schema generation is still ad hoc

- `src/tools/web-search.ts` uses a hand-rolled `zodToJsonSchema()` helper that only handles `ZodString`.
- The original track explicitly called for `zod-to-json-schema` or an equivalent shared derivation path.
- Risk:
  - future tools with richer schemas will drift or expose incomplete JSON Schema to the model
  - each tool may solve schema export differently

### Gap 2: WebSearchTool coverage is shallow

- Existing tests validate schema shape, metadata, and summary behavior.
- Existing tests do **not** cover:
  - upstream success parsing
  - `renderForModel()` output shape
  - HTTP failure path
  - invalid JSON / malformed upstream response
- Risk:
  - tool behavior can regress without failing tests

### Gap 3: CreatorSkillTool schema export can drift from runtime schema

- `src/tools/CreatorSkillTool.ts` defines `definition.function.parameters` manually.
- `inputSchema` is defined separately with Zod.
- Risk:
  - the model-facing schema and runtime validator can diverge

### Clarification: what is *not* a missing implementation gap

- The repo **does** have TurnExecutor-level integration coverage for model -> `tool_calls` -> tool execution -> final text in `src/agent/TurnExecutor.test.ts`.
- The remaining testing gap is narrower: richer end-to-end coverage for structured tool results and tool-specific failure/rendering behavior.

## Remediation Scope

Implement the following only:

1. Standardize Zod -> JSON Schema derivation for tools.
2. Upgrade `WebSearchTool` tests to cover real execution paths.
3. Remove manual schema duplication in `CreatorSkillTool`.

Do **not** re-open completed ToolExecutor architecture work in this pass.

## Implementation Plan

### Step 1: Introduce shared schema derivation

**Target files**
- `src/tools/web-search.ts`
- `src/tools/CreatorSkillTool.ts`
- optionally a new shared helper such as `src/tools/schema.ts`
- `package.json`

**Changes**
- Add `zod-to-json-schema` dependency, or add one shared equivalent helper if the team prefers no new dependency.
- Replace the local `zodToJsonSchema()` in `web-search.ts` with the shared derivation path.
- Use the same derivation path for `CreatorSkillTool.definition.function.parameters`.

**Acceptance criteria**
- No tool in the current repo manually hand-builds JSON Schema while also owning a Zod `inputSchema`.
- `web_search` and `CreatorSkill` definitions are both derived from their runtime schemas.

### Step 2: Expand WebSearchTool tests

**Target files**
- `src/tools/web-search.test.ts`

**Changes**
- Add tests that mock `fetch` and verify:
  - successful upstream response produces structured `data`
  - `renderForModel()` includes heading/abstract/results as expected
  - non-2xx response returns `success: false`
  - invalid JSON response returns `success: false`
- Keep the current lightweight schema/metadata tests.

**Acceptance criteria**
- `WebSearchTool.execute()` success and failure paths are directly covered.
- `renderForModel()` behavior is asserted from actual execution results, not only from synthetic fixtures.

### Step 3: Eliminate CreatorSkillTool schema duplication

**Target files**
- `src/tools/CreatorSkillTool.ts`
- `src/tools/CreatorSkillTool.test.ts`

**Changes**
- Derive `definition.function.parameters` from `creatorSkillInputSchema`.
- Keep tool behavior unchanged.
- Add or update a test that confirms the exported parameters remain aligned with the Zod schema.

**Acceptance criteria**
- `CreatorSkillTool` has one source of truth for input shape.
- Existing CreatorSkillTool behavior and tests remain green.

## Test Plan

Run at minimum:

- `node --loader ts-node/esm --test src/tools/web-search.test.ts`
- `node --loader ts-node/esm --test src/tools/CreatorSkillTool.test.ts`
- `node --loader ts-node/esm --test src/tools/execution/ToolExecutor.test.ts`
- `node --loader ts-node/esm --test src/agent/TurnExecutor.test.ts`

## Out of Scope

- Reworking ToolExecutor architecture
- Replacing callback-based execution with an async generator boundary
- Reopening policy/runtime design decisions already landed
- Adding new tools beyond what the current validated gaps require

## Source References

- Gap analysis source: `gaps_0413/track_03_tool_runtime.md` (this file supersedes the earlier wording)
- Original design: `agent_improvements/03_tool_runtime/IMPLEMENTATION_PLAN.md`
- Original task inventory: `agent_improvements/03_tool_runtime/tasks.md`
