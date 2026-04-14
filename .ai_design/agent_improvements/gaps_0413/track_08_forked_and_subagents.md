# Gap Analysis: Track 08 - Forked Agents and Subagents

## Summary

Track 08 is substantially implemented. All four steps (generator refactor, fork runtime, hooks + lifecycle, subagent tool) are present. The main gap is that the SubagentTool is not wired into the ToolRegistry at startup.

---

## Step 1: Generator Refactor + ExecutionOptions + State Versioning

| Task | Status | Notes |
|------|--------|-------|
| Convert `run()` to `async *` generator | YES | |
| `consumeGenerator()` helper | YES | |
| `ExecutionOptions` interface | YES | Plus bonus `guardrailScope` field |
| Session state versioning with `revision` | YES | |
| `compactHistory()` CAS guard | YES | |

**Status: COMPLETE**

---

## Step 2: ForkedAgent Runner

| Task | Status | Notes |
|------|--------|-------|
| `ForkSemaphore` | YES | 19 lines, clean |
| `launchForkedAgent()` | YES | 225 lines |
| Semaphore acquire/release | YES | Release in `finally` |
| Child AbortController linked to parent | YES | |
| `ForkedAgentHandle` construction | YES | |
| Config-level `canFork()` gate | YES | Beyond design -- improvement |

**Deviation:** Uses narrow `ForkedAgentLifecycle` interface instead of full `SessionRuntime` -- better interface segregation.

**Additions beyond design:** Transcript sidechain recording, OTEL spans, metrics, unhandled rejection suppression.

**Status: COMPLETE**

---

## Step 3: Post-Turn Hooks + Lifecycle Integration

| Task | Status | Notes |
|------|--------|-------|
| `PostTurnHookRegistry` | YES | Sequential execution, error catching |
| Timeout handling | YES | Promise.race |
| SessionRuntime integration (fork lifecycle) | YES | |
| SessionManager drain/eviction | YES | |
| Config: `forked_agents.*`, `hooks.*` | YES | |

**Status: COMPLETE**

---

## Step 4: Subagent Tool

| Task | Status | Notes |
|------|--------|-------|
| `AgentDefinition` interface | YES | |
| `BuiltInAgents.ts` | YES | Only `general-purpose` |
| `SubagentTool` implementing Tool interface | YES | 264 lines |
| `resolveSubagentTools()` | YES | Intersects with parent, applies denials |
| **Register SubagentTool in ToolRegistry** | **NO** | Not wired anywhere at startup |
| `run_in_background` support | **NO** | Removed -- always synchronous |
| Subagent config section | **NO** | No `subagents.*` in config schema |

**Status: PARTIAL -- SubagentTool exists as dead code**

---

## Critical Gaps

1. **SubagentTool not registered** -- The Task tool is fully implemented and tested but never added to the ToolRegistry. The model cannot invoke it. Needs registration in `SessionManager.ts` gated by config.

2. **No `subagents` config section** -- No way to enable/disable or configure subagent behavior.

3. **No `run_in_background` support** -- Design specified async execution option, implementation removed it.

## Minor Gaps

4. `BuiltInAgents` only defines `general-purpose` (design mentioned more agent types).
5. No drain/eviction integration tests with active forks.
6. `ForkSemaphore` has no `getMaxConcurrent()` for diagnostics.

## Notable Additions Beyond Design

- OpenTelemetry spans for forks, hooks, subagents
- Prometheus-style metrics
- Transcript sidechain recording
- Agent metadata persistence
- `CreatorSkillTool` and `SessionMemoryHook` as real consumers of fork API
