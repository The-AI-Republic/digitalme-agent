# Agent Configuration Reference

All configuration is defined in `config.yaml`. Values using `${VAR}` syntax are interpolated from environment variables at startup.

## soul

Defines the agent's personality and behavior. The prompt management system composes these fields into a system prompt automatically.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Display name for the agent. Typically matches the creator's name. |
| `description` | Yes | — | One-line description of who this agent is (e.g. "A personal wellness coach specializing in mindfulness"). |
| `tone` | No | — | How the agent speaks — warm, blunt, formal, playful, etc. |
| `boundaries` | No | — | What the agent won't do or discuss. |
| `knowledge` | No | — | Domain expertise or topics the agent knows about. |
| `others` | No | — | Any additional context the creator wants baked into the agent's personality. |
| `system_prompt_override` | No | — | Replace the auto-generated system prompt entirely with this string. |
| `system_prompt_append` | No | — | Append additional text to the auto-generated system prompt. |
| `tools.allow_web_search` | No | `false` | Enable the web search tool. |

## server

| Parameter | Required | Default | Description |
|---|---|---|---|
| `port` | No | `8088` | Port the agent HTTP server listens on. |
| `bind` | No | `0.0.0.0` | Address to bind to. Use `0.0.0.0` for all interfaces, `127.0.0.1` for localhost only. |

## auth

Credentials for authenticating with the platform. Generated when you create an agent connection on the platform.

| Parameter | Required | Description |
|---|---|---|
| `api_key` | Yes | Identifies this agent connection. Sent in the `X-DigitalMe-Key` header. Use `${DIGITALME_API_KEY}` to read from env. |
| `signing_secret` | Yes | Used to compute HMAC-SHA256 signatures for request authentication. Never sent over the wire. Use `${DIGITALME_SIGNING_SECRET}` to read from env. |

## platform

Connection back to the DigitalMe platform for heartbeats.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `base_url` | No | — | Platform API URL (e.g. `http://localhost:8080`). When set, the agent automatically sends heartbeats to stay marked as "active". |
| `heartbeat_interval_seconds` | No | `20` | How often to send heartbeats (in seconds). |

## model

LLM provider configuration.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `provider` | Yes | — | LLM provider. One of: `openai`, `anthropic`, `xai`, `groq`, `google-ai-studio`, `fireworks`, `together`. |
| `name` | Yes | — | Model name (e.g. `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-2.0-flash`). Must be valid for the chosen provider. |
| `api_key` | Yes | — | API key for the LLM provider. Use `${MODEL_API_KEY}` to read from env. |
| `base_url` | No | — | Override the provider's default API endpoint. Only needed for self-hosted or proxy setups (e.g. local Ollama). |
| `max_output_tokens` | No | `8192` | Maximum number of output tokens per model response. |

### Supported providers

| Provider | Value | Models (examples) |
|---|---|---|
| OpenAI | `openai` | `gpt-4o`, `gpt-4o-mini`, `o1` |
| Anthropic | `anthropic` | `claude-sonnet-4-20250514`, `claude-haiku-4-5-20251001` |
| xAI | `xai` | `grok-2`, `grok-3` |
| Groq | `groq` | `llama-3.3-70b-versatile`, `mixtral-8x7b-32768` |
| Google AI Studio | `google-ai-studio` | `gemini-2.0-flash`, `gemini-2.5-pro` |
| Fireworks | `fireworks` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Together | `together` | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` |

## limits

| Parameter | Required | Default | Description |
|---|---|---|---|
| `max_message_length` | No | `4000` | Maximum character length of a single user message. |
| `max_history_messages` | No | `100` | Maximum number of conversation history messages sent to the model. |
| `max_turns` | No | `10` | Maximum ReAct loop iterations per request (model calls + tool executions). |
| `max_concurrent` | No | `50` | Maximum number of requests being processed simultaneously. |
| `max_pending` | No | `1000` | Maximum number of requests waiting in the queue. |
| `max_active_sessions` | No | `1000` | Maximum number of active conversation sessions held in memory. |
| `session_ttl_seconds` | No | `1800` | Idle sessions are evicted after this many seconds (30 minutes). |

## security

| Parameter | Required | Default | Description |
|---|---|---|---|
| `hmac_tolerance_seconds` | No | `300` | Maximum allowed clock skew (in seconds) for HMAC timestamp validation. Requests older than this are rejected. |
