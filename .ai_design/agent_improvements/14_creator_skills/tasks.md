# 14 — Creator Skills Tasks

## Step 1: Skill Schema and Registry

- [ ] Define `CreatorSkillConfig` type in `src/skills/types.ts`
- [ ] Define `ResolvedSkill`, `SkillListing` types
- [ ] Add `src/skills/SkillValidator.ts` — name format, description length, prompt size, tool whitelist, limits
- [ ] Extend `src/config/schema.ts` — add `skills` array to creator config with Zod validation
- [ ] Add `src/skills/SkillRegistry.ts` — load from config, validate, resolve models, build tool registries
- [ ] Add `listForModel()` — return skills the model should see
- [ ] Add `get(name)` — return resolved skill for execution
- [ ] Add `reload()` — clear and reload on config change
- [ ] Enforce max 10 skills per creator

## Step 2: Prompt Template Engine

- [ ] Add `src/skills/PromptTemplate.ts` — compile and expand templates
- [ ] Support `$VARIABLE` and `${VARIABLE}` syntax
- [ ] Define built-in variables: `$QUERY`, `$CREATOR_NAME`, `$CREATOR_FAQ`, `$CREATOR_SCHEDULE`, `$CONVERSATION_SUMMARY`, `$FAN_NAME`
- [ ] Resolve custom variables from creator config fields
- [ ] Unknown variables expand to empty string (no crash)
- [ ] Enforce max prompt length (2000 chars after expansion)

## Step 3: CreatorSkillTool

- [ ] Add `src/tools/CreatorSkillTool.ts` — tool definition with Zod input schema
- [ ] Implement `execute()` — look up skill, expand template, route to inline/fork
- [ ] Implement inline execution path — TurnExecutor with restricted tool registry
- [ ] Implement forked execution path — ForkedAgent with timeout
- [ ] Handle skill not found → return error to model
- [ ] Handle fork concurrency limit → return graceful error
- [ ] Handle timeout → return timeout message to model
- [ ] Register CreatorSkillTool in tool registry when creator has skills configured

## Step 4: Model-Facing Skill Listing

- [ ] Add `src/skills/SkillListingBuilder.ts` — format skill listing for system prompt
- [ ] Truncate descriptions to 200 chars
- [ ] Enforce total listing budget (1500 chars max)
- [ ] Integrate with `SystemPromptBuilder` — add skill section when skills exist
- [ ] Include invocation instructions for the model
- [ ] Omit section entirely when creator has no skills

## Step 5: Guardrail Integration

- [ ] Wire input screening on expanded skill prompt (treat as fan input)
- [ ] Wire output validation on skill result (same rules as regular response)
- [ ] Ensure ToolExecutor policy enforcement applies within skill execution
- [ ] Block skills from accessing tools not in their `allowed_tools`
- [ ] Log guardrail decisions for skill invocations

## Step 6: Execution Tracking

- [ ] Define `SkillExecutionRecord` type
- [ ] Add `src/skills/SkillTracker.ts` — record per-invocation metrics
- [ ] Record: skill name, latency, tokens, tools used, success/failure
- [ ] Emit skill events to track 07 internal event bus
- [ ] Include in track 05 turn transcript
- [ ] Count skill token usage toward track 11 creator quota

## Step 7: Config Reload Support

- [ ] Wire `SkillRegistry.reload()` into track 12 `ConfigReloader`
- [ ] On config change: detect if skills section changed
- [ ] Reload skill registry without interrupting in-flight executions
- [ ] Log skill config changes as internal events
- [ ] Update system prompt skill listing on reload
