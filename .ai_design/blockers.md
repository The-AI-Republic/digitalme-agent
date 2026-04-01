# Blocker Issues — Post-Migration

Issues inherited from the sodapop monorepo. All issues below have been resolved.

---

## CRITICAL (resolved)

### 1. ~~HMAC timing side-channel leaks API key length~~

- **File:** `src/middleware/hmac.ts`
- **Fix:** Hash both inputs to SHA-256 before comparing, ensuring fixed-length buffers for `timingSafeEqual`.

### 2. ~~HMAC validates against empty body when parsing fails~~

- **File:** `src/middleware/hmac.ts`
- **Fix:** Reject the request with `missing_body` if `rawBody` is undefined.

### 3. ~~SubmissionQueue activeCount race allows exceeding max_concurrent~~

- **File:** `src/agent/SubmissionQueue.ts`
- **Fix:** Increment `activeCount` and add to `activeConversations` synchronously at submission time. Decrement in `startNext` only when no pending work remains.

---

## HIGH (resolved)

### 4. ~~Agent health stats never record failures~~

- **Files:** `src/agent/Agent.ts`, `src/agent/SubmissionQueue.ts`
- **Fix:** Added `onComplete(failed)` callback from `SubmissionQueue` to `Agent`, so health stats are updated regardless of whether the queue catches the error.

### 5. ~~Google client callCounter can collide across concurrent requests~~

- **File:** `src/models/client/GoogleCompletionClient.ts`
- **Fix:** Replaced monotonic `callCounter` with `crypto.randomUUID()`.

### 6. ~~finish_reason 'length' silently truncates responses~~

- **File:** `src/models/client/OpenAICompatibleClient.ts`
- **Fix:** Detect `finish_reason === 'length'` and set `truncated: true` on the result. Propagated through `TurnExecutor` to the SSE `done` event.

### 7. ~~EventQueue missing return() — resource leak on consumer disconnect~~

- **File:** `src/agent/EventQueue.ts`
- **Fix:** Implemented `return()` on the async iterator to close the queue and drain buffered events.

### 8. ~~Docker signal handling via su is unreliable~~

- **Files:** `Dockerfile`, `entrypoint.sh`
- **Fix:** Removed `su` privilege drop. Dockerfile now uses `USER agent` directive; signals propagate directly to the Node.js process.

### 9. ~~History message content has no max length~~

- **File:** `src/config/schema.ts`
- **Fix:** Added `.max(100_000)` to the `content` field in `historyMessageSchema`.
