import { SessionPool, PoolFullError } from '../lib/sessionPool';
import type { PoolOptions, PooledSession } from '../lib/sessionPool';
import { adtException } from 'abap-adt-api';
import type { ADTClient } from 'abap-adt-api';
import type { BasicCredentials } from '../lib/auth';

/**
 * The pool is the answer to the two failures of the HTTP version this
 * replaces: a SAP session opened per request and never logged off, and a lock
 * whose handle died with the session that took it. So what is worth testing
 * is not that a session comes back - it is that one session serves many
 * requests, that closing one really ends both sessions a user costs, and that
 * a session holding locks is treated differently from one that holds none.
 *
 * Time is injected. A test that waited fifteen real minutes for an idle
 * sweep would not be run.
 */

interface FakeClient {
  logout: jest.Mock<Promise<void>, []>;
  unLock: jest.Mock<Promise<void>, [string, string]>;
  lock: jest.Mock<Promise<unknown>, [string]>;
  baseUrl: string;
  stateful: unknown;
  pClone?: FakeClient;
  sessionID: string[];
}

// The real getter hands back the cookie already split on '=', which is why
// the fake speaks in the same shape. The value has to be real base64 of at
// least 16 bytes, because what gets logged is its tail decoded.
let cookieCounter = 0;
const fakeCookie = (n: number): string =>
  Buffer.from(`session-${String(n).padStart(3, '0')}-abcdef`).toString('base64');
const makeClient = (): FakeClient => ({
  logout: jest.fn().mockResolvedValue(undefined),
  unLock: jest.fn().mockResolvedValue(undefined),
  lock: jest.fn().mockResolvedValue({ LOCK_HANDLE: 'HANDLE' }),
  baseUrl: 'https://sap.example.test/DEV00',
  stateful: undefined,
  sessionID: ['SAP_SESSIONID_DEV_100', fakeCookie(++cookieCounter)]
});

const creds = (user: string, password = 'pw'): BasicCredentials => ({ user, password });

interface Harness {
  pool: SessionPool;
  clients: FakeClient[];
  created: BasicCredentials[];
  logs: string[];
  advance(ms: number): void;
}

const harness = (overrides: Partial<PoolOptions> = {}): Harness => {
  let clock = 1_000;
  const clients: FakeClient[] = [];
  const created: BasicCredentials[] = [];
  const logs: string[] = [];

  const pool = new SessionPool({
    createClient: async (credentials: BasicCredentials) => {
      created.push(credentials);
      const client = makeClient();
      clients.push(client);
      return client as unknown as ADTClient;
    },
    idleTtlMs: () => 900_000,
    lockedIdleTtlMs: () => 3_600_000,
    maxSessions: () => 3,
    now: () => clock,
    log: (message: string) => { logs.push(message); },
    ...overrides
  });

  return { pool, clients, created, logs, advance: (ms: number) => { clock += ms; } };
};

const acquire = async (pool: SessionPool, user: string, password = 'pw'): Promise<PooledSession> =>
  pool.acquire(`sys|100|RU|${user}`, creds(user, password));

describe('SessionPool.acquire', () => {
  it('opens one session and serves the next request from it', async () => {
    const h = harness();

    const first = await acquire(h.pool, 'JSMITH');
    h.pool.release(first);
    const second = await acquire(h.pool, 'JSMITH');

    expect(h.created).toHaveLength(1);
    expect(second).toBe(first);
    expect(h.pool.size()).toBe(1);
  });

  /**
   * The case that costs a session every time it is got wrong: a client that
   * fires several calls at once, against a pool that has nothing open yet.
   */
  it('opens one session for two requests that arrive together', async () => {
    const h = harness();

    const [a, b] = await Promise.all([
      acquire(h.pool, 'JSMITH'),
      acquire(h.pool, 'JSMITH')
    ]);

    expect(h.created).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.inFlight).toBe(2);
  });

  it('keeps two people apart', async () => {
    const h = harness();

    const mine = await acquire(h.pool, 'JSMITH');
    const theirs = await acquire(h.pool, 'SOMEONE');

    expect(mine).not.toBe(theirs);
    expect(h.pool.size()).toBe(2);
  });

  it('counts every request that is using a session', async () => {
    const h = harness();

    const session = await acquire(h.pool, 'JSMITH');
    await acquire(h.pool, 'JSMITH');
    expect(session.inFlight).toBe(2);

    h.pool.release(session);
    expect(session.inFlight).toBe(1);
    h.pool.release(session);
    expect(session.inFlight).toBe(0);
  });

  it('never lets release drive the count below zero', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');

    h.pool.release(session);
    h.pool.release(session);

    expect(session.inFlight).toBe(0);
  });

  it('starts a new session when the same user arrives with another password', async () => {
    const h = harness();

    const before = await acquire(h.pool, 'JSMITH', 'old');
    h.pool.release(before);
    const after = await acquire(h.pool, 'JSMITH', 'new');

    expect(after).not.toBe(before);
    expect(h.clients[0].logout).toHaveBeenCalled();
    expect(h.pool.size()).toBe(1);
  });
});

describe('SessionPool capacity', () => {
  it('refuses a new user rather than opening past the limit', async () => {
    const h = harness({ maxSessions: () => 2 });
    await acquire(h.pool, 'ONE');
    await acquire(h.pool, 'TWO');

    await expect(acquire(h.pool, 'THREE')).rejects.toBeInstanceOf(PoolFullError);
    expect(h.pool.size()).toBe(2);
  });

  /**
   * A pool full of locked sessions is resolved by a person deciding whether
   * those locks are still wanted, so the refusal has to say whose they are.
   */
  it('says who is holding the pool and what they have locked', async () => {
    const h = harness({ maxSessions: () => 1 });
    const held = await acquire(h.pool, 'ONE');
    held.state.locks.remember('/sap/bc/adt/oo/classes/zcl_thing', 'HANDLE');
    h.pool.release(held);

    const error = await acquire(h.pool, 'TWO').catch(e => e);

    expect(error).toBeInstanceOf(PoolFullError);
    expect(error.sessions).toHaveLength(1);
    expect(error.sessions[0]).toMatchObject({ user: 'ONE', locks: 1 });
    expect(error.message).toContain('ONE');
    expect(error.message).toContain('1 lock');
  });

  it('lets a new user in once an idle session has been swept', async () => {
    const h = harness({ maxSessions: () => 1 });
    const first = await acquire(h.pool, 'ONE');
    h.pool.release(first);
    h.advance(900_001);

    const second = await acquire(h.pool, 'TWO');

    expect(second.user).toBe('TWO');
    expect(h.clients[0].logout).toHaveBeenCalled();
  });
});

describe('SessionPool.sweep', () => {
  it('closes a session that has been idle and holds nothing', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);

    h.advance(899_999);
    expect(await h.pool.sweep()).toHaveLength(0);

    h.advance(2);
    const closed = await h.pool.sweep();
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe('idle');
    expect(h.pool.size()).toBe(0);
  });

  /**
   * The decision this whole design turns on: a lock is left alone for far
   * longer, because taking it away costs someone their edit - but not
   * forever, because it also blocks everyone else on the system.
   */
  it('leaves a locked session alone past the plain idle limit', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/sap/bc/adt/oo/classes/zcl_thing', 'HANDLE');
    h.pool.release(session);

    h.advance(900_001);
    expect(await h.pool.sweep()).toHaveLength(0);
    expect(h.pool.size()).toBe(1);

    h.advance(2_700_000);
    const closed = await h.pool.sweep();
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe('idleWithLocks');
    expect(closed[0].lockedObjects).toEqual(['/sap/bc/adt/oo/classes/zcl_thing']);
  });

  it('never closes a session while a request is still using it', async () => {
    const h = harness();
    await acquire(h.pool, 'JSMITH'); // acquired and not released

    h.advance(10_000_000);

    expect(await h.pool.sweep()).toHaveLength(0);
    expect(h.pool.size()).toBe(1);
  });

  it('warns in the log when it closes a session that was holding locks', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/sap/bc/adt/programs/programs/zprog', 'HANDLE');
    h.pool.release(session);
    h.advance(3_600_001);

    await h.pool.sweep();

    expect(h.logs.some(l => l.includes('WARNING') && l.includes('zprog'))).toBe(true);
  });
});

describe('SessionPool closing', () => {
  it('releases the locks before it logs off, so they do not depend on the timeout', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/a', 'HANDLE_A');
    session.state.locks.remember('/b', 'HANDLE_B');
    h.pool.release(session);

    await h.pool.close(session.key);

    expect(h.clients[0].unLock).toHaveBeenCalledWith('/a', 'HANDLE_A');
    expect(h.clients[0].unLock).toHaveBeenCalledWith('/b', 'HANDLE_B');
    expect(h.clients[0].logout).toHaveBeenCalled();
  });

  it('logs off anyway when a lock will not come off, and reports which', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/stale', 'DEAD_HANDLE');
    h.pool.release(session);
    h.clients[0].unLock.mockRejectedValueOnce(new Error('lock handle is not known'));

    const closed = await h.pool.close(session.key);

    expect(closed?.lockErrors).toHaveLength(1);
    expect(closed?.lockErrors[0].objectUrl).toBe('/stale');
    expect(h.clients[0].logout).toHaveBeenCalled();
    expect(h.pool.size()).toBe(0);
  });

  /**
   * Every pooled user costs two sessions on the backend, and logout on the
   * stateful client does nothing for the clone: forgetting it would leave
   * half the sessions behind - the exact bug this pool exists to avoid.
   */
  it('logs off the stateless clone as well', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    const clone = makeClient();
    h.clients[0].pClone = clone;
    h.pool.release(session);

    await h.pool.close(session.key);

    expect(clone.logout).toHaveBeenCalled();
  });

  /**
   * A session list on the backend cannot be reconciled with the log unless
   * both name the same thing, and what both can name is SECURITY_CONTEXT-LINK
   * - the tail of the cookie. The head is the secret and stays out.
   */
  it('names the SAP session when it opens one', async () => {
    const h = harness();
    await acquire(h.pool, 'JSMITH');

    const line = h.logs.find(l => l.includes('session opened'));
    const cookie = h.clients[0].sessionID[1];
    const link = Buffer.from(cookie, 'base64').subarray(-16).toString('hex').toUpperCase();
    expect(line).toContain(`sap-session=${link}`);
    // The other half of the cookie authenticates and must not be anywhere.
    const head = Buffer.from(cookie, 'base64').subarray(0, 16).toString('hex').toUpperCase();
    expect(line).not.toContain(head);
  });

  it('names the SAP session when it closes one', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);

    await h.pool.close(session.key);

    expect(h.logs.find(l => l.includes('session closed'))).toMatch(/sap-session=[0-9A-F]{32}/);
  });

  /**
   * The clone is born on the first read, long after the session was
   * announced, so without a line of its own half of what this server costs
   * the backend would appear in a session list unaccounted for.
   */
  it('reports the stateless clone once a read has built it', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.clients[0].pClone = makeClient();

    h.pool.release(session);
    const again = await acquire(h.pool, 'JSMITH');
    h.pool.release(again);

    const announcements = h.logs.filter(l => l.includes('stateless clone opened'));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatch(/clone=[0-9A-F]{32}/);
  });

  it('says nothing about a clone that does not exist', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);

    expect(h.logs.some(l => l.includes('stateless clone opened'))).toBe(false);
  });

  it('does not conjure a clone that was never built', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);

    await h.pool.close(session.key);

    expect(h.clients).toHaveLength(1);
  });

  it('keeps going when a logout fails', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);
    h.clients[0].logout.mockRejectedValueOnce(new Error('connection reset'));

    await expect(h.pool.close(session.key)).resolves.toBeDefined();
    expect(h.pool.size()).toBe(0);
  });

  it('refuses to close a session that is serving a request', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');

    await expect(h.pool.close(session.key)).rejects.toThrow(/serving 1 request/);
    expect(h.pool.size()).toBe(1);
  });

  it('answers with nothing when asked to close a session it does not have', async () => {
    const h = harness();
    expect(await h.pool.close('who|100|RU|NOBODY')).toBeUndefined();
  });

  it('closes everything on the way out', async () => {
    const h = harness();
    const one = await acquire(h.pool, 'ONE');
    const two = await acquire(h.pool, 'TWO');
    h.pool.release(one);
    h.pool.release(two);

    const closed = await h.pool.closeAll();

    expect(closed).toHaveLength(2);
    expect(closed.every(c => c.reason === 'shutdown')).toBe(true);
    expect(h.pool.size()).toBe(0);
    expect(h.clients.every(c => c.logout.mock.calls.length === 1)).toBe(true);
  });
});

describe('SessionPool.runExclusive', () => {
  it('runs one write at a time on a session', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    const order: string[] = [];

    const slow = h.pool.runExclusive(session, async () => {
      order.push('first in');
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push('first out');
    });
    const quick = h.pool.runExclusive(session, async () => { order.push('second'); });

    await Promise.all([slow, quick]);
    expect(order).toEqual(['first in', 'first out', 'second']);
  });

  it('still serves the next caller after one fails', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');

    const failed = h.pool.runExclusive(session, async () => { throw new Error('write refused'); });
    await expect(failed).rejects.toThrow('write refused');

    await expect(h.pool.runExclusive(session, async () => 'done')).resolves.toBe('done');
  });
});

describe('SessionPool.describe', () => {
  it('reports who holds what, without the client or the credentials', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/sap/bc/adt/oo/classes/zcl_thing', 'HANDLE');
    h.advance(5_000);

    const [described] = h.pool.describe();

    expect(described).toEqual({
      user: 'JSMITH',
      ageMs: 5_000,
      idleMs: 5_000,
      statefulIdleMs: 5_000,
      inFlight: 1,
      locks: 1,
      lockedObjects: ['/sap/bc/adt/oo/classes/zcl_thing'],
      // The identifying half only: /sessions is behind an admin token, but
      // a token buys the right to see who holds what - not to act as them.
      sapSessionId: expect.stringMatching(/^[0-9A-F]{32}$/),
      cloneSessionId: undefined
    });
    expect(JSON.stringify(described)).not.toContain('pw');
  });
});

describe('SessionPool background sweep', () => {
  afterEach(() => jest.useRealTimers());

  /**
   * The sweep has to run without a request to trigger it: the moment nobody
   * is left to call acquire is exactly when the last session needs closing.
   */
  it('closes an idle session with nobody around to ask for one', async () => {
    jest.useFakeTimers();
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);
    h.advance(900_001);

    h.pool.start(1_000);
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.pool.size()).toBe(0);
    h.pool.stop();
  });

  it('starts once however often it is asked, and stops cleanly', async () => {
    jest.useFakeTimers();
    const h = harness();
    const spy = jest.spyOn(global, 'setInterval');

    h.pool.start(1_000);
    h.pool.start(1_000);
    expect(spy).toHaveBeenCalledTimes(1);

    h.pool.stop();
    h.pool.stop();
    spy.mockRestore();
  });
});


describe('SessionPool and the stateful clock', () => {
  /**
   * The trap this exists for: someone who spends half an hour reading is
   * busy the whole time, but every one of those calls goes to the stateless
   * clone. The session holding their locks has been idle throughout, and SAP
   * counts down on it regardless - so measuring the locked limit by "when
   * was this user last seen" would call a dead session fresh.
   */
  it('measures a locked session by its own idle time, not by the user activity', async () => {
    const h = harness({ lockedIdleTtlMs: () => 1_680_000 });
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/zcl_thing', 'HANDLE');
    h.pool.release(session);

    // Half an hour of reading: the user keeps arriving, but nothing touches
    // the stateful client, because reads go to the clone.
    for (let minute = 0; minute < 30; minute++) {
      h.advance(60_000);
      const again = await h.pool.acquire(session.key, { user: 'JSMITH', password: 'pw' });
      h.pool.release(again);
    }

    // The session that held the lock was closed and logged off; the user kept
    // working, so the pool opened them a fresh one in its place.
    expect(h.clients[0].logout).toHaveBeenCalled();
    expect(h.created.length).toBeGreaterThan(1);
  });

  it('keeps a locked session that is still being written to', async () => {
    const h = harness({ lockedIdleTtlMs: () => 1_680_000 });
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/zcl_thing', 'HANDLE');
    h.pool.release(session);

    for (let minute = 0; minute < 30; minute++) {
      h.advance(60_000);
      const again = await h.pool.acquire(session.key, { user: 'JSMITH', password: 'pw' });
      // A real call on the stateful client, which is what keeps the session
      // alive on the backend as well.
      await again.client.lock('/zcl_thing');
      h.pool.release(again);
    }

    expect(h.pool.size()).toBe(1);
    expect(h.clients).toHaveLength(1);
  });

  it('reports both idle times', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);
    h.advance(120_000);
    await session.client.lock('/zcl_thing');
    h.advance(30_000);

    const [described] = h.pool.describe();
    expect(described.idleMs).toBe(150_000);
    expect(described.statefulIdleMs).toBe(30_000);
  });

  /**
   * Reading a property is local and reaches no backend, so it must not pass
   * for use - otherwise anything that merely inspects the client would keep
   * a dead session looking alive.
   */
  it('does not count reading a property as use', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    h.pool.release(session);
    h.advance(60_000);

    expect(session.client.baseUrl).toBe('https://sap.example.test/DEV00');

    expect(h.pool.describe()[0].statefulIdleMs).toBe(60_000);
  });
});

describe('SessionPool closing a session SAP already dropped', () => {
  /**
   * The ordinary end of an idle session: SAP timed it out, its locks went
   * with it, and the unlock this pool tries is answered by a dead session.
   * That is housekeeping, not a fault - reporting it as a failed unlock once
   * per lock would fill the log with alarms about nothing.
   */
  it('says the locks went with the session instead of reporting failures', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/a', 'HANDLE_A');
    session.state.locks.remember('/b', 'HANDLE_B');
    h.pool.release(session);
    // What a dead ADT session answers: an exception the library recognises,
    // carrying a 400 and no SAP verdict behind it.
    const dead = adtException('Session terminated', 400);
    h.clients[0].unLock.mockRejectedValue(dead);

    const closed = await h.pool.close(session.key);

    expect(closed?.sessionAlreadyGone).toBe(true);
    expect(closed?.lockErrors).toHaveLength(0);
    // It stopped asking after the first refusal rather than repeating it.
    expect(h.clients[0].unLock).toHaveBeenCalledTimes(1);
    expect(h.logs.some(l => l.includes('WARNING'))).toBe(false);
    expect(h.logs.some(l => l.includes('already closed this session'))).toBe(true);
  });

  it('still warns when a lock fails for any other reason', async () => {
    const h = harness();
    const session = await acquire(h.pool, 'JSMITH');
    session.state.locks.remember('/a', 'HANDLE_A');
    h.pool.release(session);
    h.clients[0].unLock.mockRejectedValue(new Error('object is enqueued elsewhere'));

    const closed = await h.pool.close(session.key);

    expect(closed?.sessionAlreadyGone).toBe(false);
    expect(closed?.lockErrors).toHaveLength(1);
    expect(h.logs.some(l => l.includes('WARNING'))).toBe(true);
  });
});
