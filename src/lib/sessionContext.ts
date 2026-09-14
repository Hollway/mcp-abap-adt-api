/**
 * Whose session the code currently running belongs to.
 *
 * Three things in this server are state rather than logic: the locks held,
 * the source cache, and the request counters. Over stdio they can be
 * module-level singletons, because a process serves one person against one
 * SAP session. Over HTTP that assumption inverts - one process serves
 * everybody - and a singleton stops being a convenience and becomes a leak
 * between users: unlockAll would release somebody else's locks, and a cached
 * source would be handed to a user SAP would not have shown it to.
 *
 * The alternative was to thread a context object through every handler and
 * every call site - some sixty of them, plus the tests that construct
 * handlers directly. AsyncLocalStorage keeps the existing call signatures and
 * pays for it with one rule: everything serving a request must run inside
 * runInSession. Outside it - stdio, unit tests - there is one fallback state,
 * which is exactly the singleton behaviour that was there before.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createLockRegistry } from './lockRegistry';
import type { LockRegistry } from './lockRegistry';
import { createSourceCache } from './sourceCache';
import type { SourceCache } from './sourceCache';
import { createMetrics } from './metrics';
import type { MetricsRegistry } from './metrics';

export interface SessionState {
  /** Locks held by this ADT session; the handles die with it. */
  locks: LockRegistry;
  /** Source read or written through this session. */
  sources: SourceCache;
  /** What this session has asked SAP to do. */
  metrics: MetricsRegistry;
  /**
   * A re-login in progress on this session.
   *
   * It used to be a field on the server object, which worked while the server
   * outlived the requests. Over HTTP a server is built per request, so the
   * guard against several parallel re-logins has to live with the session it
   * is guarding.
   */
  relogin?: Promise<void>;
  /**
   * Who this session belongs to and since when, when it came from the pool.
   *
   * Absent over stdio, where the answer is "the one person who started the
   * process". healthcheck reports it so a caller over HTTP can tell whose
   * session answered them - with several people on one server, "which
   * session am I on" stops being a rhetorical question.
   */
  owner?: { user: string; since: string };
}

export const createSessionState = (): SessionState => ({
  locks: createLockRegistry(),
  sources: createSourceCache(),
  metrics: createMetrics()
});

const storage = new AsyncLocalStorage<SessionState>();

/**
 * The state used when nothing established a session: the stdio server, unit
 * tests, and anything else running outside a request.
 *
 * Built on first use rather than at import time, because this module and the
 * three it draws its factories from refer to each other - a value created
 * while the cycle is still resolving would be undefined.
 */
let fallback: SessionState | undefined;

export const currentSession = (): SessionState => storage.getStore() ?? (fallback ??= createSessionState());

/** True while a request has established its own session state. */
export const hasSession = (): boolean => storage.getStore() !== undefined;

/** Run everything this request does against one session state. */
export const runInSession = <T>(state: SessionState, work: () => T): T => storage.run(state, work);

/**
 * Drop the fallback state. Only for tests that need to prove one session
 * cannot see another one; the running server never calls it.
 */
export const resetFallbackSession = (): void => {
  fallback = undefined;
};
