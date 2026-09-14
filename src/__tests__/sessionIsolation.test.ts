import { SessionPool } from '../lib/sessionPool';
import type { PooledSession } from '../lib/sessionPool';
import type { ADTClient } from 'abap-adt-api';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCache } from '../lib/sourceCache';
import { metrics, processMetrics } from '../lib/metrics';
import { currentSession, hasSession, runInSession, createSessionState } from '../lib/sessionContext';

/**
 * What one user must never see of another.
 *
 * The handlers reach their locks, their source cache and their counters
 * through module-level objects - `lockRegistry`, `sourceCache`, `metrics` -
 * and over stdio those really were one set of things per process. Over HTTP
 * they resolve per session instead, and the whole design rests on that being
 * true: if it is not, unlockAll releases somebody else's locks and a cached
 * read is handed to a user the backend would have refused.
 *
 * These tests therefore use the same module-level objects the handlers use,
 * from inside two different sessions, rather than testing the registries
 * directly - the indirection is the thing under test.
 */
const makeClient = () => ({
  logout: jest.fn().mockResolvedValue(undefined),
  unLock: jest.fn().mockResolvedValue(undefined),
  stateful: undefined
});

const pool = (): SessionPool =>
  new SessionPool({
    createClient: async () => makeClient() as unknown as ADTClient,
    idleTtlMs: () => 900_000,
    lockedIdleTtlMs: () => 3_600_000,
    maxSessions: () => 10,
    log: () => undefined
  });

const twoUsers = async (p: SessionPool): Promise<[PooledSession, PooledSession]> => [
  await p.acquire('sys|100|RU|ONE', { user: 'ONE', password: 'pw' }),
  await p.acquire('sys|100|RU|TWO', { user: 'TWO', password: 'pw' })
];

describe('locks are per session', () => {
  it('shows each user only the locks they took', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);

    await p.run(one, async () => { lockRegistry.remember('/zcl_mine', 'HANDLE_ONE'); });
    await p.run(two, async () => { lockRegistry.remember('/zcl_theirs', 'HANDLE_TWO'); });

    const seenByOne = await p.run(one, async () => lockRegistry.all().map(l => l.objectUrl));
    const seenByTwo = await p.run(two, async () => lockRegistry.all().map(l => l.objectUrl));

    expect(seenByOne).toEqual(['/zcl_mine']);
    expect(seenByTwo).toEqual(['/zcl_theirs']);
  });

  /**
   * The failure that would be worst in practice: one person cleaning up after
   * an abandoned edit and taking everyone else's locks off with it.
   */
  it('does not let unlockAll reach another user', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);
    await p.run(one, async () => { lockRegistry.remember('/zcl_mine', 'HANDLE_ONE'); });
    await p.run(two, async () => { lockRegistry.remember('/zcl_theirs', 'HANDLE_TWO'); });

    // What handleUnlockAll does to the registry once the backend has answered.
    await p.run(one, async () => { lockRegistry.clear(); });

    expect(await p.run(one, async () => lockRegistry.count())).toBe(0);
    expect(await p.run(two, async () => lockRegistry.count())).toBe(1);
  });

  it('reports the right owner when a session is closed', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);
    await p.run(one, async () => { lockRegistry.remember('/zcl_mine', 'HANDLE_ONE'); });
    p.release(one);
    p.release(two);

    const closed = await p.close(one.key);

    expect(closed).toMatchObject({ user: 'ONE', locks: 1, lockedObjects: ['/zcl_mine'] });
    expect(p.describe()).toEqual([expect.objectContaining({ user: 'TWO', locks: 0 })]);
  });
});

describe('the source cache is per session', () => {
  /**
   * Two people do not have the same authorisations, so a shared cache would
   * answer a read the backend would have refused.
   */
  it('does not serve one user source that another one read', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);
    const url = '/sap/bc/adt/oo/classes/zcl_secret/source/main';

    await p.run(one, async () => { sourceCache.set(url, 'CLASS zcl_secret DEFINITION.'); });

    expect(await p.run(one, async () => sourceCache.get(url))).toBe('CLASS zcl_secret DEFINITION.');
    expect(await p.run(two, async () => sourceCache.get(url))).toBeUndefined();
    expect(await p.run(two, async () => sourceCache.has(url))).toBe(false);
  });

  it('lets one user drop their cache without touching another', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);
    const url = '/sap/bc/adt/programs/programs/zprog/source/main';

    await p.run(one, async () => { sourceCache.set(url, 'mine'); });
    await p.run(two, async () => { sourceCache.set(url, 'theirs'); });
    await p.run(one, async () => { sourceCache.forgetUnder('/sap/bc/adt/programs/programs/zprog'); });

    expect(await p.run(one, async () => sourceCache.get(url))).toBeUndefined();
    expect(await p.run(two, async () => sourceCache.get(url))).toBe('theirs');
  });
});

describe('counters are per session and per process', () => {
  it('answers a user with their own numbers, not with everybody else traffic', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);

    await p.run(one, async () => {
      metrics.record('ObjectSourceHandlers', 100, true);
      metrics.record('ObjectSourceHandlers', 200, true);
    });
    await p.run(two, async () => { metrics.record('QueryHandlers', 50, false); });

    expect(await p.run(one, async () => metrics.snapshot())).toMatchObject({ requests: 2, failures: 0 });
    expect(await p.run(two, async () => metrics.snapshot())).toMatchObject({ requests: 1, failures: 1 });
  });

  it('still counts everything once for the process as a whole', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);
    processMetrics.reset();

    await p.run(one, async () => { metrics.record('ObjectSourceHandlers', 100, true); });
    await p.run(two, async () => { metrics.record('QueryHandlers', 50, false); });

    expect(processMetrics.snapshot()).toMatchObject({ requests: 2, successes: 1, failures: 1 });
  });

  it('leaves one user counters alone when another resets theirs', async () => {
    const p = pool();
    const [one, two] = await twoUsers(p);

    await p.run(one, async () => { metrics.record('A', 10, true); });
    await p.run(two, async () => { metrics.record('B', 10, true); });
    await p.run(one, async () => { metrics.reset(); });

    expect(await p.run(one, async () => metrics.snapshot().requests)).toBe(0);
    expect(await p.run(two, async () => metrics.snapshot().requests)).toBe(1);
  });
});

describe('sessionContext outside a request', () => {
  /**
   * stdio and the unit tests run with no session established, and must keep
   * behaving exactly as they did when these were plain module singletons.
   */
  it('falls back to one shared state, which is the stdio behaviour', () => {
    expect(hasSession()).toBe(false);
    lockRegistry.remember('/stdio', 'HANDLE');
    expect(lockRegistry.count()).toBe(1);
    lockRegistry.clear();
    expect(lockRegistry.count()).toBe(0);
  });

  it('restores the previous state once a session has finished', async () => {
    const outside = currentSession();
    const inside = createSessionState();

    await runInSession(inside, async () => {
      expect(currentSession()).toBe(inside);
      expect(hasSession()).toBe(true);
    });

    expect(currentSession()).toBe(outside);
    expect(hasSession()).toBe(false);
  });

  /**
   * The rule AsyncLocalStorage imposes in exchange for leaving every call
   * signature alone: the context has to survive an await, or a handler would
   * write its lock into one session and read it back from another.
   */
  it('keeps the session across an await', async () => {
    const p = pool();
    const [one] = await twoUsers(p);

    const seen = await p.run(one, async () => {
      lockRegistry.remember('/before', 'H1');
      await new Promise(resolve => setTimeout(resolve, 5));
      lockRegistry.remember('/after', 'H2');
      return lockRegistry.all().map(l => l.objectUrl);
    });

    expect(seen).toEqual(['/before', '/after']);
    expect(one.state.locks.count()).toBe(2);
  });
});
