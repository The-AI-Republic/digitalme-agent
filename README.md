# digitalme-agent

Platform-facing execution runtime for one creator-owned DigitalMe deployment.

## Status

MVP implementation. Design documents are in `.ai_design/`.

## Local Run

1. Copy `config.example.yaml` to `config.yaml`.
2. Export `DIGITALME_API_KEY`, `DIGITALME_SIGNING_SECRET`, and `MODEL_API_KEY`.
3. Run `npm install`.
4. Run `npm run dev`.

The service exposes:

- `GET /health`
- `POST /verify`
- `POST /v1/turn`

Fixed-at-startup model providers currently supported:

- `openai`
- `xai`
- `groq`
- `google-ai-studio`
- `fireworks`
- `together`

The provider/model is selected from `config.yaml` when the process starts. Changing it requires a restart; there is no runtime hot switch.

Platform heartbeat (keeps agent marked as "active"):

- set `platform.base_url` to the platform API URL — heartbeats start automatically
- tune `platform.heartbeat_interval_seconds` (default: 20)

## Docker

Build and run directly:

```bash
docker build -t digitalme-agent .
docker run --rm -p 8088:8088 \
  -e DIGITALME_API_KEY=change-me \
  -e DIGITALME_SIGNING_SECRET=change-me \
  -e MODEL_API_KEY=change-me \
  -e DIGITALME_CONFIG=/app/config.yaml \
  -v "$(pwd)/config.yaml:/app/config.yaml:ro" \
  digitalme-agent
```

Or use:

```bash
docker compose up --build
```

## Verification

Current verification coverage includes:

- runtime queue ordering and loop behavior
- HMAC validation
- real HTTP route coverage for `/verify` and `/v1/turn`
- SSE terminal event contract on the happy path

Run:

```bash
npm run build
npm test
```
