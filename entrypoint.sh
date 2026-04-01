#!/bin/sh
# Fix ownership of mounted volumes, then drop to agent user
chown -R agent:agent /app/.digital_me_agent 2>/dev/null
exec su -s /bin/sh agent -c "npm start"
