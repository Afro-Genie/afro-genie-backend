// ---------------------------------------------------------------------------
// Request deduplication (Phase 6 / 7.2.4)
//
// Collapses concurrent identical fetch work into a single upstream call by
// sharing the in-flight promise. A stale entry that rejects or resolves is
// always evicted via `finally`, so the next call re-issues the request.
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

export const dedupFetchCount = (): number => inflight.size;

export async function dedupFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fetcher().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}