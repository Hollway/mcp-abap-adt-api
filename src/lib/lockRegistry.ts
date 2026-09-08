/**
 * Locks this process currently holds.
 *
 * ADT locks are invisible from the outside: nothing in the tool surface used to
 * say which objects were locked, so a lock taken for an edit that then went a
 * different way stayed on the object until the session died. Recording them
 * here makes them listable, releasable in one call, and released on shutdown.
 *
 * The registry is per process, like the ADT session that owns the handles.
 */
export interface HeldLock {
  objectUrl: string;
  lockHandle: string;
  accessMode?: string;
  since: string;
}

const locks = new Map<string, HeldLock>();

export const lockRegistry = {
  remember(objectUrl: string, lockHandle: string, accessMode?: string): void {
    if (!objectUrl || !lockHandle) return;
    locks.set(objectUrl, {
      objectUrl,
      lockHandle,
      accessMode,
      since: new Date().toISOString()
    });
  },

  forget(objectUrl: string): void {
    locks.delete(objectUrl);
  },

  get(objectUrl: string): HeldLock | undefined {
    return locks.get(objectUrl);
  },

  /**
   * The lock covering this URL, which is not always the lock ON this URL.
   *
   * A class include - the test classes, the local definitions - is written
   * through its own URL, but the lock belongs to the class: ADT locks the
   * object, not its parts. Rather than encoding which URL shapes nest inside
   * which, the registry answers with the longest lock it holds whose URL is a
   * prefix of the one asked about. It cannot invent a lock that was never
   * taken, and it stops a write from being refused for a lock this process is
   * demonstrably holding.
   */
  forUrl(objectUrl: string): HeldLock | undefined {
    if (!objectUrl) return undefined;
    const exact = locks.get(objectUrl);
    if (exact) return exact;
    let best: HeldLock | undefined;
    for (const lock of locks.values()) {
      if (!objectUrl.startsWith(`${lock.objectUrl}/`)) continue;
      if (!best || lock.objectUrl.length > best.objectUrl.length) best = lock;
    }
    return best;
  },

  all(): HeldLock[] {
    return [...locks.values()];
  },

  count(): number {
    return locks.size;
  },

  /**
   * Forget everything without unlocking. Used after a re-login: those handles
   * belonged to the old session and are void, so keeping them would only
   * produce confusing failures.
   */
  clear(): void {
    locks.clear();
  }
};
