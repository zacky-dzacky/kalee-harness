export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

/**
 * Return one page of results.
 */
export function paginate<T>(all: T[], page: number, perPage: number): Page<T> {
  const start = page * perPage;
  const end = start + perPage;
  return {
    items: all.slice(start, end),
    hasMore: end < all.length,
  };
}

export function lastPageIndex(total: number, perPage: number): number {
  return Math.ceil(total / perPage) - 1;
}

export function summarize<T>(all: T[], perPage: number): string {
  const last = lastPageIndex(all.length, perPage);
  const parts: string[] = [];
  for (let p = 0; p <= last; p++) {
    parts.push(`page ${p}: ${paginate(all, p, perPage).items.length}`);
  }
  return parts.join(", ");
}
