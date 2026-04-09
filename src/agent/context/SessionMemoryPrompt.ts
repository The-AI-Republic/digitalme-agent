export const SESSION_MEMORY_TEMPLATE = `# Conversation Title
_A short and distinctive 5-10 word title for this conversation. Info-dense, no filler._

# Current State
_What is the current topic or activity? What was the fan just asking about? What is the agent about to do or respond to?_

# Fan Profile
_What do we know about this fan? Name, preferences, interests, communication style, expertise level._

# Relationship Context
_What is the tone and familiarity level? Any inside references, recurring jokes, or shared context? How should the agent adjust its voice?_

# Key Facts Exchanged
_Important information shared by either side during this conversation. Specific details the fan mentioned. Commitments or promises the agent made._

# Ongoing Topics
_Active discussion threads and unresolved questions. Topics the fan may return to. Things the agent offered to follow up on._

# Conversation Flow
_Step-by-step terse summary of how the conversation progressed. Key turns and topic shifts._
`;

export function buildExtractionPrompt(currentNotes: string): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual conversation with the fan. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the conversation above (EXCLUDING this note-taking instruction message as well as system prompt, persona configuration, or any past session summaries), produce an updated version of the session notes.

Here are the current notes:
<current_notes_content>
${currentNotes}
</current_notes_content>

Your ONLY task is to output the complete updated notes file. Output ONLY the markdown content, nothing else.

CRITICAL RULES:
- The output must maintain the exact structure with all sections, headers, and italic descriptions intact
- NEVER modify, delete, or add section headers (the lines starting with '#')
- NEVER modify or delete the italic _section description_ lines
- ONLY update the actual content that appears BELOW the italic descriptions within each existing section
- Do NOT add any new sections, summaries, or information outside the existing structure
- Do NOT reference this note-taking process or instructions anywhere in the notes
- It's OK to leave sections blank if there are no substantial new insights
- Write DETAILED, INFO-DENSE content — include specific names, facts, preferences, quotes
- For "Key Facts Exchanged", preserve the fan's exact phrasing for important statements
- For "Relationship Context", note emotional shifts or tone changes
- Keep each section under ~2000 tokens
- IMPORTANT: Always update "Current State" to reflect the most recent exchange

Output the complete updated markdown file now:`;
}
