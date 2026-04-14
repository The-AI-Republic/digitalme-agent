export interface GuardrailPattern {
  name: string;
  regex: RegExp;
  category: 'jailbreak' | 'pii' | 'external_link';
}

export const JAILBREAK_PATTERNS: readonly GuardrailPattern[] = [
  {
    name: 'instruction_override',
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|guidelines)/i,
    category: 'jailbreak',
  },
  {
    name: 'role_play_pretend',
    regex: /pretend\s+(you\s+are|to\s+be|you're)\s+/i,
    category: 'jailbreak',
  },
  {
    name: 'role_reassignment',
    regex: /you\s+are\s+now\s+(an?\s+)?(different|unrestricted|uncensored|jailbroken|unfiltered|rogue|evil)\b/i,
    category: 'jailbreak',
  },
  {
    name: 'dan_mode',
    regex: /\bDAN\b/i,
    category: 'jailbreak',
  },
  {
    name: 'developer_mode',
    regex: /developer\s+mode/i,
    category: 'jailbreak',
  },
  {
    name: 'bypass_safety',
    regex: /bypass\s+(safety|content|filter)/i,
    category: 'jailbreak',
  },
  {
    name: 'no_restrictions',
    regex: /act\s+as\s+(if|though)\s+you\s+(have\s+)?no\s+(restrictions|limits|rules)/i,
    category: 'jailbreak',
  },
];

export const PII_PATTERNS: readonly GuardrailPattern[] = [
  {
    name: 'email',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    category: 'pii',
  },
  {
    name: 'us_phone',
    regex: /(?:^|\D)(?:\+?1[-.\s])?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}(?!\d)/,
    category: 'pii',
  },
  {
    name: 'ssn',
    regex: /\b\d{3}[-.]\d{2}[-.]\d{4}\b/,
    category: 'pii',
  },
  {
    name: 'credit_card',
    regex: /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/,
    category: 'pii',
  },
];

export const EXTERNAL_LINK_PATTERN: GuardrailPattern = {
  name: 'external_link',
  regex: /https?:\/\/[^\s]+/i,
  category: 'external_link',
};
