import { z } from 'zod';
import type { Tool, ToolContext, ToolDefinition, ToolExecutionResult, ToolMetadata } from './types.js';

const webSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
});

type WebSearchInput = z.infer<typeof webSearchInputSchema>;

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
}

interface SearchResultItem {
  text: string;
  url?: string;
}

interface WebSearchData {
  query: string;
  heading?: string;
  abstract?: string;
  abstractUrl?: string;
  results: SearchResultItem[];
  error?: string;
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

function formatResultsAsText(data: WebSearchData): string {
  const lines: string[] = [];
  if (data.heading && data.abstract) {
    lines.push(`${data.heading}: ${data.abstract}`);
    if (data.abstractUrl) {
      lines.push(`Source: ${data.abstractUrl}`);
    }
  }
  for (const item of data.results) {
    lines.push(`- ${item.text}${item.url ? ` (${item.url})` : ''}`);
  }
  if (lines.length === 0) {
    lines.push('No useful public web results were found.');
  }
  return lines.join('\n');
}

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  // Minimal Zod-to-JSON-Schema for the web search input.
  // For more complex schemas, use a library like zod-to-json-schema.
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    if (zodType instanceof z.ZodString) {
      const checks = (zodType as z.ZodString)._def.checks ?? [];
      const prop: Record<string, unknown> = { type: 'string' };
      for (const check of checks) {
        if (check.kind === 'min') prop.minLength = check.value;
        if (check.kind === 'max') prop.maxLength = check.value;
      }
      prop.description = `The ${key}.`;
      properties[key] = prop;
    }
    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

export class WebSearchTool implements Tool<WebSearchInput, WebSearchData> {
  readonly name = 'web_search';

  readonly metadata: ToolMetadata = {
    timeoutMs: 5_000,
    maxResultChars: 4_000,
    policyCategory: 'search',
  };

  readonly inputSchema = webSearchInputSchema;

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: this.name,
      description: 'Look up factual public web snippets via DuckDuckGo Instant Answer and return a short list of results.',
      parameters: zodToJsonSchema(this.inputSchema),
    },
  };

  isConcurrencySafe(_args: WebSearchInput): boolean {
    return true;
  }

  async execute(args: WebSearchInput, context: ToolContext): Promise<ToolExecutionResult<WebSearchData>> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', args.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '0');

    let response: Response;
    try {
      response = await fetch(url, {
        signal: context.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorData: WebSearchData = { query: args.query, results: [], error: message };
      return {
        success: false,
        data: errorData,
        renderForModel: () => `Search failed: ${message}.`,
      };
    }

    if (!response.ok) {
      const errorData: WebSearchData = { query: args.query, results: [], error: `HTTP ${response.status}` };
      return {
        success: false,
        data: errorData,
        renderForModel: () => `Search failed: HTTP ${response.status}.`,
      };
    }

    let rawData: {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: DuckDuckGoTopic[];
      Heading?: string;
    };
    try {
      rawData = await response.json() as typeof rawData;
    } catch {
      const errorData: WebSearchData = { query: args.query, results: [], error: 'invalid response' };
      return {
        success: false,
        data: errorData,
        renderForModel: () => 'Search failed: invalid response from upstream.',
      };
    }

    const topics = flattenTopics(rawData.RelatedTopics ?? []).slice(0, 5);
    const results: SearchResultItem[] = topics
      .filter((t) => t.Text)
      .map((t) => ({ text: t.Text!, url: t.FirstURL }));

    const searchData: WebSearchData = {
      query: args.query,
      heading: rawData.Heading,
      abstract: rawData.AbstractText,
      abstractUrl: rawData.AbstractURL,
      results,
    };

    return {
      success: true,
      data: searchData,
      renderForModel: () => formatResultsAsText(searchData),
    };
  }

  summarizeResult(args: WebSearchInput, result: ToolExecutionResult<WebSearchData>): string {
    const data = result.data;
    return result.success
      ? `web_search("${args.query}") → ${data.results.length} results`
      : `web_search("${args.query}") → failed`;
  }
}
