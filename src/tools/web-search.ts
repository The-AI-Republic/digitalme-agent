import type { Tool, ToolContext, ToolExecutionResult } from './types.js';

const SEARCH_TIMEOUT_MS = 5000;

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
}

function flattenTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
  const output: DuckDuckGoTopic[] = [];
  for (const topic of topics) {
    if (topic.Text || topic.FirstURL) {
      output.push(topic);
      continue;
    }
    if (topic.Topics) {
      output.push(...flattenTopics(topic.Topics));
    }
  }
  return output;
}

export class WebSearchTool implements Tool {
  readonly name = 'web_search';

  readonly definition = {
    type: 'function' as const,
    function: {
      name: this.name,
      description: 'Look up factual public web snippets via DuckDuckGo Instant Answer and return a short list of results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  };

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { success: false, content: 'Search failed: query is required.' };
    }

    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '0');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    if (context.signal) {
      context.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, content: 'Search failed: request timed out.' };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, content: `Search failed: ${message}.` };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return { success: false, content: `Search failed: HTTP ${response.status}.` };
    }

    let data: {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: DuckDuckGoTopic[];
      Heading?: string;
    };
    try {
      data = await response.json() as typeof data;
    } catch {
      return { success: false, content: 'Search failed: invalid response from upstream.' };
    }

    const lines: string[] = [];
    if (data.Heading && data.AbstractText) {
      lines.push(`${data.Heading}: ${data.AbstractText}`);
      if (data.AbstractURL) {
        lines.push(`Source: ${data.AbstractURL}`);
      }
    }

    const topics = flattenTopics(data.RelatedTopics ?? []).slice(0, 5);
    for (const topic of topics) {
      if (!topic.Text) {
        continue;
      }
      lines.push(`- ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ''}`);
    }

    if (lines.length === 0) {
      lines.push('No useful public web results were found.');
    }

    return {
      success: true,
      content: lines.join('\n'),
    };
  }
}
