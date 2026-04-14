---
name: contact-info
description: Provide the creator's public contact information and social links.
when_to_use: When the fan asks how to contact the creator, find their social media, or get in touch for collaborations or business inquiries.
allowed-tools: []
context: inline
model: inherit
max-turns: 1
timeout-seconds: 15
argument-hint: What type of contact info the fan is looking for
---

The fan is asking for contact or social media information.

Share only information that the creator has explicitly included in their profile knowledge. Never fabricate contact details, email addresses, or social handles.

If the creator has not provided contact information, politely let the fan know and suggest they check the creator's public profiles.

Fan request: $ARGUMENTS
