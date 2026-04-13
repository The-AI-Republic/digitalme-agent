# 14 — Creator Skills Tasks

## Step 1: SKILL.md Parser and Scanner

- [ ] Define `LoadedSkill` type in `src/skills/types.ts`
- [ ] Define `SkillExecutionRecord` type in `src/skills/types.ts`
- [ ] Add `src/skills/SkillParser.ts` — parse YAML frontmatter + markdown body from SKILL.md
- [ ] Use the existing `yaml` dependency for frontmatter parsing
- [ ] Apply defaults: `context: inline`, `max_turns: 1` (inline) / `3` (fork), `timeout_seconds: 30`, `model: inherit`
- [ ] Name falls back to directory name if not in frontmatter
- [ ] Include `argument_hint`, `source`, and `source_dir` in `LoadedSkill`
- [ ] Add `src/skills/SkillValidator.ts` — name format, description length, prompt size, limits
- [ ] Add `src/skills/SkillScanner.ts` — scan directory for `*/SKILL.md` pattern
- [ ] Load supporting `.md` files from skill directory as `supporting_context`
- [ ] Enforce supporting context limits: max 5 files, max 50 KB per file
- [ ] Skip invalid skills with warning log (don't crash on bad skill files)
- [ ] Return empty array if directory doesn't exist

## Step 2: Config and Skill Registry

- [ ] Add `skills` section to `src/config/schema.ts` with `bundled_dir` and `local_dir`
- [ ] Default `bundled_dir` to `./skills` so `npm run dev` works outside Docker
- [ ] Default `local_dir` to `/app/skills-local`
- [ ] Add `src/skills/SkillRegistry.ts` — `load()`, `list()`, `get()`, `size`
- [ ] `load(bundledDir, localDir)` — scan both dirs, merge with local overriding bundled on name collision
- [ ] Wire into agent startup — load skills once at init
- [ ] Log loaded skill count and names at startup
- [ ] Log warning when local skill overrides bundled skill
- [ ] Enforce max 20 skills total (bundled + local combined)

## Step 3: CreatorSkillTool

- [ ] Add `src/tools/CreatorSkillTool.ts` as a real `Tool` factory, matching `src/tools/types.ts`
- [ ] Reuse the `ToolDefinition` / `ToolMetadata` / `inputSchema` / `isConcurrencySafe()` pattern used by `createSubagentTool(...)`
- [ ] Implement delimited `$ARGUMENTS` expansion in skill prompt (with fallback: append `<skill-arguments>` when args exist but prompt has no `$ARGUMENTS`)
- [ ] Append supporting context to expanded prompt
- [ ] Implement inline execution path as tool-result prompt expansion in the parent turn
- [ ] Implement forked execution path via `launchForkedAgent(...)` with correct `forkSemaphore`, `config`, and `submission.signal` usage
- [ ] Add `awaitWithTimeout` helper for forked execution (required — `timeout-seconds` is a validated frontmatter field)
- [ ] Build `TurnSubmission` for forked skills with all required fields: `requestId`, `conversationId`, `userMessage`, `history: []`, `promptHistory`, `signal`
- [ ] Reuse `resolveSubagentTools(...)`-style filtering for child tool registries
- [ ] Exclude `CreatorSkill` from child registries to prevent recursion
- [ ] Handle skill not found → return error with `renderForModel()` to model
- [ ] Handle fork concurrency limit → return graceful error with `renderForModel()`
- [ ] Handle timeout → return timeout message with `renderForModel()` to model
- [ ] Ensure ALL return paths include `renderForModel()` (required by `ToolExecutionResult`)
- [ ] Register CreatorSkillTool in tool registry only when skills exist (skip if 0 skills loaded)

## Step 4: Model-Facing Skill Listing

- [ ] Add `src/skills/SkillListingBuilder.ts` — format skill listing for system prompt
- [ ] Combine `description` + `when_to_use`, truncate to 200 chars per skill
- [ ] Enforce total listing budget (1500 chars max)
- [ ] Define deterministic overflow behavior when not all skills fit in the budget
- [ ] Add `skillListing` to `PromptContext`
- [ ] Add a new prompt section to `PROMPT_SECTIONS`
- [ ] Integrate with `SystemPromptBuilder` — add skill section when skills exist
- [ ] Include invocation instructions for the model
- [ ] Omit section entirely when no skills loaded

## Step 5: Guardrail Integration

- [ ] Wire input screening on expanded skill prompt (treat skill args as fan input)
- [ ] Wire output validation on skill result (same rules as regular response)
- [ ] Ensure ToolExecutor policy enforcement applies within skill execution
- [ ] Block skills from accessing tools not in their `allowed-tools`
- [ ] Log guardrail decisions for skill invocations
- [ ] Align with Track 10 `guardrailScope`: forked skill turns use `'internal'` (omit until Track 10 adds the field to `ExecutionOptions`)
- [ ] Keep inline skills inside the parent turn's normal guardrail flow
- [ ] Treat guardrail deps as optional injected interfaces until Track 10 implementation lands

## Step 6: Execution Tracking

- [ ] Add `src/skills/SkillTracker.ts` — record per-invocation metrics
- [ ] Record: skill name, latency, tokens, tools used, success/failure, context mode
- [ ] Emit skill events to track 07 internal event bus
- [ ] Include in track 05 turn transcript
- [ ] Count skill token usage toward track 11 creator quota
- [ ] Align skill tracking payloads with existing `ToolExecutionRecord`, `ToolSummaryEntry`, and transcript entry shapes where possible

## Step 7: Tests

- [ ] Add parser tests for frontmatter defaults and invalid fields
- [ ] Add validator tests for name rules, prompt limits, and supporting-file limits
- [ ] Add scanner tests for missing directories and local-overrides-bundled behavior
- [ ] Add listing builder tests for budget truncation and omitted-skills marker
- [ ] Add integration test for inline skill invocation returning prompt text to the model
- [ ] Add integration test for forked skill invocation with timeout handling
- [ ] Add integration test that child registries exclude `CreatorSkill`
- [ ] Add unit test for argument expansion: `$ARGUMENTS` replacement, fallback append when no placeholder, and no-op when no args
