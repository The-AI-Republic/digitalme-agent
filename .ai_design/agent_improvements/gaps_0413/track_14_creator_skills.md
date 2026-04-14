# Track 14: Creator Skills -- Gap Analysis

## Summary

The core skill loading and execution pipeline is largely implemented. Main gaps are in guardrail integration, execution tracking, Docker/deployment configuration, and bundled skill content.

---

## Step 1: SKILL.md Parser and Scanner

**Status: COMPLETE**

| Task | Status | Notes |
|------|--------|-------|
| `LoadedSkill` type | YES | All fields present |
| `SkillParser` | YES | YAML frontmatter + markdown body, proper defaults |
| `SkillValidator` | YES | Name format, bounds, prompt length |
| `SkillScanner` | YES | Pattern scan, supporting context, symlink rejection |
| Tests | YES | Parser, validator, scanner all tested |

**Minor concern:** Oversized supporting file skips entire skill (throws instead of skipping just the file).

---

## Step 2: Config and Skill Registry

**Status: COMPLETE**

| Task | Status | Notes |
|------|--------|-------|
| Config schema (`skills.*`) | YES | `bundled_dir`, `local_dir` |
| `SkillRegistry` | YES | `load()`, `list()`, `get()`, max 20 skills |
| Local overrides bundled on name collision | YES | With warning log |
| Wired into `SessionManager` startup | YES | |

---

## Step 3: CreatorSkillTool

**Status: YES (with gaps)**

| Task | Status | Notes |
|------|--------|-------|
| Tool factory implementing `Tool<T>` | YES | |
| `$ARGUMENTS` expansion | YES | With HTML-escaping for security |
| Supporting context appended | YES | |
| Inline execution path | YES | |
| Forked execution path | YES | With `launchForkedAgent`, timeout, child registry |
| Child registry excludes `CreatorSkill` | YES | |
| Error handling (all paths) | YES | |
| Conditional registration (only when skills > 0) | YES | |
| `guardrailScope: 'internal'` on forks | YES | |
| `maxConcurrentSkills` limit | **NO** | Relies only on general fork semaphore, no skill-specific throttle |

---

## Step 4: Model-Facing Skill Listing

**Status: COMPLETE**

| Task | Status | Notes |
|------|--------|-------|
| `SkillListingBuilder` | YES | 1500 char budget, overflow marker |
| `PromptContext.skillListing` | YES | |
| Prompt section with `enabledWhen` | YES | |
| Template file | YES | |
| Tests | YES | |

---

## Step 5: Guardrail Integration

**Status: NO**

| Task | Status | Notes |
|------|--------|-------|
| Input screening on expanded skill prompt | **NO** | Skill args not screened as fan input |
| Output validation on skill result | **NO** | Forked output returned directly |
| Tool policy enforcement | PARTIAL | Allowed tools checked but not "platform-approved" |
| Log guardrail decisions | **NO** | |
| Guardrail deps as optional interfaces | **NO** | |

**Security concern:** For a public-facing agent, skill arguments (fan input) bypassing guardrails is a gap.

---

## Step 6: Execution Tracking

**Status: NO**

| Task | Status | Notes |
|------|--------|-------|
| `SkillTracker.ts` | **NO** | File does not exist |
| Per-invocation metrics | **NO** | `SkillExecutionRecord` type defined but never instantiated |
| Emit skill events to event bus | **NO** | |
| Include in turn transcript | PARTIAL | Fork transcripts recorded, but no skill-specific markers |
| Count toward creator quota | **NO** | |

---

## Step 7: Tests

**Status: COMPLETE**

All specified test scenarios covered across parser, validator, scanner, listing builder, and CreatorSkillTool tests.

---

## Docker/Deployment Configuration

**Status: NO**

| Task | Status | Notes |
|------|--------|-------|
| Bundled skills directory (`skills/`) | **NO** | Does not exist in repo |
| Dockerfile: `COPY skills ./skills` | **NO** | |
| docker-compose.yml: skills-local volume mount | **NO** | |
| Default bundled skills (faq-lookup, contact-info, off-topic-redirect) | **NO** | |

---

## Critical Missing Items (by impact)

1. **No bundled skills** -- agent ships with zero skills out of the box
2. **No execution tracking** -- skill usage is invisible (no metrics, no events, no quota)
3. **No guardrail integration** -- skill arguments bypass screening, output bypasses validation
4. **No Docker deployment wiring** -- Dockerfile/docker-compose not updated
5. **No `maxConcurrentSkills` limit** -- no skill-specific concurrency throttle
