# Agent Improvements Gap Analysis -- 2026-04-13

## Overview

Deep-dive comparison of all 14 tracks' design docs and task docs against actual code in the `agent_improvements` branch. Each track has a dedicated report in this directory.

---

## Track Status at a Glance

| Track | Name | Implementation | Gaps | Severity |
|-------|------|---------------|------|----------|
| 01 | Prompt Management | DONE | Orphaned test file; persona->soul breaking change | MEDIUM |
| 02 | Context Management | PARTIAL | Pipeline Steps 3-6 not wired; session memory not cleared on reseed | HIGH |
| 03 | Tool Runtime | DONE | Missing `zod-to-json-schema` library; some test gaps | LOW |
| 04 | Recovery and Continuation | DONE | Unused terminal reasons; unused class-based recovery modules | LOW |
| 05 | Transcript and Artifact | DONE | Stale RolloutRecorder test files; no retention policy | MEDIUM |
| 06 | Runtime State and Observers | DONE | Stale TurnState.test.ts and shutdown.test.ts | MEDIUM |
| 07 | Internal Events and Observability | DONE | Tool spans not wired into ToolExecutor; stale test files | MEDIUM |
| 08 | Forked Agents and Subagents | DONE | SubagentTool not registered in ToolRegistry | HIGH |
| 09 | Model Routing and Intelligence | DONE | `ModelCapability` type omitted (future-only) | LOW |
| 10 | Creator Guardrails and Safety | PARTIAL | guardrailScope not enforced; truncation recovery bypasses guardrails | HIGH |
| 11 | Usage Tracking and Quotas | PARTIAL | No provider token extraction; no persistence; quota warnings not wired | HIGH |
| 12 | Configuration Lifecycle | DEFERRED | Zero implementation (by design) | N/A |
| 13 | Structured Analytics | DEFERRED | Zero implementation; Track 07 OTEL covers ~40% | N/A |
| 14 | Creator Skills | PARTIAL | No guardrail integration; no execution tracking; no bundled skills; no Docker wiring | HIGH |

---

## Cross-Cutting Issues

### Stale Test Files (affects build/test suite)

These files import deleted modules and will cause test failures:

| File | Imports Deleted | Should |
|------|----------------|--------|
| `src/prompts/PromptComposer.test.ts` | `PromptComposer.ts` | Delete |
| `src/agent/RolloutRecorder.test.ts` | `RolloutRecorder.ts` | Delete |
| `src/agent/TurnState.test.ts` | `TurnState.ts` | Delete |
| `src/agent/shutdown.test.ts` | `shutdown.ts` | Delete |
| `src/agent/SessionRuntime.test.ts` | `RolloutEntry` from `RolloutRecorder.js` | Fix import |

### Dead Code Modules

These modules exist with tests but are NOT wired into the runtime:

| Module | Location | Intended For | Alternative Used |
|--------|----------|-------------|-----------------|
| `ReactiveCompact` (class) | `src/agent/context/ReactiveCompact.ts` | LLM-based compaction | Simple `reactiveCompact.ts` |
| `MaxOutputRecovery` (class) | `src/agent/context/MaxOutputRecovery.ts` | Class-based recovery | Inline in TurnExecutor |
| `PostCompactRecovery` | `src/agent/context/PostCompactRecovery.ts` | Post-compact context | Not used |
| `SubagentTool` | `src/agent/subagent/SubagentTool.ts` | Model-invokable subtask | Not registered |

### Session Memory Bug

Session memory is NOT cleared on platform reseed (`SessionRuntime.ts`). Stale memory from a previous conversation can pollute reseeded sessions.

---

## Priority Remediation (Top 10)

### P0 -- Blocking / Security

1. **Delete stale test files** (5 files) -- these break the test suite
2. **Enforce guardrailScope in TurnExecutor** -- internal/subagent turns bypass fan-facing guardrails (Track 10)
3. **Validate partial chunks during truncation recovery** -- blocked content streams to client before final validation (Track 10)
4. **Add guardrail integration to CreatorSkillTool** -- fan input via skill arguments bypasses screening (Track 14)

### P1 -- Functional Gaps

5. **Wire pipeline Steps 3-6 into `prepareContextForModelCall()`** -- session memory compaction, prompt projection, and recovery are dead code (Track 02)
6. **Clear session memory on reseed** -- stale memory pollutes reseeded sessions (Track 02)
7. **Register SubagentTool in ToolRegistry** -- fully implemented tool is invisible to the model (Track 08)
8. **Wire quota warning events** -- `quota_warning` defined but never emitted, no advance warning before hard refusal (Track 11)

### P2 -- Quality / Completeness

9. **Extract extended token usage from providers** -- cache/reasoning tokens ignored, cost estimates inaccurate (Track 11)
10. **Wire tool spans into ToolExecutor** -- tool executions produce metrics but no OTEL traces (Track 07)

---

## Per-Track Reports

- [Track 01: Prompt Management](track_01_prompt_management.md)
- [Track 02: Context Management](track_02_context_management.md)
- [Track 03: Tool Runtime](track_03_tool_runtime.md)
- [Track 04: Recovery and Continuation](track_04_recovery_and_continuation.md)
- [Track 05: Transcript and Artifact Storage](track_05_transcript_and_artifact_storage.md)
- [Track 06: Runtime State and Observers](track_06_runtime_state_and_observers.md)
- [Track 07: Internal Events and Observability](track_07_internal_events_and_observability.md)
- [Track 08: Forked Agents and Subagents](track_08_forked_and_subagents.md)
- [Track 09: Model Routing and Intelligence](track_09_model_routing_and_intelligence.md)
- [Track 10: Creator Guardrails and Safety](track_10_creator_guardrails_and_safety.md)
- [Track 11: Usage Tracking and Quotas](track_11_usage_tracking_and_quotas.md)
- [Track 12: Configuration Lifecycle](track_12_configuration_lifecycle.md)
- [Track 13: Structured Analytics](track_13_structured_analytics.md)
- [Track 14: Creator Skills](track_14_creator_skills.md)
