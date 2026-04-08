#!/bin/sh
# Fix ownership of mounted volumes, then drop to agent user.
# gosu replaces the current process (exec-style), so signals
# propagate directly to Node.js — unlike su, which forks a child.
chown -R agent:agent /app/.digital_me_agent 2>/dev/null
exec gosu agent npm start
