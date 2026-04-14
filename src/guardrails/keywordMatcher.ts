function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesBlockedKeyword(text: string, keyword: string): boolean {
  const normalizedKeyword = keyword.trim();
  if (normalizedKeyword.length === 0) return false;

  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(normalizedKeyword)}(?=$|[^A-Za-z0-9])`, 'i');
  return pattern.test(text);
}
