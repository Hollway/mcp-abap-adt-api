/**
 * In-memory cache of ABAP object source, keyed by object source URL.
 *
 * A stdio MCP server serves a single client for the lifetime of the process,
 * so a simple module-level Map is a safe place to remember the source that was
 * last read (getObjectSource) or written (setObjectSource). This lets
 * syntaxCheckCode reuse that source instead of forcing the model to re-send the
 * whole file on every check (issue #2).
 */
const cache = new Map<string, string>();

/**
 * Cache key for one object version. The working version (ADT's default, i.e.
 * `inactive`) keeps the plain URL as its key, so a syntax check still finds the
 * code being edited; an explicitly requested `active` read is stored separately
 * and cannot shadow it.
 */
export const sourceCacheKey = (url: string, version?: string): string =>
  version && version !== 'inactive' ? `${url}?version=${version}` : url;

export const sourceCache = {
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
  clear(): void {
    cache.clear();
  }
};
