import { startHttpServer } from '../http';
import type { HttpServerHandle } from '../http';
import { SessionPool } from '../lib/sessionPool';
import { backendHealth } from '../lib/backendHealth';
import { adtException } from 'abap-adt-api';
import type { ADTClient } from 'abap-adt-api';

/**
 * The HTTP layer, tested against a pool that never touches SAP.
 *
 * What matters here is the contract a client sees, and most of it is about
 * refusing things properly: the previous HTTP version answered a missing
 * password with 500, capped bodies at 100 kB - which is smaller than a class
 * - and had no notion of being full. Those are the cases below. The one
 * happy path checked end to end is tools/list, because it proves the whole
 * chain works: credentials, pool, session context, MCP server, response.
 */

const SAP_URL = 'https://sap.example.test/DEV00';

const makeClient = () => ({
  logout: jest.fn().mockResolvedValue(undefined),
  lock: jest.fn().mockResolvedValue({ LOCK_HANDLE: 'HANDLE_1' }),
  unLock: jest.fn().mockResolvedValue(undefined),
  baseUrl: SAP_URL,
  client: '102',
  language: 'RU',
  username: 'TESTER',
  stateful: undefined
});

interface Fixture {
  handle: HttpServerHandle;
  url: string;
  clients: ReturnType<typeof makeClient>[];
}

const start = async (
  options: { maxSessions?: number; admin?: string; failOpen?: () => unknown } = {}
): Promise<Fixture> => {
  const clients: ReturnType<typeof makeClient>[] = [];
  const pool = new SessionPool({
    createClient: async () => {
      if (options.failOpen) throw options.failOpen();
      const client = makeClient();
      clients.push(client);
      return client as unknown as ADTClient;
    },
    idleTtlMs: () => 900_000,
    lockedIdleTtlMs: () => 1_680_000,
    maxSessions: () => options.maxSessions ?? 5,
    log: () => undefined
  });
  if (options.admin) process.env.SAP_ADMIN_TOKEN = options.admin;
  else delete process.env.SAP_ADMIN_TOKEN;

  const handle = await startHttpServer(pool);
  return { handle, url: `http://127.0.0.1:${handle.port}`, clients };
};

const basic = (user: string, password = 'pw'): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const rpc = (body: unknown, auth?: string, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(auth ? { authorization: auth } : {}),
    ...extra
  },
  body: JSON.stringify(body)
});

/** The transport answers as an SSE stream; the payload is one data: line. */
const eventData = (text: string): any => {
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return line ? JSON.parse(line.slice('data:'.length).trim()) : JSON.parse(text);
};

const savedEnv = { ...process.env };

// The server narrates what it refuses and why, which is the right thing in
// production and pure noise in a suite that refuses things on purpose.
let quiet: jest.SpyInstance;
beforeAll(() => { quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterAll(() => quiet.mockRestore());

beforeEach(() => {
  process.env.SAP_URL = SAP_URL;
  process.env.SAP_CLIENT = '102';
  process.env.SAP_LANGUAGE = 'RU';
  process.env.MCP_PORT = '0';
  process.env.MCP_HOST = '127.0.0.1';
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('authentication', () => {
  let f: Fixture;
  beforeEach(async () => { f = await start(); });
  afterEach(async () => { await f.handle.close(); });

  /**
   * 401 rather than 500, with the header that tells a client what to send:
   * answering "internal server error" to a missing password is how a caller
   * ends up retrying forever instead of adding credentials.
   */
  it('answers a missing Authorization header with 401 and how to fix it', async () => {
    const response = await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic realm=');
    expect((await response.json() as any).error.message).toMatch(/Basic/);
  });

  it('refuses a scheme that is not Basic', async () => {
    const response = await fetch(`${f.url}/mcp`, rpc({}, 'Bearer token'));
    expect(response.status).toBe(401);
  });

  it('refuses credentials it cannot decode', async () => {
    const response = await fetch(`${f.url}/mcp`, rpc({}, 'Basic not*base64'));
    expect(response.status).toBe(401);
  });

  it('opens no session for a request it refuses', async () => {
    await fetch(`${f.url}/mcp`, rpc({}, 'Bearer token'));
    expect(f.clients).toHaveLength(0);
    expect(f.handle.pool.size()).toBe(0);
  });
});

describe('routing', () => {
  let f: Fixture;
  beforeEach(async () => { f = await start(); });
  afterEach(async () => { await f.handle.close(); });

  it('allows only POST on the MCP endpoint', async () => {
    const response = await fetch(`${f.url}/mcp`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('says so plainly for an endpoint that does not exist', async () => {
    const response = await fetch(`${f.url}/nope`);
    expect(response.status).toBe(404);
  });

  it('reports health and readiness', async () => {
    expect(await (await fetch(`${f.url}/health`)).json())
      .toMatchObject({ status: 'ok', transport: 'http', system: SAP_URL });
    expect(await (await fetch(`${f.url}/ready`)).json())
      .toMatchObject({ status: 'ready', sessions: 0 });
  });

  it('reports what the process and the pool have been doing', async () => {
    const metrics = await (await fetch(`${f.url}/metrics`)).json() as any;
    expect(metrics.pool).toMatchObject({ sessions: 0, idleTtlSeconds: 900, lockedIdleTtlSeconds: 1680 });
    expect(metrics.process).toHaveProperty('requests');
  });
});

describe('request bodies', () => {
  let f: Fixture;
  beforeEach(async () => { f = await start(); });
  afterEach(async () => { await f.handle.close(); });

  it('reports a body that is not JSON as such', async () => {
    const response = await fetch(`${f.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic('TESTER') },
      body: '{ not json'
    });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe(-32700);
  });

  /**
   * Writing a class sends its whole source in one call. The default body
   * limit of the framework this used to be built on was 100 kB, which is
   * smaller than plenty of real ABAP classes.
   */
  it('accepts a body far larger than a default JSON limit', async () => {
    process.env.MCP_MAX_BODY_MB = '2';
    const big = 'x'.repeat(300 * 1024);
    const response = await fetch(`${f.url}/mcp`, rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'noSuchTool', arguments: { source: big } } },
      basic('TESTER')
    ));
    expect(response.status).not.toBe(413);
  });

  it('refuses a body past the limit instead of holding it in memory', async () => {
    process.env.MCP_MAX_BODY_MB = '1';
    const tooBig = 'x'.repeat(2 * 1024 * 1024);
    const response = await fetch(`${f.url}/mcp`, rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { source: tooBig } } },
      basic('TESTER')
    ));
    expect(response.status).toBe(413);
  });
});

describe('serving a call', () => {
  let f: Fixture;
  beforeEach(async () => { f = await start(); });
  afterEach(async () => { await f.handle.close(); });

  it('answers tools/list from a pooled session', async () => {
    const response = await fetch(`${f.url}/mcp`, rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      basic('TESTER')
    ));

    expect(response.status).toBe(200);
    const payload = eventData(await response.text());
    expect(payload.result.tools.length).toBeGreaterThan(100);
    expect(f.clients).toHaveLength(1);
  });

  /**
   * The failure this whole design exists to prevent: the version being
   * replaced built a client per request and never logged it off.
   */
  it('serves several calls from one SAP session', async () => {
    for (let i = 0; i < 4; i++) {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' }, basic('TESTER')));
    }

    expect(f.clients).toHaveLength(1);
    expect(f.handle.pool.size()).toBe(1);
  });

  it('keeps two users on two sessions', async () => {
    await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('ONE')));
    await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TWO')));

    expect(f.handle.pool.size()).toBe(2);
    expect(f.handle.pool.describe().map(s => s.user).sort()).toEqual(['ONE', 'TWO']);
  });

  it('does not log the session off when the request ends', async () => {
    await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));
    expect(f.clients[0].logout).not.toHaveBeenCalled();
  });
});

describe('the tools that end a session', () => {
  /**
   * logout ends the SAP session from inside a request, and abap-adt-api
   * cannot log the same client back in afterwards - its own tool description
   * says the process has to be restarted. Over stdio that was true and
   * survivable. Over HTTP it would leave the pool holding a client that can
   * only fail, and hand it to the next call this user makes.
   */
  it('retires the session after logout and opens a fresh one next time', async () => {
    const f = await start();
    try {
      await fetch(`${f.url}/mcp`, rpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'logout', arguments: {} } },
        basic('TESTER')
      ));

      expect(f.handle.pool.size()).toBe(0);

      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, basic('TESTER')));
      expect(f.clients).toHaveLength(2);
      expect(f.handle.pool.size()).toBe(1);
    } finally {
      await f.handle.close();
    }
  });

  /**
   * dropSession keeps the client usable but voids every lock handle it held:
   * the registry has to forget them, or a later write would be refused for a
   * lock the server only thinks it has.
   */
  it('forgets the locks after dropSession, and keeps the session', async () => {
    const f = await start();
    try {
      // Take a lock the way a client would, so it lands in the registry of
      // this session rather than in a test fixture.
      await fetch(`${f.url}/mcp`, rpc(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'lock', arguments: { objectUrl: '/sap/bc/adt/oo/classes/zcl_thing' } }
        },
        basic('TESTER')
      ));
      expect(f.clients[0].lock).toHaveBeenCalled();
      expect(f.handle.pool.describe()[0]).toMatchObject({
        user: 'TESTER',
        locks: 1,
        lockedObjects: ['/sap/bc/adt/oo/classes/zcl_thing']
      });

      await fetch(`${f.url}/mcp`, rpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dropSession', arguments: {} } },
        basic('TESTER')
      ));

      expect(f.handle.pool.size()).toBe(1);
      expect(f.handle.pool.describe()[0].locks).toBe(0);
    } finally {
      await f.handle.close();
    }
  });

  /**
   * A lock taken by one request has to be visible to the next one: over
   * stdio that was free, and in the HTTP version being replaced it was
   * impossible, because the session that held the handle died with the
   * request that took it.
   */
  it('carries a lock from one request to the next', async () => {
    const f = await start();
    try {
      await fetch(`${f.url}/mcp`, rpc(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'lock', arguments: { objectUrl: '/sap/bc/adt/oo/classes/zcl_thing' } }
        },
        basic('TESTER')
      ));

      const listed = await fetch(`${f.url}/mcp`, rpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'listLocks', arguments: {} } },
        basic('TESTER')
      ));

      const payload = eventData(await listed.text());
      const locks = JSON.parse(payload.result.content[0].text);
      expect(locks.count).toBe(1);
      expect(locks.locks[0]).toMatchObject({
        objectUrl: '/sap/bc/adt/oo/classes/zcl_thing',
        lockHandle: 'HANDLE_1'
      });
    } finally {
      await f.handle.close();
    }
  });
});

describe('capacity', () => {
  it('refuses a new user with 503 and says who is holding the pool', async () => {
    const f = await start({ maxSessions: 1 });
    try {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('FIRST')));

      const response = await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('SECOND')));

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('30');
      const payload = await response.json() as any;
      expect(payload.error.message).toContain('FIRST');
      expect(payload.error.data.sessions[0]).toMatchObject({ user: 'FIRST' });
    } finally {
      await f.handle.close();
    }
  });
});

describe('several calls at once', () => {
  /**
   * A client is free to fire a batch of calls in parallel - this one does it
   * routinely. Each of them must land on the one session that user has, not
   * open its own: getting this wrong is how a pool turns back into the
   * per-request client it replaced.
   */
  it('serves a burst from one user on a single session', async () => {
    const f = await start();
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' }, basic('TESTER')))
        )
      );

      expect(f.clients).toHaveLength(1);
      expect(f.handle.pool.size()).toBe(1);
    } finally {
      await f.handle.close();
    }
  });

  it('keeps a burst from three users on three sessions', async () => {
    const f = await start();
    try {
      await Promise.all(
        ['ONE', 'TWO', 'THREE'].flatMap(user =>
          Array.from({ length: 3 }, (_, i) =>
            fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' }, basic(user)))
          )
        )
      );

      expect(f.handle.pool.size()).toBe(3);
      expect(f.clients).toHaveLength(3);
    } finally {
      await f.handle.close();
    }
  });

  /**
   * Dialogue work processes are shared with everybody else on the system -
   * a system may have as few as sixteen - so the server refuses rather than queueing
   * without limit and holding them all.
   */
  it('refuses past the concurrency limit instead of queueing forever', async () => {
    process.env.SAP_MAX_CONCURRENT = '1';
    const f = await start();
    let release = () => undefined as void;
    const held = new Promise<void>(resolve => { release = () => resolve(); });
    const pool = f.handle.pool as any;
    const original = pool.run.bind(pool);
    pool.run = async (session: any, work: any) => { await held; return original(session, work); };

    try {
      const first = fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('ONE')));
      await new Promise(resolve => setTimeout(resolve, 50));

      const second = await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, basic('TWO')));
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('2');

      release();
      expect((await first).status).toBe(200);
    } finally {
      pool.run = original;
      await f.handle.close();
      delete process.env.SAP_MAX_CONCURRENT;
    }
  });

  /**
   * Writes on one session go one at a time: a lock, the write it guards and
   * the unlock only mean anything in that order.
   */
  it('runs two writes on one session one after the other', async () => {
    const f = await start();
    const order: string[] = [];
    const pool = f.handle.pool as any;
    const original = pool.runExclusive.bind(pool);
    pool.runExclusive = (session: any, work: any) => {
      order.push('queued');
      return original(session, work);
    };

    try {
      await Promise.all([
        fetch(`${f.url}/mcp`, rpc(
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lock', arguments: { objectUrl: '/a' } } },
          basic('TESTER')
        )),
        fetch(`${f.url}/mcp`, rpc(
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lock', arguments: { objectUrl: '/b' } } },
          basic('TESTER')
        ))
      ]);

      // Both writes went through the queue rather than straight to the client.
      expect(order).toEqual(['queued', 'queued']);
      expect(f.handle.pool.describe()[0].locks).toBe(2);
    } finally {
      pool.runExclusive = original;
      await f.handle.close();
    }
  });
});

describe('the session endpoints', () => {
  it('are shut when no admin token is configured', async () => {
    const f = await start();
    try {
      expect((await fetch(`${f.url}/sessions`)).status).toBe(404);
    } finally {
      await f.handle.close();
    }
  });

  it('refuse a wrong token', async () => {
    const f = await start({ admin: 'secret' });
    try {
      const response = await fetch(`${f.url}/sessions`, { headers: { 'x-admin-token': 'wrong' } });
      expect(response.status).toBe(403);
    } finally {
      await f.handle.close();
    }
  });

  it('list who is connected and what they have locked', async () => {
    const f = await start({ admin: 'secret' });
    try {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));
      f.handle.pool.describe(); // no side effect; just proving the shape below
      const listed = await (await fetch(`${f.url}/sessions`, { headers: { 'x-admin-token': 'secret' } })).json() as any;

      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({ user: 'TESTER', locks: 0 });
    } finally {
      await f.handle.close();
    }
  });

  it('close one session on request, and log it off', async () => {
    const f = await start({ admin: 'secret' });
    try {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));

      const response = await fetch(`${f.url}/sessions/TESTER`, {
        method: 'DELETE',
        headers: { 'x-admin-token': 'secret' }
      });

      expect(response.status).toBe(200);
      expect(f.clients[0].logout).toHaveBeenCalled();
      expect(f.handle.pool.size()).toBe(0);
    } finally {
      await f.handle.close();
    }
  });

  it('say so when there is no session for that user', async () => {
    const f = await start({ admin: 'secret' });
    try {
      const response = await fetch(`${f.url}/sessions/NOBODY`, {
        method: 'DELETE',
        headers: { 'x-admin-token': 'secret' }
      });
      expect(response.status).toBe(404);
    } finally {
      await f.handle.close();
    }
  });
});

describe('readiness and the backend signal', () => {
  beforeEach(() => backendHealth.reset());
  afterAll(() => backendHealth.reset());

  /**
   * A full pool is busy, not unfit for traffic. Failing readiness for it
   * would pull the only replica out of the load balancer and stop even the
   * 503 that names who is holding the sessions.
   */
  it('stays ready when the pool is full', async () => {
    const f = await start({ maxSessions: 1 });
    try {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('FIRST')));
      const refused = await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('SECOND')));
      expect(refused.status).toBe(503);

      const ready = await fetch(`${f.url}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ready', sessions: 1 });
    } finally {
      await f.handle.close();
    }
  });

  /**
   * SAP is a dependency every replica shares. Failing readiness on it would
   * empty the service of endpoints without helping SAP, and turn a
   * diagnosable 502 into a connection refused.
   */
  it('stays ready when SAP cannot be reached, and says so on /metrics', async () => {
    const f = await start({ failOpen: () => new Error('connect ETIMEDOUT') });
    try {
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' }, basic('TESTER')));
        expect(response.status).toBe(502);
      }

      expect((await fetch(`${f.url}/ready`)).status).toBe(200);

      const metrics = await (await fetch(`${f.url}/metrics`)).json() as any;
      expect(metrics.sap).toMatchObject({ degraded: true, consecutiveFailures: 3 });
      expect(metrics.sap.lastFailure).toContain('ETIMEDOUT');

      const health = await (await fetch(`${f.url}/health`)).json() as any;
      expect(health).toMatchObject({ status: 'ok', sapDegraded: true });
    } finally {
      await f.handle.close();
    }
  });

  it('clears the signal as soon as a call gets through', async () => {
    const f = await start();
    try {
      backendHealth.unreachable('connect ETIMEDOUT');
      backendHealth.unreachable('connect ETIMEDOUT');
      backendHealth.unreachable('connect ETIMEDOUT');
      expect(backendHealth.snapshot().degraded).toBe(true);

      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));

      const metrics = await (await fetch(`${f.url}/metrics`)).json() as any;
      expect(metrics.sap).toMatchObject({ degraded: false, consecutiveFailures: 0 });
      expect(metrics.sap.lastSuccessAt).toBeDefined();
    } finally {
      await f.handle.close();
    }
  });

  /**
   * A wrong password says nothing about the system: counting it would have
   * one person with stale credentials raise an alarm about SAP being down.
   */
  it('does not count rejected credentials as the backend being down', async () => {
    const f = await start({ failOpen: () => adtException('Unauthorized', 401) });
    try {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));
      const metrics = await (await fetch(`${f.url}/metrics`)).json() as any;
      expect(metrics.sap.consecutiveFailures).toBe(0);
    } finally {
      await f.handle.close();
    }
  });
});

describe('logging', () => {
  /**
   * A dozen people share one log and several calls run at once, so a line
   * that does not say whose it is answers nothing. Every line written while
   * serving a request carries the same id, the caller and the tool.
   */
  it('stamps every line of a request with the same id, the user and the tool', async () => {
    const lines: any[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      try { lines.push(JSON.parse(String(chunk))); } catch { /* the banner is plain text */ }
      return true;
    });
    process.env.LOG_LEVEL = 'info';
    const f = await start();
    try {
      await fetch(`${f.url}/mcp`, rpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listLocks', arguments: {} } },
        basic('TESTER')
      ));

      const served = lines.filter(l => l.message === 'served');
      expect(served).toHaveLength(1);
      expect(served[0]).toMatchObject({ user: 'TESTER', tool: 'listLocks', service: 'http' });
      expect(served[0].requestId).toMatch(/^[0-9a-f]{8}$/);
      expect(served[0].durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await f.handle.close();
      write.mockRestore();
      delete process.env.LOG_LEVEL;
    }
  });

  it('gives two requests two different ids', async () => {
    const ids = new Set<string>();
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      try {
        const line = JSON.parse(String(chunk));
        if (line.requestId) ids.add(line.requestId);
      } catch { /* not a log line */ }
      return true;
    });
    process.env.LOG_LEVEL = 'info';
    const f = await start();
    try {
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));
      await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, basic('TESTER')));
      expect(ids.size).toBe(2);
    } finally {
      await f.handle.close();
      write.mockRestore();
      delete process.env.LOG_LEVEL;
    }
  });

  it('records a refusal with its reason, and no password anywhere', async () => {
    const lines: any[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      try { lines.push(JSON.parse(String(chunk))); } catch { /* banner */ }
      return true;
    });
    const f = await start();
    try {
      await fetch(`${f.url}/mcp`, rpc({}, 'Basic bm90aGluZw=='));
      const refusal = lines.find(l => l.message === 'refused: no usable credentials');
      expect(refusal).toMatchObject({ level: 'warn', failure: 'malformed' });
      expect(JSON.stringify(lines)).not.toContain('nothing');
    } finally {
      await f.handle.close();
      write.mockRestore();
    }
  });
});

describe('shutdown', () => {
  /**
   * What a rolling update does. A server that leaves its sessions behind
   * here leaves their locks behind too, on every redeploy.
   */
  it('logs off every session on the way out', async () => {
    const f = await start();
    await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('ONE')));
    await fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TWO')));

    await f.handle.close();

    expect(f.clients).toHaveLength(2);
    expect(f.clients.every(c => c.logout.mock.calls.length === 1)).toBe(true);
    expect(f.handle.pool.size()).toBe(0);
  });

  /**
   * What a rolling update must not do: cut off a call that is halfway
   * through. The drain waits for what is in flight before the sessions go.
   */
  it('lets a request in flight finish before it closes', async () => {
    const f = await start();
    let released = () => undefined as void;
    const held = new Promise<void>(resolve => { released = () => resolve(); });

    // A call that will not return until the test lets it.
    f.clients.length = 0;
    const slowPool = f.handle.pool as any;
    const originalRun = slowPool.run.bind(slowPool);
    slowPool.run = async (session: any, work: any) => {
      await held;
      return originalRun(session, work);
    };

    const inFlight = fetch(`${f.url}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, basic('TESTER')));
    await new Promise(resolve => setTimeout(resolve, 50));

    const closing = f.handle.close(5_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    released();

    const response = await inFlight;
    expect(response.status).toBe(200);
    await closing;
    expect(f.handle.pool.size()).toBe(0);
  });

  it('stops answering once it is closed', async () => {
    const f = await start();
    const url = f.url;
    await f.handle.close();

    await expect(fetch(`${url}/health`)).rejects.toBeDefined();
  });
});
