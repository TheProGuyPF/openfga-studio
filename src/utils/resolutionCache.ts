import type { ResolutionMode, ResolutionNode } from './resolutionEngine';

/**
 * Short-lived cache for resolution-path results. Resolving a path issues several
 * batched checks / reads against the remote server, so toggling ACL⇄Full or
 * re-running the same check repeats that work. We cache per exact query + mode +
 * model version for a short TTL and surface a "cached" indicator so results are
 * never silently stale. A tuple written within the TTL won't be reflected until
 * the entry expires or the user hits Refresh (keyed on model id, not tuples).
 */

const TTL_MS = 300_000;

interface CacheKeyParts {
  storeId: string;
  authModelId?: string;
  user: string;
  object: string;
  relation: string;
  mode: ResolutionMode;
  context?: Record<string, string | number | boolean>;
}

interface Entry {
  tree: ResolutionNode;
  at: number;
}

const cache = new Map<string, Entry>();

export function resolutionCacheKey(parts: CacheKeyParts): string {
  return [
    parts.storeId,
    parts.authModelId ?? '',
    parts.user,
    parts.object,
    parts.relation,
    parts.mode,
    parts.context ? JSON.stringify(parts.context) : '',
  ].join('|');
}

export function getCachedResolution(key: string): { tree: ResolutionNode; ageMs: number } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.at;
  if (ageMs > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { tree: entry.tree, ageMs };
}

export function setCachedResolution(key: string, tree: ResolutionNode): void {
  cache.set(key, { tree, at: Date.now() });
}

/** Clear all cached resolutions (e.g. on store/env change). */
export function clearResolutionCache(): void {
  cache.clear();
}

export const RESOLUTION_CACHE_TTL_MS = TTL_MS;
