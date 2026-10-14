import type { CacheStore } from './db';
import { normalizeRows } from './normalize';
import { readCachedWithPending, saveCached } from './localStorage';

/**
 * "Network first, device second."
 *
 * Every list screen loads through this: a successful API call refreshes the
 * cached copy; if the network is unavailable (or the request fails) the cached
 * copy is shown instead, including any drafts that have not been shared yet.
 * Only when there is no cached copy at all does the error surface.
 */
export async function cachedList<T>(store: CacheStore, loader: () => Promise<T[]>, options: { readonly key?: string } = {}): Promise<T[]> {
  try {
    const rows = await loader();
    await saveCached(store, normalizeRows(store, rows as unknown as Record<string, unknown>[]));
    return rows;
  } catch (error) {
    const cached = await readCachedWithPending<T>(store, options.key ?? 'id');
    if (cached.length > 0) return cached;
    throw error;
  }
}

/** Read-only offline view of a collection, with unsynced drafts on top. */
export async function cachedOnly<T>(store: CacheStore, options: { readonly key?: string } = {}): Promise<T[]> {
  return readCachedWithPending<T>(store, options.key ?? 'id');
}
