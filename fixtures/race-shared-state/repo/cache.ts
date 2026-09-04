type Loader<T> = () => Promise<T>;

const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, load: Loader<T>): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;

  const value = await load();
  cache.set(key, value);
  return value;
}

export async function invalidate(key: string): Promise<void> {
  cache.delete(key);
}

export function stats(): { size: number; inflight: number } {
  return { size: cache.size, inflight: inflight.size };
}
