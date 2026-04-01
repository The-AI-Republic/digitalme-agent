# Blocker Issues — Post-Migration

Issues inherited from the sodapop monorepo that must be fixed before production use.

---

## CRITICAL

### 1. HMAC timing side-channel leaks API key length

- **File:** `src/middleware/hmac.ts:18`
- `timingSafeEqualString` short-circuits when buffer lengths differ, never calling `timingSafeEqual`. An attacker can determine the API key length via timing measurements on the `X-DigitalMe-Key` header.
- **Fix:** Hash both inputs to a fixed-length digest before comparing, or always call `timingSafeEqual` on fixed-length values.

### 2. HMAC validates against empty body when parsing fails

- **File:** `src/middleware/hmac.ts:36`
- `rawBody` falls back to `''` if undefined. If `express.json()` rejects the body (wrong Content-Type, malformed JSON), the HMAC validates against `"${timestamp}:"`. An attacker who knows the signing secret can forge a valid signature for an empty body, bypassing integrity checks.
- **Fix:** Reject the request if `rawBody` is undefined rather than falling back to empty string.

### 3. SubmissionQueue activeCount race allows exceeding max_concurrent

- **File:** `src/agent/SubmissionQueue.ts:19-26`
- The capacity check reads `activeCount` synchronously, but the increment happens inside the async `execute` closure (next microtick). Between `void execute()` firing and the first microtick running, another synchronous `submit()` call passes the capacity check.
- **Fix:** Increment `activeCount` synchronously at submission time, not inside the async closure.

---

## HIGH

### 4. Agent health stats never record failures

- **Files:** `src/agent/Agent.ts:47-57`, `src/agent/SubmissionQueue.ts:28-31`
- `SubmissionQueue` catches errors and converts them to events, so the `Agent`-level callback never sees a throw. `failedRequests` is never incremented; `completedRequests` is always incremented even on failure.
- **Fix:** Propagate a success/failure status from `SubmissionQueue` to the `Agent` callback, or move health-stat tracking into the queue itself.

### 5. Google client callCounter can collide across concurrent requests

- **File:** `src/models/client/GoogleCompletionClient.ts:28,81`
- Shared monotonic counter on a singleton client. Concurrent `generate()` calls can produce duplicate tool-call IDs.
- **Fix:** Use `crypto.randomUUID()` instead.

### 6. finish_reason 'length' silently truncates responses

- **File:** `src/models/client/OpenAICompatibleClient.ts:53-82`
- When the model hits its token limit, the code falls through to the `final_text` branch and returns a truncated response without signaling the caller.
- **Fix:** Detect `finish_reason === 'length'` and either throw or signal truncation to the caller.

### 7. EventQueue missing return() — resource leak on consumer disconnect

- **File:** `src/agent/EventQueue.ts:23-38`
- No `return()` method on the async iterator. If a consumer breaks out of `for await...of`, the producer keeps pushing events into an unbounded buffer.
- **Fix:** Implement `return()` to close the queue and drain buffered events.

### 8. Docker signal handling via su is unreliable

- **Files:** `Dockerfile`, `entrypoint.sh:3-4`
- Container PID 1 is a root shell using `su` to drop privileges. Signals may not propagate to the Node.js process, causing ungraceful shutdowns.
- **Fix:** Use `gosu` instead of `su`, or restructure to avoid root entirely.

### 9. History message content has no max length

- **File:** `src/protocol/schemas.ts:3`
- `historyMessageSchema` defines `content: z.string()` with no max length. An attacker could send 100 history messages each with multi-MB content, exhausting memory and LLM token budget.
- **Fix:** Add `.max()` to the content field in the Zod schema, aligned with `max_message_length` from config.
