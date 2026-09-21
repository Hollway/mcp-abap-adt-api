/**
 * The SAP sessions this server holds, one per user.
 *
 * Over stdio a process talks to SAP as one person and one long-lived session
 * carries every call. Over HTTP one process serves everybody, and the naive
 * translation - build an ADTClient per request - is what the version this
 * replaces did: it never logged off, so every single tool call left a session
 * behind on the backend, and a lock taken by one request was unreachable from
 * the next because its handle died with the session that took it.
 *
 * So the session, not the request, is the unit that lives here: keyed by user,
 * reused across requests, closed on a schedule, and closed properly - locks
 * first, then the stateful client, then the stateless clone reads go through,
 * which is a second session on the backend and does not end with the first.
 *
 * The pool never pings SAP to keep a session warm. A session nobody is using
 * is meant to die of its own accord, taking its locks with it; a keep-alive
 * would turn a forgotten lock into a permanent one.
 */
import { session_types } from 'abap-adt-api';
import type { ADTClient } from 'abap-adt-api';
import { createSessionState, runInSession } from './sessionContext';
import type { SessionState } from './sessionContext';
import type { BasicCredentials } from './auth';
import { passwordFingerprint } from './auth';
import { describeAdtError, isSessionFailure } from './adtError';
import { trackAdtClient } from './trackedClient';
import { sessionLink } from './sessionId';

export interface PooledSession {
  readonly key: string;
  readonly user: string;
  readonly client: ADTClient;
  /**
   * Everything this session remembers - its locks, its source cache, its
   * counters. Handlers reach it through lib/sessionContext rather than
   * through this object; it is held here so the pool can close a session
   * knowing what closing it costs.
   */
  readonly state: SessionState;
  /** SHA-256 of the password this session was opened with. */
  fingerprint: string;
  readonly createdAt: number;
  lastUsed: number;
  /**
   * When the stateful session was last used, which is not the same as when
   * the user was last seen.
   *
   * Reads travel on the stateless clone, so somebody who spends half an hour
   * reading keeps the clone alive while the stateful session holding their
   * locks sits untouched - and SAP times each session out separately. The
   * locked limit is measured from here, or it would be measuring the wrong
   * session and calling a dead one fresh.
   *
   * Kept by the client itself: the pooled client is wrapped so that every
   * call on it stamps this. Listing the tools that use it instead was the
   * first attempt and it missed three read-only ones - see lib/trackedClient.
   */
  lastStatefulUse: number;
  /** Requests currently using this session; it is never closed above zero. */
  inFlight: number;
  /** Serialises the calls that write - see runExclusive. */
  tail: Promise<unknown>;
  /**
   * Set when the session must not be handed out again.
   *
   * The logout tool ends the SAP session from inside a request, and
   * abap-adt-api cannot log the same client back in afterwards. Keeping the
   * entry would serve the next call a client that can only fail, so it is
   * marked here and closed as soon as the request holding it lets go.
   */
  retired?: CloseReason;
  /**
   * Set once the stateless clone has been reported in the log.
   *
   * The clone is a second SAP session and it appears later than the first -
   * on the first read, whenever that happens - so the line announcing the
   * session cannot name it. Without a line of its own, half of what this
   * server costs the backend would show up in a session list with nothing in
   * the log to account for it.
   */
  cloneAnnounced?: boolean;
}

/** What a session looks like from outside: no client, no credentials. */
export interface SessionSummary {
  user: string;
  ageMs: number;
  idleMs: number;
  inFlight: number;
  locks: number;
  lockedObjects: string[];
  /** Idle time of the stateful session, which is what SAP times out. */
  statefulIdleMs: number;
  /**
   * This session as SAP knows it: SECURITY_CONTEXT-LINK, the handle SM05
   * lists and `SELECT ... FROM security_context WHERE link = ...` finds.
   *
   * Here so a session on the backend can be matched to one this pool holds -
   * and, by elimination, so one that no pool claims can be recognised as
   * abandoned. Undefined for a client with no session cookie yet.
   */
  sapSessionId?: string;
  /** Same, for the stateless clone; absent while no clone has been built. */
  cloneSessionId?: string;
}

export type CloseReason =
  | 'idle'
  | 'idleWithLocks'
  | 'credentialsChanged'
  | 'requested'
  | 'shutdown';

export interface ClosedSession extends SessionSummary {
  reason: CloseReason;
  /** Locks that would not come off before the session was logged out. */
  lockErrors: { objectUrl: string; error: string }[];
  /**
   * True when SAP had already dropped the session, so its locks went with it
   * and there was nothing left to release. Not a failure: it is the normal
   * end of a session left idle past the backend timeout.
   */
  sessionAlreadyGone: boolean;
}

/**
 * Thrown when a new user asks for a session and there is no room left.
 *
 * It carries who is holding the pool rather than a bare "full", because the
 * answer to a pool full of locked sessions is a person deciding whether those
 * locks are still wanted - and they cannot decide without knowing whose they
 * are.
 */
export class PoolFullError extends Error {
  constructor(public readonly sessions: SessionSummary[], public readonly limit: number) {
    const held = sessions
      .map(s => `${s.user} (${s.locks} lock(s), idle ${Math.round(s.idleMs / 1000)}s)`)
      .join(', ');
    super(
      `No free SAP session: this server already holds ${sessions.length} of ${limit}. Held by: ${held}.`
    );
    this.name = 'PoolFullError';
  }
}

/**
 * Thrown when the session this key would reuse was just retired by a tool
 * (logout) but the request that did it has not finished releasing it yet.
 *
 * Deleting the pool entry here rather than waiting would orphan it: the
 * retiring request closes it itself once its own finally block runs, and
 * that close only finds its own session in the map if nothing has replaced
 * it in the meantime. The caller is asked to retry rather than served a
 * session torn out from under the request that is still using it.
 */
export class SessionClosingError extends Error {
  constructor(public readonly user: string) {
    super(`The previous SAP session for ${user} is still closing; try again shortly.`);
    this.name = 'SessionClosingError';
  }
}

export interface PoolOptions {
  /** Builds and logs in a client. Injected so the pool is testable offline. */
  createClient(credentials: BasicCredentials): Promise<ADTClient>;
  idleTtlMs(): number;
  lockedIdleTtlMs(): number;
  maxSessions(): number;
  now?(): number;
  log?(message: string): void;
}

/**
 * The stateless clone, if one was ever built.
 *
 * Deliberately NOT client.statelessClone: that getter creates the clone on
 * first read, so asking it during shutdown would open a fresh session purely
 * in order to close it.
 */
const existingClone = (client: ADTClient): ADTClient | undefined =>
  (client as unknown as { pClone?: ADTClient }).pClone;

/**
 * The `sap-session=...` tail of a log line, or nothing at all.
 *
 * Left out entirely when there is no id rather than printed as "unknown":
 * the only sessions worth naming are the ones SAP can also see.
 */
const sessionIdClause = (stateful?: string, clone?: string): string => {
  const parts = [
    stateful ? `sap-session=${stateful}` : undefined,
    clone ? `clone=${clone}` : undefined
  ].filter(Boolean);
  return parts.length ? ` [${parts.join(' ')}]` : '';
};

export class SessionPool {
  private readonly sessions = new Map<string, PooledSession>();
  /** In-flight creations, so two parallel first calls open one session. */
  private readonly opening = new Map<string, Promise<PooledSession>>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: PoolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message: string) => console.error(message));
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Sweep on a timer as well as on the way in.
   *
   * Sweeping only when somebody arrives would mean the last session of the
   * day is still logged on to SAP the next morning: the moment there is
   * nobody left to trigger it is exactly the moment it needs to run. The
   * handle is unref'd so this never keeps the process alive on its own.
   */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch(error => this.log(`[pool] sweep failed: ${describeAdtError(error).error}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Every session, described in a way that is safe to log or to serve. */
  describe(): SessionSummary[] {
    const now = this.now();
    return [...this.sessions.values()].map(session => this.summarise(session, now));
  }

  private summarise(session: PooledSession, now: number): SessionSummary {
    return {
      user: session.user,
      ageMs: now - session.createdAt,
      idleMs: now - session.lastUsed,
      statefulIdleMs: now - session.lastStatefulUse,
      inFlight: session.inFlight,
      locks: session.state.locks.count(),
      lockedObjects: session.state.locks.all().map(lock => lock.objectUrl),
      sapSessionId: sessionLink(session.client),
      // existingClone, not the getter: asking the getter would build a clone
      // - a second SAP session - purely in order to describe it.
      cloneSessionId: sessionLink(existingClone(session.client))
    };
  }

  /**
   * The session for this key, opening one if needed.
   *
   * Marks it in use: the caller owes a release() however the request ends, or
   * the session can never be closed again.
   */
  async acquire(key: string, credentials: BasicCredentials): Promise<PooledSession> {
    // A session under this exact key may be idle past its own TTL - close it
    // now rather than hand a caller a session the backend may already have
    // dropped. This only ever touches the one session this call is about;
    // evicting whatever else is idle is deferred to the capacity check below,
    // so a caller reusing their own session never pays for closing someone
    // else's.
    await this.evictIfStale(key);

    const existing = this.sessions.get(key);
    if (existing) {
      // A different password for the same user means the old session is not
      // the one they asked for - it may even be an account whose password was
      // just reset. Start again rather than serve the previous one.
      if (existing.fingerprint !== passwordFingerprint(credentials.password)) {
        this.log(`[pool] ${existing.user}: password changed, reopening the session`);
        await this.closeSession(existing, 'credentialsChanged');
      } else if (existing.retired) {
        // Spent, but still held by the request that spent it: refuse rather
        // than serve a client that can only fail, or delete an entry the
        // owning request still needs to find when its own finally runs.
        if (existing.inFlight > 0) {
          throw new SessionClosingError(existing.user);
        }
        this.log(`[pool] ${existing.user}: previous session was ended by a tool, opening a new one`);
        // closeSession() removes itself from the map; nothing left to delete.
        await this.closeIfRetired(existing);
      } else {
        return this.take(existing);
      }
    }

    const pending = this.opening.get(key);
    if (pending) return this.take(await pending);

    const limit = this.options.maxSessions();
    if (this.sessions.size >= limit) {
      // No room under this key's own account - now it is worth paying for a
      // full sweep, to close whatever else is idle before refusing outright.
      await this.sweep();
      if (this.sessions.size >= limit) {
        throw new PoolFullError(this.describe(), limit);
      }
    }

    const creation = this.open(key, credentials);
    this.opening.set(key, creation);
    try {
      return this.take(await creation);
    } finally {
      this.opening.delete(key);
    }
  }

  private take(session: PooledSession): PooledSession {
    session.inFlight += 1;
    session.lastUsed = this.now();
    return session;
  }

  private async open(key: string, credentials: BasicCredentials): Promise<PooledSession> {
    const raw = await this.options.createClient(credentials);
    const now = this.now();
    // Declared before the wrapper so the callback can reach it; nothing can
    // call the client before the session exists, because nothing else has it
    // yet.
    let session: PooledSession;
    const client = trackAdtClient(raw, () => {
      if (session) session.lastStatefulUse = this.now();
    });
    session = {
      key,
      user: credentials.user,
      client,
      state: createSessionState(),
      fingerprint: passwordFingerprint(credentials.password),
      createdAt: now,
      lastUsed: now,
      // The login is itself a call on the stateful session.
      lastStatefulUse: now,
      inFlight: 0,
      tail: Promise.resolve()
    };
    session.state.owner = { user: credentials.user, since: new Date(now).toISOString() };
    this.sessions.set(key, session);
    this.log(
      `[pool] ${session.user}: session opened ` +
      `(${this.sessions.size}/${this.options.maxSessions()})` +
      sessionIdClause(sessionLink(client))
    );
    return session;
  }

  /**
   * Mark a session as spent, without touching it yet.
   *
   * Used when a tool has ended the SAP session itself: the request that did
   * it is still running, so the entry cannot be torn down here, but it must
   * not be given to anybody else either.
   */
  retire(session: PooledSession, reason: CloseReason = 'requested'): void {
    session.retired = reason;
  }

  /** Close a retired session once nothing is using it any more. */
  async closeIfRetired(session: PooledSession): Promise<ClosedSession | undefined> {
    if (!session.retired || session.inFlight > 0) return undefined;
    if (this.sessions.get(session.key) !== session) return undefined;
    return this.closeSession(session, session.retired);
  }

  /** Give a session back. Never closes it - that is what the sweep decides. */
  release(session: PooledSession): void {
    session.inFlight = Math.max(0, session.inFlight - 1);
    session.lastUsed = this.now();
    this.announceClone(session);
  }

  /**
   * Say so the first time a read has built the stateless clone.
   *
   * Checked here rather than observed on the client because the pool hands
   * the clone out through a getter that must stay free of side effects: a
   * read on the clone is not use of the stateful session, and making the
   * getter report anything risks that distinction. Looking afterwards costs
   * one property read per request and cannot get it wrong.
   */
  private announceClone(session: PooledSession): void {
    if (session.cloneAnnounced) return;
    const clone = existingClone(session.client);
    if (!clone) return;
    session.cloneAnnounced = true;
    const id = sessionLink(clone);
    this.log(
      `[pool] ${session.user}: stateless clone opened` +
      (id ? ` [clone=${id}]` : '') +
      ' (reads go through it; it is a second SAP session)'
    );
  }

  /**
   * Run something with exclusive use of a session.
   *
   * One ADT session is one conversation: a CSRF token, a session cookie and a
   * lock/write/unlock order that only means anything in sequence. Clients are
   * free to fire several tool calls at once, so writes queue behind each other
   * here. Reads do not come through this - they go to the stateless clone and
   * have nothing to serialise against.
   */
  /**
   * Run something as this session: its locks, its cache, its counters.
   *
   * Everything that serves a request goes through here. Outside it the
   * handlers would reach the fallback state instead - which over HTTP means
   * every user sharing one set of locks, the failure this pool exists to
   * prevent.
   */
  run<T>(session: PooledSession, work: () => Promise<T>): Promise<T> {
    return runInSession(session.state, work);
  }

  runExclusive<T>(session: PooledSession, work: () => Promise<T>): Promise<T> {
    const result = session.tail.then(work, work);
    // Keep the chain alive after a failure, and leave no unhandled rejection
    // on the copy the next caller waits for.
    session.tail = result.catch(() => undefined);
    return result;
  }

  /**
   * Why a session would be swept, or undefined if it is still within its TTL.
   *
   * Two limits, because the two cases are not alike: a session with no locks
   * costs only itself, while closing one that holds locks takes those locks
   * away from someone who may still want them.
   */
  private staleReason(session: PooledSession): CloseReason | undefined {
    if (session.inFlight > 0) return undefined;
    const locked = session.state.locks.count() > 0;
    // A locked session is judged by its own idle time, not by when its owner
    // was last seen: reads keep the user busy on the clone while the session
    // holding the locks is what SAP is counting down.
    const idleFor = locked ? this.now() - session.lastStatefulUse : this.now() - session.lastUsed;
    const ttl = locked ? this.options.lockedIdleTtlMs() : this.options.idleTtlMs();
    return idleFor >= ttl ? (locked ? 'idleWithLocks' : 'idle') : undefined;
  }

  /**
   * Close the session under this key if it is idle past its own TTL.
   *
   * Scoped to one key rather than the whole pool: acquire() calls this on
   * every request, and a caller reusing their own session must not pay to
   * discover that some other user's session is also stale - that is what the
   * periodic sweep and the capacity-triggered one below are for.
   */
  private async evictIfStale(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    const reason = this.staleReason(session);
    if (reason) await this.closeSession(session, reason);
  }

  /** Close whatever has been idle too long. */
  async sweep(): Promise<ClosedSession[]> {
    const closed: ClosedSession[] = [];
    for (const session of [...this.sessions.values()]) {
      const reason = this.staleReason(session);
      if (reason) closed.push(await this.closeSession(session, reason));
    }
    return closed;
  }

  /** Close one session by key, if it is there and nobody is using it. */
  async close(key: string, reason: CloseReason = 'requested'): Promise<ClosedSession | undefined> {
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.inFlight > 0) {
      throw new Error(
        `The session of ${session.user} is serving ${session.inFlight} request(s) right now.`
      );
    }
    return this.closeSession(session, reason);
  }

  /** Close everything on the way out. */
  async closeAll(reason: CloseReason = 'shutdown'): Promise<ClosedSession[]> {
    const sessions = [...this.sessions.values()];
    const closed: ClosedSession[] = [];
    for (const session of sessions) closed.push(await this.closeSession(session, reason));
    return closed;
  }

  /**
   * Release the locks, then end both sessions this user costs.
   *
   * Every step is best effort and none of them may stop the next: a lock
   * whose handle SAP no longer recognises must not keep the session open, and
   * a logout that fails must not leave the clone behind.
   */
  private async closeSession(session: PooledSession, reason: CloseReason): Promise<ClosedSession> {
    const summary = this.summarise(session, this.now());
    // Out of the map first: a sweep running while this one awaits must not
    // find the same session and close it a second time.
    this.sessions.delete(session.key);

    // Read before anything is logged off: logout clears the cookie, and a
    // line saying which session was closed is worth nothing without its id.
    const ids = sessionIdClause(summary.sapSessionId, summary.cloneSessionId);

    const lockErrors: { objectUrl: string; error: string }[] = [];
    let sessionAlreadyGone = false;
    for (const lock of session.state.locks.all()) {
      try {
        session.client.stateful = session_types.stateful;
        await session.client.unLock(lock.objectUrl, lock.lockHandle);
      } catch (error) {
        // The session being gone is the expected end of an idle one, not a
        // fault: SAP dropped it on its own timeout and released its locks
        // doing so. Reporting that as a failed unlock - once per lock - would
        // fill the log with errors that describe normal housekeeping. Nothing
        // else can be released either, so stop asking.
        if (isSessionFailure(error)) {
          sessionAlreadyGone = true;
          break;
        }
        lockErrors.push({ objectUrl: lock.objectUrl, error: describeAdtError(error).error });
      }
    }
    session.state.locks.clear();

    await this.logoutQuietly(session.client, `${session.user} (stateful)`);
    const clone = existingClone(session.client);
    if (clone) await this.logoutQuietly(clone, `${session.user} (stateless clone)`);
    // A debugger costs a third session: its listener waits there so that it
    // does not hold the one above. It is reached through the state rather
    // than through lib/debugSession, because closing happens on a sweep, far
    // outside the request whose session state this is.
    const debugging = session.state.debug?.client;
    if (debugging) {
      session.state.debug = undefined;
      await this.logoutQuietly(debugging, `${session.user} (debug session)`);
    }

    if (summary.locks > 0 && sessionAlreadyGone) {
      this.log(
        `[pool] ${session.user}: SAP had already closed this session; its ` +
        `${summary.locks} lock(s) went with it: ${summary.lockedObjects.join(', ')}` +
        ids
      );
    } else if (summary.locks > 0) {
      this.log(
        `[pool] WARNING ${session.user}: session closed (${reason}) holding ` +
        `${summary.locks} lock(s): ${summary.lockedObjects.join(', ')}` +
        (lockErrors.length ? ` - ${lockErrors.length} could not be released` : '') +
        ids
      );
    } else {
      this.log(`[pool] ${session.user}: session closed (${reason})${ids}`);
    }
    return { ...summary, reason, lockErrors, sessionAlreadyGone };
  }

  private async logoutQuietly(client: ADTClient, what: string): Promise<void> {
    try {
      await client.logout();
    } catch (error) {
      this.log(`[pool] logging off ${what} failed: ${describeAdtError(error).error}`);
    }
  }
}
