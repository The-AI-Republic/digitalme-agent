import type { Message, ModelClient } from '../../models/ModelClient.js';
import type { ConversationSummary } from './types.js';

const BYTES_PER_TOKEN = 4;

const SUMMARY_PROMPT = `You are a conversation summarizer. Your task is to create a detailed summary of the conversation so far, which will replace the older messages to free up context space. The summary must preserve all information needed to continue the conversation naturally.

IMPORTANT: You must respond with TEXT ONLY. Do NOT use any tools. Do NOT attempt to call any functions. Simply analyze the conversation and provide your response as plain text.

First, analyze the conversation chronologically in <analysis> tags. Be thorough — go through the conversation turn by turn. Identify: who said what, what topics were discussed, what emotions were expressed, what commitments were made, and what questions remain open.

Then, provide your summary in <summary> tags with the following sections:

1. **Conversation Context**: What brought the fan here? What is the overall nature of this conversation?
2. **Fan Profile**: Everything learned about the fan — name, preferences, interests, communication style.
3. **Relationship & Tone**: The emotional tenor. Familiarity level, humor style, any inside references.
4. **Key Facts Exchanged**: Specific information shared by either side. Preserve the fan's exact phrasing for significant statements.
5. **Agent Commitments**: Promises, follow-ups, or offers the agent made.
6. **Open Topics**: Unresolved questions, ongoing discussion threads.
7. **All Fan Messages**: Brief summary of every fan message in order — do not skip any.
8. **Current State**: What was happening at the end of the conversation?

IMPORTANT:
- Do NOT omit any user messages from your summary
- Preserve specific details (names, numbers, dates, preferences)
- The summary should enable the agent to continue the conversation naturally
- Keep the summary concise but complete

REMEMBER: Respond with text only. No tool calls.`;

export class ConversationSummaryBuilder {
  constructor(private readonly modelClient: ModelClient) {}

  async summarize(messages: Message[], cutoffIndex: number): Promise<ConversationSummary> {
    const toSummarize = messages.slice(0, cutoffIndex);

    const summaryMessages: Message[] = [
      ...toSummarize,
      { role: 'user', content: SUMMARY_PROMPT },
    ];

    const result = await this.modelClient.generate({
      model: '', // Uses whatever model the client is configured with
      messages: summaryMessages,
    });

    const rawText = result.type === 'final_text' ? (result.text ?? '') : '';
    const summaryText = this.extractSummary(rawText);

    return {
      text: summaryText,
      coversMessageCount: cutoffIndex,
      generatedAt: Date.now(),
      estimatedTokens: Math.ceil(summaryText.length / BYTES_PER_TOKEN),
    };
  }

  private extractSummary(raw: string): string {
    // Strip <analysis> block if present
    const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();

    // Extract <summary> content if present
    const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch) {
      return summaryMatch[1].trim();
    }

    // If no tags, use the full text (model might not have followed format exactly)
    return withoutAnalysis || raw;
  }
}
