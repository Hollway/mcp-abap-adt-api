/**
 * Locks a session currently holds.
 *
 * ADT locks are invisible from the outside: nothing in the tool surface used to
 * say which objects were locked, so a lock taken for an edit that then went a
 * different way stayed on the object until the session died. Recording them
 * here makes them listable, releasable in one call, and released on shutdown.
 *
 * One registry belongs to one ADT session, because a lock handle does: it is
 * void the moment that session ends. Over stdio there is exactly one session
 * and the module-level `lockRegistry` is it. Over HTTP there is one per pooled
 * user, and the pool hands each session its own - which is also what lets the
 * pool answer "does closing this session drop a lock somebody is still using".
 */
import { currentSession } from './sessionContext';

export interface HeldLock {
  objectUrl: string;
  lockHandle: string;
  accessMode?: string;
  since: string;
}

export interface LockRegistry {
  remember(objectUrl: string, lockHandle: string, accessMode?: string): void;
  forget(objectUrl: string): void;
  get(objectUrl: string): HeldLock | undefined;
  forUrl(objectUrl: string): HeldLock | undefined;
  all(): HeldLock[];
  count(): number;
  clear(): void;
}

export function createLockRegistry(): LockRegistry {
  const locks = new Map<string, HeldLock>();

  return {
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
}

/** The registry of the session currently running - see lib/sessionContext. */
export const lockRegistry: LockRegistry = {
  remember: (objectUrl, lockHandle, accessMode) =>
    currentSession().locks.remember(objectUrl, lockHandle, accessMode),
  forget: objectUrl => currentSession().locks.forget(objectUrl),
  get: objectUrl => currentSession().locks.get(objectUrl),
  forUrl: objectUrl => currentSession().locks.forUrl(objectUrl),
  all: () => currentSession().locks.all(),
  count: () => currentSession().locks.count(),
  clear: () => currentSession().locks.clear()
};
