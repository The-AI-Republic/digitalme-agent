# DigitalMe Agent Protocol Specification

This document defines the HTTP protocol that a DigitalMe agent must implement to communicate with the DigitalMe platform. If you are building a custom agent in any language or framework, implement the endpoints and authentication described here.

**Protocol version:** v1

---

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
  - [HMAC-SHA256 Request Signing](#hmac-sha256-request-signing)
  - [Replay Protection](#replay-protection)
- [Endpoints](#endpoints)
  - [GET /health](#get-health)
  - [POST /verify](#post-verify)
  - [POST /v1/task](#post-v1task)
- [SSE Event Stream](#sse-event-stream)
  - [Event Format](#event-format)
  - [Event Types](#event-types)
  - [Stream Lifecycle](#stream-lifecycle)
- [Heartbeat (Agent → Platform)](#heartbeat-agent--platform)
- [Error Handling](#error-handling)
- [Limits & Defaults](#limits--defaults)
- [Examples](#examples)
  - [Signing a Request (Node.js)](#signing-a-request-nodejs)
  - [Signing a Request (Python)](#signing-a-request-python)
  - [curl: Health Check](#curl-health-check)
  - [curl: Verify](#curl-verify)
  - [curl: Task (SSE)](#curl-task-sse)

---

## Overview

The DigitalMe platform acts as a relay between fans (end users) and creator-hosted agents. The platform authenticates the fan, applies policy (rate limits, moderation), then forwards the conversation to the agent via this protocol. The agent owns all conversation logic and state.

```
Fan ──► Platform ──► Agent
         (relay)     (your server)
```

Your agent must expose three HTTP endpoints:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | None | Liveness check |
| `POST` | `/verify` | HMAC | Challenge-response handshake |
| `POST` | `/v1/task` | HMAC | Execute a task (SSE streaming) |

---

## Authentication

All `POST` endpoints are authenticated using HMAC-SHA256 request signing. The platform signs every request it sends to your agent. Your agent must verify the signature before processing the request.

### HMAC-SHA256 Request Signing

Every authenticated request includes three headers:

| Header | Description |
|--------|-------------|
| `X-DigitalMe-Key` | The API key identifying this agent connection |
| `X-DigitalMe-Signature` | Hex-encoded HMAC-SHA256 signature |
| `X-DigitalMe-Timestamp` | Unix timestamp (seconds) when the request was signed |

**Signature computation:**

```
signature = HMAC-SHA256(signing_secret, "{timestamp}:{raw_request_body}")
```

- `signing_secret` — the shared secret configured when registering the agent with the platform
- `timestamp` — the value of `X-DigitalMe-Timestamp`
- `raw_request_body` — the raw JSON string of the request body (not parsed/re-serialized)
- Output is hex-encoded (lowercase)

**Verification steps:**

1. Extract `X-DigitalMe-Key`, `X-DigitalMe-Signature`, and `X-DigitalMe-Timestamp` from headers. Reject with `401` if any are missing.
2. Compare `X-DigitalMe-Key` against the configured `api_key`. Use constant-time comparison. Reject with `401` if they don't match.
3. Check that `X-DigitalMe-Timestamp` is within the allowed tolerance window (default: 300 seconds). Reject with `401` (`replay_rejected`) if stale.
4. Compute the expected signature: `HMAC-SHA256(signing_secret, "{timestamp}:{raw_body}")`.
5. Compare the computed signature with `X-DigitalMe-Signature` using constant-time comparison. Reject with `401` if they don't match.

> **Important:** You must capture the raw request body before JSON parsing. Many frameworks consume the body stream during parsing — you'll need the original bytes for signature verification.

### Replay Protection

The timestamp check prevents replay attacks. The platform sends the current Unix timestamp (seconds) in `X-DigitalMe-Timestamp`. Your agent should reject requests where:

```
abs(current_time - request_timestamp) > tolerance_seconds
```

The default tolerance is **300 seconds** (5 minutes). This accounts for clock skew between the platform and your agent.

---

## Endpoints

### GET /health

Unauthenticated liveness probe. The platform calls this to verify your agent is reachable.

**Response:** `200 OK`

```json
{
  "status": "ok"
}
```

You may include additional fields (queue depth, session count, etc.) but the platform only requires `status`.

---

### POST /verify

Authenticated challenge-response endpoint. Called when a creator registers their agent with the platform, to confirm the agent is reachable and the credentials are correct.

**Request body:**

```json
{
  "type": "verification",
  "challenge": "a-random-string"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"verification"` | Always the literal string `"verification"` |
| `challenge` | `string` | A non-empty random string the platform expects echoed back |

**Success response:** `200 OK`

```json
{
  "challenge": "a-random-string"
}
```

Echo the `challenge` value back verbatim. The platform compares it to confirm the round-trip.

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{"error": "unauthorized"}` | Invalid API key or signature |
| `401` | `{"error": "replay_rejected"}` | Stale timestamp |
| `422` | `{"error": "..."}` | Malformed request body |

---

### POST /v1/task

The core endpoint. Executes a single task — one user message in, one streamed agent response out — as Server-Sent Events (SSE).

**Request body:**

```json
{
  "request_id": "req_abc123",
  "conversation_id": "conv_xyz789",
  "message": "Hello, how are you?",
  "history": [
    {"role": "user", "content": "Hi there"},
    {"role": "assistant", "content": "Hello! How can I help you today?"}
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `request_id` | `string` | Yes | Unique identifier for this request (used for deduplication) |
| `conversation_id` | `string` | Yes | Identifies the conversation session |
| `message` | `string` | Yes | The new user message for this task |
| `history` | `HistoryMessage[]` | Yes | Previous messages in chronological order (oldest first) |

**HistoryMessage:**

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"user"` or `"assistant"` | Who sent the message |
| `content` | `string` | The message text |

**Success response:** `200 OK` with `Content-Type: text/event-stream`

The response is an SSE stream. See [SSE Event Stream](#sse-event-stream) below.

**Error responses** (returned as JSON, not SSE — errors are caught before the stream opens):

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{"error": "unauthorized"}` | Invalid API key or signature |
| `401` | `{"error": "replay_rejected"}` | Stale timestamp |
| `401` | `{"error": "missing_header:X-DigitalMe-*"}` | Missing auth header |
| `409` | `{"error": "request_in_progress"}` | Duplicate `request_id` currently being processed |
| `422` | `{"error": "message_too_long"}` | `message` exceeds max length |
| `422` | `{"error": "history_too_long"}` | `history` exceeds max count |
| `422` | `{"error": "..."}` | Other validation failure |
| `429` | `{"error": "queue_full"}` | Agent is at capacity |
| `503` | `{"error": "shutting_down"}` | Agent is draining (graceful shutdown) |

---

## SSE Event Stream

When `/v1/task` succeeds, the response is a Server-Sent Events stream.

### Event Format

Events use the standard SSE `data:` field with JSON payloads. Events are unnamed (no `event:` field).

```
data: {"type":"text_delta","content":"Hello"}

data: {"type":"done"}

```

Each event is a `data:` line followed by a blank line (`\n\n`). The payload is a single-line JSON object.

### Event Types

#### `text_delta`

Streamed incrementally as the agent generates its response. Concatenate all `content` values to build the full response.

```json
{"type": "text_delta", "content": "Hello, "}
```

```json
{"type": "text_delta", "content": "how can I help you?"}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"text_delta"` | |
| `content` | `string` | A chunk of the response text |

#### `tool_start`

Emitted when the agent begins executing a tool call.

```json
{"type": "tool_start", "name": "web_search", "callId": "call_1"}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"tool_start"` | |
| `name` | `string` | Tool name |
| `callId` | `string` | Unique ID for this tool invocation |

#### `tool_end`

Emitted when the tool call completes.

```json
{"type": "tool_end", "name": "web_search", "callId": "call_1", "success": true}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"tool_end"` | |
| `name` | `string` | Tool name (matches the preceding `tool_start`) |
| `callId` | `string` | Same `callId` as the preceding `tool_start` |
| `success` | `boolean` | Whether the tool executed successfully |

#### `done`

Terminal event indicating the task completed successfully. Always the **last event** in a successful stream.

```json
{"type": "done"}
```

```json
{"type": "done", "tokenUsage": {"inputTokens": 150, "outputTokens": 42, "totalTokens": 192}}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"done"` | |
| `tokenUsage` | `TokenUsage` (optional) | Token usage for this task |

**TokenUsage:**

| Field | Type | Description |
|-------|------|-------------|
| `inputTokens` | `number` | Prompt/input tokens consumed |
| `outputTokens` | `number` | Completion/output tokens generated |
| `totalTokens` | `number` | Sum of input + output |

#### `error`

Terminal event indicating the task failed. Always the **last event** in a failed stream. Mutually exclusive with `done`.

```json
{"type": "error", "message": "model_timeout"}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"error"` | |
| `message` | `string` | Human-readable error description |

### Stream Lifecycle

A valid SSE stream follows these rules:

1. Zero or more `text_delta`, `tool_start`, and `tool_end` events in any interleaved order
2. Exactly one terminal event: either `done` or `error`
3. No events after the terminal event
4. If the client disconnects mid-stream, the agent should abort processing (the connection close signals cancellation)

**Typical successful stream:**

```
data: {"type":"text_delta","content":"Let me "}
data: {"type":"text_delta","content":"look that up."}
data: {"type":"tool_start","name":"web_search","callId":"call_1"}
data: {"type":"tool_end","name":"web_search","callId":"call_1","success":true}
data: {"type":"text_delta","content":"Here's what I found..."}
data: {"type":"done","tokenUsage":{"inputTokens":200,"outputTokens":85,"totalTokens":285}}
```

**Minimal successful stream (no tools):**

```
data: {"type":"text_delta","content":"Hello! How can I help you?"}
data: {"type":"done"}
```

---

## Heartbeat (Agent → Platform)

If configured with a platform base URL, the agent should send periodic heartbeats to keep its status as "active" on the platform. This is **agent-initiated** (your agent calls the platform, not the other way around).

**Endpoint:** `POST {platform_base_url}/agent-connections/heartbeat`

**Authentication:** Same HMAC-SHA256 signing as above — the agent signs its own requests using the same `api_key` and `signing_secret`.

**Request body:**

```json
{
  "status": "ok",
  "health": {
    "model_provider": "openai",
    "active_requests": 3,
    "completed_requests": 142,
    "failed_requests": 1,
    "draining": false
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | `"ok"` when healthy, `"draining"` during graceful shutdown |
| `health` | `object` (optional) | Arbitrary health metadata — no enforced schema |

**Behavior:**

- Default interval: **20 seconds**
- On `200 OK`: continue at normal interval
- On `409 Conflict`: back off with exponential delay (2x multiplier, max 60 seconds)
- On other errors: log and retry at next interval
- Timeout: bound to the heartbeat interval (max 10 seconds)

The heartbeat is optional for protocol compliance but required for the platform to show the agent as "active."

---

## Error Handling

### Pre-stream Errors

If validation or authentication fails **before** the SSE stream opens, the agent responds with a standard JSON error:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error": "unauthorized"}
```

### In-stream Errors

If an error occurs **after** the SSE stream has started (HTTP 200 already sent), the agent emits an `error` event as the terminal event:

```
data: {"type":"error","message":"model_timeout"}
```

The HTTP status is still 200 (already committed). The client must check the event type to distinguish success from failure.

### Client Disconnect

When the platform (client) disconnects mid-stream, the agent should:

1. Detect the connection close
2. Abort any in-progress LLM calls or tool executions
3. Clean up resources

---

## Limits & Defaults

These are the default limits enforced by the reference agent implementation. If building a custom agent, you may adjust these, but the platform will send requests within these bounds.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_message_length` | 4,000 chars | Maximum `message` length in a task request |
| `max_history_messages` | 100 | Maximum number of messages in `history` |
| `max_turns` | 10 | Maximum LLM round-trips per task (tool call loops) |
| `max_concurrent` | 50 | Maximum concurrent requests the agent will accept |
| `max_pending` | 1,000 | Maximum queued requests per conversation |
| `max_active_sessions` | 1,000 | Maximum concurrent conversation sessions |
| `session_ttl_seconds` | 1,800 | Idle session eviction time (30 minutes) |
| `hmac_tolerance_seconds` | 300 | Timestamp tolerance for replay protection (5 minutes) |

---

## Examples

### Signing a Request (Node.js)

```javascript
import crypto from 'node:crypto';

function signRequest(body, apiKey, signingSecret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestamp}:${body}`)
    .digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-DigitalMe-Key': apiKey,
    'X-DigitalMe-Signature': signature,
    'X-DigitalMe-Timestamp': timestamp,
  };
}

// Usage
const body = JSON.stringify({
  request_id: 'req_001',
  conversation_id: 'conv_001',
  message: 'Hello!',
  history: [],
});

const response = await fetch('http://localhost:8088/v1/task', {
  method: 'POST',
  headers: signRequest(body, 'my-api-key', 'my-signing-secret'),
  body,
});
```

### Signing a Request (Python)

```python
import hmac
import hashlib
import json
import time

def sign_request(body: str, api_key: str, signing_secret: str) -> dict:
    timestamp = str(int(time.time()))
    signature = hmac.new(
        signing_secret.encode(),
        f"{timestamp}:{body}".encode(),
        hashlib.sha256,
    ).hexdigest()

    return {
        "Content-Type": "application/json",
        "X-DigitalMe-Key": api_key,
        "X-DigitalMe-Signature": signature,
        "X-DigitalMe-Timestamp": timestamp,
    }

# Usage
body = json.dumps({
    "request_id": "req_001",
    "conversation_id": "conv_001",
    "message": "Hello!",
    "history": [],
})

headers = sign_request(body, "my-api-key", "my-signing-secret")
```

### curl: Health Check

```bash
curl http://localhost:8088/health
```

### curl: Verify

```bash
API_KEY="my-api-key"
SIGNING_SECRET="my-signing-secret"
BODY='{"type":"verification","challenge":"test-123"}'
TIMESTAMP=$(date +%s)
SIGNATURE=$(echo -n "${TIMESTAMP}:${BODY}" | openssl dgst -sha256 -hmac "${SIGNING_SECRET}" | awk '{print $2}')

curl -X POST http://localhost:8088/verify \
  -H "Content-Type: application/json" \
  -H "X-DigitalMe-Key: ${API_KEY}" \
  -H "X-DigitalMe-Signature: ${SIGNATURE}" \
  -H "X-DigitalMe-Timestamp: ${TIMESTAMP}" \
  -d "${BODY}"
```

### curl: Task (SSE)

```bash
API_KEY="my-api-key"
SIGNING_SECRET="my-signing-secret"
BODY='{"request_id":"req_001","conversation_id":"conv_001","message":"Hello!","history":[]}'
TIMESTAMP=$(date +%s)
SIGNATURE=$(echo -n "${TIMESTAMP}:${BODY}" | openssl dgst -sha256 -hmac "${SIGNING_SECRET}" | awk '{print $2}')

curl -N -X POST http://localhost:8088/v1/task \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "X-DigitalMe-Key: ${API_KEY}" \
  -H "X-DigitalMe-Signature: ${SIGNATURE}" \
  -H "X-DigitalMe-Timestamp: ${TIMESTAMP}" \
  -d "${BODY}"
```

(`-N` disables output buffering so you see SSE events in real time.)
