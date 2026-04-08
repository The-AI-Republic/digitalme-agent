# digitalme-agent

An open-source AI agent runtime that lets creators deploy their own AI persona. Each agent is a standalone Node.js service that connects to the [DigitalMe platform](https://digitalme.airepublic.com), receives fan messages, and streams responses back using any LLM provider.

Creators define their agent's personality and behavior in a simple YAML config — no AI expertise required.

## How it works

```
Fan (mobile app) ──► DigitalMe Platform ──► Your Agent (this repo)
                       (relay + auth)        (runs on your server)
```

1. A fan sends a message through the DigitalMe app
2. The platform authenticates the fan and forwards the message to your agent
3. Your agent processes it with an LLM and streams the response back via SSE
4. The platform delivers the response to the fan in real time

The agent owns all conversation logic. The platform handles user auth, moderation, and delivery.

## Features

- **Multi-provider LLM support** — OpenAI, xAI (Grok), Groq, Google AI Studio, Fireworks, Together, or any OpenAI-compatible API
- **Streaming responses** — Server-Sent Events for real-time token delivery
- **Tool use** — built-in web search, extensible tool framework with ReAct loop
- **HMAC-SHA256 authentication** — every request is cryptographically signed
- **Configurable personality** — name and system prompt via YAML
- **Session management** — in-memory conversation state with automatic eviction
- **Concurrency control** — per-conversation queuing with configurable limits
- **Docker ready** — single container deployment

## Quick start

**Prerequisites:** Node.js 20+

1. Clone and install:

   ```bash
   git clone https://github.com/The-AI-Republic/digitalme-agent.git
   cd digitalme-agent
   npm install
   ```

2. Configure your agent:

   ```bash
   cp config.example.yaml config.yaml
   ```

   Edit `config.yaml` to set your agent's personality (see [CONFIG.md](CONFIG.md) for all options):

   ```yaml
   persona:
     name: "Your Agent Name"
     default_system_prompt: |
       You are a helpful assistant. Be friendly and concise.

   model:
     provider: openai       # or xai, groq, google-ai-studio, fireworks, together
     name: gpt-4o
   ```

3. Set credentials as environment variables:

   ```bash
   export DIGITALME_API_KEY=<your-api-key>
   export DIGITALME_SIGNING_SECRET=<your-signing-secret>
   export MODEL_API_KEY=<your-llm-provider-key>
   ```

   The API key and signing secret are generated when you register your agent on the DigitalMe platform.

4. Run:

   ```bash
   npm run dev
   ```

   Your agent is now listening on `http://localhost:8088`.

## Docker

Make sure you've already created `config.yaml` (step 2 above), then set up your `.env`:

```bash
cp .env.example .env
# Edit .env with your API keys
```

Then run:

```bash
docker compose up --build
```

Or build and run directly (without Compose):

```bash
docker build -t digitalme-agent .
docker run --rm -p 8088:8088 \
  -e DIGITALME_API_KEY=<your-api-key> \
  -e DIGITALME_SIGNING_SECRET=<your-signing-secret> \
  -e MODEL_API_KEY=<your-llm-provider-key> \
  -v "$(pwd)/config.yaml:/app/config.yaml:ro" \
  digitalme-agent
```

## Supported LLM providers

| Provider | Config value | Example models |
|---|---|---|
| OpenAI | `openai` | `gpt-4o`, `gpt-4o-mini`, `o1` |
| xAI | `xai` | `grok-2`, `grok-3` |
| Groq | `groq` | `llama-3.3-70b-versatile`, `mixtral-8x7b-32768` |
| Google AI Studio | `google-ai-studio` | `gemini-2.0-flash`, `gemini-2.5-pro` |
| Fireworks | `fireworks` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Together | `together` | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` |

Any OpenAI-compatible API can be used by setting `model.base_url` in your config.

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | None | Liveness check |
| `POST` | `/verify` | HMAC | Credential verification handshake |
| `POST` | `/v1/task` | HMAC | Execute a task (SSE streaming response) |

## Documentation

- **[CONFIG.md](CONFIG.md)** — Full configuration reference
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — Agent protocol specification (implement this to build a custom agent in any language)
- **[docs/GLOSSARY.md](docs/GLOSSARY.md)** — Key concepts: conversations, sessions, tasks, and turns

## Building a custom agent

You don't have to use this runtime. The [protocol specification](docs/PROTOCOL.md) defines the HTTP contract between the platform and any agent. Implement the three endpoints with HMAC authentication in any language or framework, and your agent will work with the DigitalMe platform.

## Tests

```bash
npm run build
npm test
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
