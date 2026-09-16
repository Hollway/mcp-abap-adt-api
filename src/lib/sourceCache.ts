/**
 * In-memory cache of ABAP object source, keyed by object source URL.
 *
 * It remembers the source last read (getObjectSource) or written
 * (setObjectSource) so syntaxCheckCode can reuse it instead of forcing the
 * model to re-send the whole file on every check (issue #2).
 *
 * One cache belongs to one session. Sharing it across users would be a small
 * saving and a real hazard: two people do not have the same authorisations,
 * and a cached read would hand one of them source the backend would have
 * refused to show them. The module-level `sourceCache` therefore resolves to
 * the cache of whichever session is running - see lib/sessionContext.
 */
import { currentSession } from './sessionContext';

export interface SourceCache {
  set(url: string, source: string): void;
  get(url: string): string | undefined;
  has(url: string): boolean;
  delete(url: string): void;
  forgetUnder(objectUrl: string): number;
  /** How many entries are held - what dropSession reports having forgotten. */
  count(): number;
  clear(): void;
}

/**
 * Cache key for one object version. The working version (ADT's default, i.e.
 * `inactive`) keeps the plain URL as its key, so a syntax check still finds the
 * code being edited; an explicitly requested `active` read is stored separately
 * and cannot shadow it.
 */
export const sourceCacheKey = (url: string, version?: string): string =>
  version && version !== 'inactive' ? `${url}?version=${version}` : url;

export function createSourceCache(): SourceCache {
  const cache = new Map<string, string>();

  return {
    set(url: string, source: string): void {
      if (typeof url === 'string' && url.length > 0 && typeof source === 'string') {
        cache.set(url, source);
      }
    },
    get(url: string): string | undefined {
      return cache.get(url);
    },
    has(url: string): boolean {
      return cache.has(url);
    },
    delete(url: string): void {
      cache.delete(url);
    },
    /**
     * Forget everything cached for one object: its main source, the versions
     * stored under their own keys, and the includes of a class, which hang below
     * the class URL. Answers how many entries went.
     *
     * Deleting an object is the one event that makes the cache lie rather than
     * just go stale - a later syntaxCheckCode would happily check the text of an
     * object that is no longer there, and report it as fine.
     */
    forgetUnder(objectUrl: string): number {
      if (typeof objectUrl !== 'string' || objectUrl.length === 0) return 0;
      const prefix = objectUrl.replace(/\/+$/, '');
      let dropped = 0;
      for (const key of [...cache.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`)) {
          cache.delete(key);
          dropped++;
        }
      }
      return dropped;
    },
    count(): number {
      return cache.size;
    },
    clear(): void {
      cache.clear();
    }
  };
}

/** The cache of the session currently running. */
export const sourceCache: SourceCache = {
  set: (url, source) => currentSession().sources.set(url, source),
  get: url => currentSession().sources.get(url),
  has: url => currentSession().sources.has(url),
  delete: url => currentSession().sources.delete(url),
  forgetUnder: objectUrl => currentSession().sources.forgetUnder(objectUrl),
  count: () => currentSession().sources.count(),
  clear: () => currentSession().sources.clear()
};
