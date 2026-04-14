# Consolidated Remediation Tasks

This file is the implementation backlog for the validated `gaps_0413` reports.

Use it as the execution entry point for remediation work. Each section references:

- the gap report in `gaps_0413/`
- the original design doc in `agent_improvements/<track>/IMPLEMENTATION_PLAN.md`
- the original track task list in `agent_improvements/<track>/tasks.md`

For tracks marked `DEFERRED`, this file records status only and does not create active implementation tasks.

---

## Track 01 -- Prompt Management

**Priority:** P2

**Tasks**
- [ ] Delete `src/prompts/PromptComposer.test.ts`.
- [ ] Update `src/config/schema.test.ts` to use `soul` instead of `persona`.
- [ ] Decide whether to add `requestSystemPromptAppend` back to `src/prompts/types.ts` for forward-compatibility, or explicitly document that it is intentionally omitted.

**Source references**
- Gap doc: `gaps_0413/track_01_prompt_management.md`
- Design doc: `DONE-01_prompt_management/IMPLEMENTATION_PLAN.md`
- Original tasks: `DONE-01_prompt_management/tasks.md`

## Track 02 -- Context Management

**Priority:** P1

**Tasks**
- [ ] Wire pipeline steps beyond microcompact into `prepareContextForModelCall()`: session-memory compaction, prompt projection, and post-compact recovery as intended by the design.
- [ ] Clear `SessionRuntime.sessionMemory` state when platform reseed occurs.
- [ ] Decide whether tool-result persistence should be gated until a file-read path exists, as the original design anticipated.
- [ ] Add the missing tests for the newly wired path if the existing module tests do not cover integration behavior.

**Source references**
- Gap doc: `gaps_0413/track_02_context_management.md`
- Design doc: `02_context_management/IMPLEMENTATION_PLAN.md`
- Original tasks: `02_context_management/tasks.md`

## Track 03 -- Tool Runtime

**Priority:** P2

**Tasks**
- [ ] Standardize Zod -> JSON Schema derivation across tools.
- [ ] Replace the local schema-export helper in `src/tools/web-search.ts`.
- [ ] Derive `CreatorSkillTool` model-facing parameters from its Zod schema.
- [ ] Expand `WebSearchTool` tests to cover execution success/failure and `renderForModel()`.

**Source references**
- Gap doc: `gaps_0413/track_03_tool_runtime.md`
- Design doc: `03_tool_runtime/IMPLEMENTATION_PLAN.md`
- Original tasks: `03_tool_runtime/tasks.md`

## Track 04 -- Recovery and Continuation

**Priority:** P2

**Tasks**
- [ ] Add `apiRetryCount` back to `RecoveryState` and wire it through retry bookkeeping.
- [ ] Make `model_error` an actual terminal reason path.
- [ ] Make `aborted` an actual terminal reason path.
- [ ] Make `IModelClientFactory.createFromConfig(...)` required instead of optional.
- [ ] Add focused tests for recovery terminal semantics and retry bookkeeping.

**Source references**
- Gap doc: `gaps_0413/track_04_recovery_and_continuation.md`
- Design doc: `04_recovery_and_continuation/IMPLEMENTATION_PLAN.md`
- Original tasks: `04_recovery_and_continuation/tasks.md`

## Track 05 -- Transcript and Artifact Storage

**Priority:** P2

**Tasks**
- [ ] Delete `src/agent/RolloutRecorder.test.ts`.
- [ ] Update `src/agent/SessionRuntime.test.ts` to stop importing `RolloutRecorder` types.
- [ ] Decide whether transcript retention/cleanup needs explicit implementation or explicit documentation as intentionally deferred.

**Source references**
- Gap doc: `gaps_0413/track_05_transcript_and_artifact_storage.md`
- Design doc: `05_transcript_and_artifact_storage/IMPLEMENTATION_PLAN.md`
- Original tasks: `05_transcript_and_artifact_storage/tasks.md`

## Track 06 -- Runtime State and Observers

**Priority:** P1 for test health, otherwise done

**Tasks**
- [ ] Delete `src/agent/TurnState.test.ts`.
- [ ] Delete `src/agent/shutdown.test.ts`.
- [ ] Confirm replacement coverage through current runtime-state tests; add no new tests unless a real gap is found.

**Source references**
- Gap doc: `gaps_0413/track_06_runtime_state_and_observers.md`
- Design doc: `06_runtime_state_and_observers/IMPLEMENTATION_PLAN.md`
- Original tasks: `06_runtime_state_and_observers/tasks.md`

## Track 07 -- Internal Events and Observability

**Priority:** P2

**Tasks**
- [ ] Wire `startToolSpan()` into tool execution so tool calls emit OTEL spans, not only metrics.
- [ ] Delete stale `RolloutRecorder` test artifacts and fix stale imports if not handled under Track 05.
- [ ] Add `compact_started` if the two-phase compaction lifecycle is still desired.
- [ ] Decide whether `deploymentHost` should be passed explicitly at startup instead of defaulting to `'unknown'`.

**Source references**
- Gap doc: `gaps_0413/track_07_internal_events_and_observability.md`
- Design doc: `07_internal_events_and_observability/IMPLEMENTATION_PLAN.md`
- Original tasks: `07_internal_events_and_observability/tasks.md`

## Track 08 -- Forked Agents and Subagents

**Priority:** P1

**Tasks**
- [ ] Register `SubagentTool` / `Task` in the startup tool registry when enabled.
- [ ] Decide whether the missing `subagents` config section should be added or the implementation should be intentionally hardcoded/documented.
- [ ] Decide whether `run_in_background` remains in scope; if not, remove it from design expectations explicitly.

**Source references**
- Gap doc: `gaps_0413/track_08_forked_and_subagents.md`
- Design doc: `DONE-08_forked_and_subagents/IMPLEMENTATION_PLAN.md`
- Original tasks: `DONE-08_forked_and_subagents/tasks.md`

## Track 09 -- Model Routing and Intelligence

**Priority:** P3

**Tasks**
- [ ] Either add the future-only `ModelCapability` type or explicitly mark it as intentionally omitted from implementation scope.

**Source references**
- Gap doc: `gaps_0413/track_09_model_routing_and_intelligence.md`
- Design doc: `09_model_routing_and_intelligence/IMPLEMENTATION_PLAN.md`
- Original tasks: `09_model_routing_and_intelligence/tasks.md`

## Track 10 -- Creator Guardrails and Safety

**Priority:** P0

**Tasks**
- [ ] Enforce `guardrailScope` in `TurnExecutor`.
- [ ] Persist refusal assistant text in blocked-input flows so history/transcript shape stays consistent.
- [ ] Validate partial text before streaming during max-output recovery.
- [ ] Add integration tests for `guardrailScope` public/internal behavior and truncation recovery.

**Source references**
- Gap doc: `gaps_0413/track_10_creator_guardrails_and_safety.md`
- Design doc: `10_creator_guardrails_and_safety/IMPLEMENTATION_PLAN.md`
- Original tasks: `10_creator_guardrails_and_safety/tasks.md`

## Track 11 -- Usage Tracking and Quotas

**Priority:** P1

**Tasks**
- [ ] Extract extended provider usage fields (cache/reasoning tokens) where the SDK responses support them.
- [ ] Wire `quota_warning` propagation into the runtime event stream.
- [ ] Persist conversation usage / restore on cold start if quota enforcement is meant to survive process restarts.
- [ ] Either consume `increaseCompaction` in routing/execution, or remove/document it as intentionally unused.
- [ ] Decide whether pricing should remain in source or move to configuration/data.

**Source references**
- Gap doc: `gaps_0413/track_11_usage_tracking_and_quotas.md`
- Design doc: `11_usage_tracking_and_quotas/IMPLEMENTATION_PLAN.md`
- Original tasks: `11_usage_tracking_and_quotas/tasks.md`

## Track 12 -- Configuration Lifecycle

**Priority:** deferred

**Tasks**
- [ ] No active remediation tasks. Leave deferred unless the project explicitly activates Track 12.

**Source references**
- Gap doc: `gaps_0413/track_12_configuration_lifecycle.md`
- Design doc: `12_configuration_lifecycle/IMPLEMENTATION_PLAN.md`
- Original tasks: `12_configuration_lifecycle/tasks.md`

## Track 13 -- Structured Analytics

**Priority:** deferred

**Tasks**
- [ ] No active remediation tasks. Leave deferred unless the project explicitly activates Track 13.

**Source references**
- Gap doc: `gaps_0413/track_13_structured_analytics.md`
- Design doc: `13_structured_analytics/IMPLEMENTATION_PLAN.md`
- Original tasks: `13_structured_analytics/tasks.md`

## Track 14 -- Creator Skills

**Priority:** P0

**Tasks**
- [ ] Add guardrail integration for skill input/output paths.
- [ ] Add skill execution tracking (`SkillTracker` or equivalent) plus events/metrics as intended.
- [ ] Add bundled skills content or explicitly document zero bundled skills as the intended initial state.
- [ ] Wire Docker / compose to copy and mount skill directories.
- [ ] Decide whether a skill-specific concurrency limit is required beyond the shared fork semaphore.

**Source references**
- Gap doc: `gaps_0413/track_14_creator_skills.md`
- Design doc: `14_creator_skills/IMPLEMENTATION_PLAN.md`
- Original tasks: `14_creator_skills/tasks.md`

---

## Cross-Track Execution Order

Recommended order if implementing from this backlog:

1. P0 safety and correctness:
   - Track 10
   - Track 14
   - stale-test cleanup from Tracks 05 and 06
2. P1 functional gaps:
   - Track 02
   - Track 08
   - Track 11
3. P2 completion and cleanup:
   - Tracks 03, 04, 07
   - Track 01 cleanup
4. P3 / deferred:
   - Track 09 minor doc/code alignment
   - Tracks 12 and 13 only if explicitly activated
