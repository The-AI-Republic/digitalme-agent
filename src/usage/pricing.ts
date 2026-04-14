/**
 * Model pricing registry for cost estimation.
 *
 * Prices are USD per 1 million tokens. Maintained manually — update when
 * providers change their pricing.
 */

export interface ModelPricing {
  provider: string;
  model: string;
  inputTokenCostPer1M: number;
  outputTokenCostPer1M: number;
  cacheReadCostPer1M?: number;
  cacheWriteCostPer1M?: number;
}

const PRICING_TABLE: ModelPricing[] = [
  // Anthropic
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokenCostPer1M: 3.0, outputTokenCostPer1M: 15.0, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  { provider: 'anthropic', model: 'claude-sonnet-4-5-20250514', inputTokenCostPer1M: 3.0, outputTokenCostPer1M: 15.0, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokenCostPer1M: 0.8, outputTokenCostPer1M: 4.0, cacheReadCostPer1M: 0.08, cacheWriteCostPer1M: 1.0 },
  { provider: 'anthropic', model: 'claude-opus-4-6', inputTokenCostPer1M: 15.0, outputTokenCostPer1M: 75.0, cacheReadCostPer1M: 1.5, cacheWriteCostPer1M: 18.75 },

  // OpenAI
  { provider: 'openai', model: 'gpt-4o', inputTokenCostPer1M: 2.5, outputTokenCostPer1M: 10.0 },
  { provider: 'openai', model: 'gpt-4o-mini', inputTokenCostPer1M: 0.15, outputTokenCostPer1M: 0.6 },
  { provider: 'openai', model: 'gpt-4.1', inputTokenCostPer1M: 2.0, outputTokenCostPer1M: 8.0 },
  { provider: 'openai', model: 'gpt-4.1-mini', inputTokenCostPer1M: 0.4, outputTokenCostPer1M: 1.6 },
  { provider: 'openai', model: 'gpt-4.1-nano', inputTokenCostPer1M: 0.1, outputTokenCostPer1M: 0.4 },

  // xAI
  { provider: 'xai', model: 'grok-3', inputTokenCostPer1M: 3.0, outputTokenCostPer1M: 15.0 },
  { provider: 'xai', model: 'grok-3-mini', inputTokenCostPer1M: 0.3, outputTokenCostPer1M: 0.5 },

  // Google AI Studio
  { provider: 'google-ai-studio', model: 'gemini-2.5-pro', inputTokenCostPer1M: 1.25, outputTokenCostPer1M: 10.0 },
  { provider: 'google-ai-studio', model: 'gemini-2.5-flash', inputTokenCostPer1M: 0.15, outputTokenCostPer1M: 0.6 },
  { provider: 'google-ai-studio', model: 'gemini-2.0-flash', inputTokenCostPer1M: 0.1, outputTokenCostPer1M: 0.4 },

  // Groq
  { provider: 'groq', model: 'llama-3.3-70b-versatile', inputTokenCostPer1M: 0.59, outputTokenCostPer1M: 0.79 },
  { provider: 'groq', model: 'llama-3.1-8b-instant', inputTokenCostPer1M: 0.05, outputTokenCostPer1M: 0.08 },
];

function createPricingIndex(entries: readonly ModelPricing[]): Map<string, ModelPricing> {
  const index = new Map<string, ModelPricing>();
  for (const entry of entries) {
    index.set(`${entry.provider}:${entry.model}`, entry);
  }
  return index;
}

/** Index for fast lookups. Key = "provider:model" */
let pricingIndex = createPricingIndex(PRICING_TABLE);

/** Default pricing used when a model is not in the registry. Conservative estimate. */
const DEFAULT_PRICING: ModelPricing = {
  provider: 'unknown',
  model: 'unknown',
  inputTokenCostPer1M: 3.0,
  outputTokenCostPer1M: 15.0,
};

/**
 * Look up pricing for a specific provider+model combination.
 * Falls back to DEFAULT_PRICING if the model is not in the registry.
 */
export function getModelPricing(provider: string, model: string): ModelPricing {
  return pricingIndex.get(`${provider}:${model}`) ?? DEFAULT_PRICING;
}

/**
 * Compute estimated cost in USD for a model API call.
 */
export function getCostEstimate(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const pricing = getModelPricing(provider, model);
  let cost = 0;

  cost += (inputTokens / 1_000_000) * pricing.inputTokenCostPer1M;
  cost += (outputTokens / 1_000_000) * pricing.outputTokenCostPer1M;

  if (cacheReadTokens > 0 && pricing.cacheReadCostPer1M != null) {
    cost += (cacheReadTokens / 1_000_000) * pricing.cacheReadCostPer1M;
  }
  if (cacheWriteTokens > 0 && pricing.cacheWriteCostPer1M != null) {
    cost += (cacheWriteTokens / 1_000_000) * pricing.cacheWriteCostPer1M;
  }

  return cost;
}

/**
 * Register custom pricing at runtime (e.g. for self-hosted or new models).
 */
export function registerPricing(pricing: ModelPricing): void {
  pricingIndex.set(`${pricing.provider}:${pricing.model}`, pricing);
}

/**
 * Reset the pricing registry to the built-in defaults.
 * Intended for tests that override model pricing.
 */
export function resetPricing(): void {
  pricingIndex = createPricingIndex(PRICING_TABLE);
}

/**
 * List all registered model pricings.
 */
export function listPricings(): readonly ModelPricing[] {
  return [...pricingIndex.values()];
}
