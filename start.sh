#!/usr/bin/env bash
#
# Start the DigitalMe Agent with an ngrok tunnel on port 8088.
#
# Usage:
#   ./start.sh              # normal start
#   ./start.sh --no-tunnel  # skip ngrok, local-only mode
#
set -euo pipefail

AGENT_PORT=8088

# ── Helpers ──────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[agent]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[agent]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[agent]\033[0m %s\n' "$*" >&2; }
die()  { err "$@"; exit 1; }

cleanup() {
  log "Shutting down..."
  if [ -n "${NGROK_PID:-}" ] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID" 2>/dev/null || true
    wait "$NGROK_PID" 2>/dev/null || true
    log "ngrok stopped."
  fi
  docker compose down 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT INT TERM

# ── Pre-flight checks ───────────────────────────────────────────────

command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "docker compose is not available."

[ -f config.yaml ] || die "config.yaml not found. Copy config.example.yaml and edit it first."
[ -f .env ]        || die ".env not found. Copy .env.example and fill in your credentials."

SKIP_TUNNEL=false
if [ "${1:-}" = "--no-tunnel" ]; then
  SKIP_TUNNEL=true
fi

# ── ngrok tunnel ─────────────────────────────────────────────────────

NGROK_PID=""
TUNNEL_URL=""

if [ "$SKIP_TUNNEL" = true ]; then
  log "Skipping ngrok tunnel (--no-tunnel)."
else
  # Install ngrok if missing
  if ! command -v ngrok >/dev/null 2>&1; then
    log "ngrok not found. Installing..."
    if command -v apt-get >/dev/null 2>&1; then
      # Debian/Ubuntu
      curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
        | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
      echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
        | sudo tee /etc/apt/sources.list.d/ngrok.list >/dev/null
      sudo apt-get update -qq && sudo apt-get install -y -qq ngrok
    elif command -v yum >/dev/null 2>&1; then
      # RHEL/CentOS/Amazon Linux
      sudo tee /etc/yum.repos.d/ngrok.repo >/dev/null <<'REPO'
[ngrok]
name=ngrok
baseurl=https://ngrok-agent.s3.amazonaws.com/rpm
enabled=1
gpgcheck=1
gpgkey=https://ngrok-agent.s3.amazonaws.com/ngrok.asc
REPO
      sudo yum install -y ngrok
    elif command -v brew >/dev/null 2>&1; then
      # macOS
      brew install ngrok
    else
      die "Cannot auto-install ngrok. Install manually: https://ngrok.com/download"
    fi
    command -v ngrok >/dev/null 2>&1 || die "ngrok installation failed."
    log "ngrok installed."
  fi

  # Check if ngrok is already tunnelling port 8088
  EXISTING_URL=""
  if curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -q .; then
    EXISTING_URL=$(
      curl -sf http://127.0.0.1:4040/api/tunnels \
        | python3 -c "
import sys, json
tunnels = json.load(sys.stdin).get('tunnels', [])
for t in tunnels:
    cfg = t.get('config', {})
    addr = cfg.get('addr', '')
    if addr.endswith(':$AGENT_PORT') or addr == 'http://localhost:$AGENT_PORT':
        print(t.get('public_url', ''))
        break
" 2>/dev/null || true
    )
  fi

  if [ -n "$EXISTING_URL" ]; then
    TUNNEL_URL="$EXISTING_URL"
    log "ngrok already tunnelling port $AGENT_PORT → $TUNNEL_URL"
  else
    # Check for any OTHER ngrok tunnels (we won't touch them)
    if curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -q '"tunnels":\[{'; then
      warn "ngrok is running with other tunnels. Adding port $AGENT_PORT only."
      # Use the ngrok API to add a tunnel to the running instance
      RESP=$(curl -sf -X POST http://127.0.0.1:4040/api/tunnels \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"digitalme-agent\",\"proto\":\"http\",\"addr\":\"$AGENT_PORT\"}" 2>&1) || true

      TUNNEL_URL=$(echo "$RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('public_url', ''))
" 2>/dev/null || true)

      if [ -z "$TUNNEL_URL" ]; then
        die "Failed to add ngrok tunnel for port $AGENT_PORT. Response: $RESP"
      fi
    else
      # No ngrok running — start fresh for port 8088 only
      log "Starting ngrok tunnel on port $AGENT_PORT..."
      ngrok http "$AGENT_PORT" --log=stdout --log-level=warn &
      NGROK_PID=$!

      # Wait for the tunnel to come up
      for i in $(seq 1 15); do
        sleep 1
        TUNNEL_URL=$(
          curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null \
            | python3 -c "
import sys, json
tunnels = json.load(sys.stdin).get('tunnels', [])
for t in tunnels:
    url = t.get('public_url', '')
    if url.startswith('https://'):
        print(url)
        break
" 2>/dev/null || true
        )
        [ -n "$TUNNEL_URL" ] && break
      done

      if [ -z "$TUNNEL_URL" ]; then
        die "ngrok failed to start within 15 seconds. Check: ngrok config check"
      fi
    fi
    log "ngrok tunnel ready: $TUNNEL_URL → localhost:$AGENT_PORT"
  fi

  echo ""
  log "┌─────────────────────────────────────────────────────────────┐"
  log "│  Set this as your agent's endpoint_url on the platform:    │"
  log "│                                                            │"
  log "│  $TUNNEL_URL"
  log "│                                                            │"
  log "└─────────────────────────────────────────────────────────────┘"
  echo ""
fi

# ── Start the agent ──────────────────────────────────────────────────

log "Starting DigitalMe Agent..."
docker compose up --build
