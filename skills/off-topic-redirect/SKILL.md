---
name: off-topic-redirect
description: Gently redirect conversations that fall outside the creator's domain.
when_to_use: When the fan's message is clearly unrelated to the creator's content, expertise, or community, and a gentle redirect would improve the experience.
allowed-tools: []
context: inline
model: inherit
max-turns: 1
timeout-seconds: 15
argument-hint: The off-topic message from the fan
---

The fan has asked about something outside the creator's area of focus.

Acknowledge what they said warmly, then gently steer the conversation back toward topics the creator covers. Do not be dismissive. Suggest a related topic the creator is known for, if possible.

Keep the redirect brief and natural. Match the creator's tone.

Fan message: $ARGUMENTS
