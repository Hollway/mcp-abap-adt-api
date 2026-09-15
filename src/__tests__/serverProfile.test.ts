import { statSync } from 'fs';
import {
  isReadOnly,
  excludedTokens,
  buildStamp,
  startedAt,
  assumedSessionTimeoutMs,
  logLevel,
  maxResponseChars,
  sessionIdleTtlMs,
  lockedSessionIdleTtlMs,
  maxSessions,
  maxConcurrentCalls
} from '../lib/serverConfig';
import {
  MUTATING_TOOLS,
  SESSION_TOOLS,
  DESTRUCTIVE_TOOLS,
  isMutatingTool,
  isDestructiveTool,
  isReplayable
} from '../lib/toolClasses';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCacheKey, sourceCache } from '../lib/sourceCache';
import { metrics } from '../lib/metrics';

describe('serverConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads SAP_READONLY lazily, so dotenv can still load it', () => {
    delete process.env.SAP_READONLY;
    expect(isReadOnly()).toBe(false);
    process.env.SAP_READONLY = '1';
    expect(isReadOnly()).toBe(true);
    process.env.SAP_READONLY = 'yes';
    expect(isReadOnly()).toBe(true);
    process.env.SAP_READONLY = '0';
    expect(isReadOnly()).toBe(false);
  });

  it('splits SAP_TOOLS_EXCLUDE on commas and whitespace', () => {
    process.env.SAP_TOOLS_EXCLUDE = 'debugger, traces  atc,git';
    expect([...excludedTokens()].sort()).toEqual(['atc', 'debugger', 'git', 'traces']);
    delete process.env.SAP_TOOLS_EXCLUDE;
    expect(excludedTokens().size).toBe(0);
  });

  it('defaults the log level to warn and rejects nonsense', () => {
    delete process.env.LOG_LEVEL;
    expect(logLevel()).toBe('warn');
    process.env.LOG_LEVEL = 'debug';
    expect(logLevel()).toBe('debug');
    process.env.LOG_LEVEL = 'chatty';
    expect(logLevel()).toBe('warn');
  });

  it('stamps the build with the time of the file it is running from', () => {
    const stamp = buildStamp();
    expect(stamp).toBe(statSync(require.resolve('../lib/serverConfig')).mtime.toISOString());
    expect(new Date(stamp as string).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reports a start time no later than now and no older than the process', () => {
    const started = new Date(startedAt()).getTime();
    expect(started).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(Math.floor(process.uptime()) * 1000 - 1000);
  });

  it('falls back to a sane response cap', () => {
    delete process.env.SAP_MAX_RESPONSE_CHARS;
    expect(maxResponseChars()).toBe(200000);
    process.env.SAP_MAX_RESPONSE_CHARS = '4000';
    expect(maxResponseChars()).toBe(4000);
    process.env.SAP_MAX_RESPONSE_CHARS = 'lots';
    expect(maxResponseChars()).toBe(200000);
  });
});

describe('tool classification', () => {
  it('treats writes, code execution and lock changes as mutating', () => {
    for (const name of ['setObjectSource', 'patchObjectSource', 'lock', 'unlockAll',
      'deleteObject', 'createObject', 'createInclude', 'activateSafe',
      'transportRelease', 'runClass', 'unitTestRun', 'pushRepo']) {
      expect(isMutatingTool(name)).toBe(true);
    }
  });

  it('treats reads as non-mutating', () => {
    for (const name of ['getObjectSource', 'searchObject', 'inactiveObjects', 'listLocks',
      'runQuery', 'userTransports', 'syntaxCheckCode', 'healthcheck']) {
      expect(isMutatingTool(name)).toBe(false);
    }
  });

  it('flags only the irreversible tools as destructive', () => {
    expect(isDestructiveTool('deleteObject')).toBe(true);
    expect(isDestructiveTool('transportDelete')).toBe(true);
    expect(isDestructiveTool('setObjectSource')).toBe(false);
    for (const name of DESTRUCTIVE_TOOLS) expect(MUTATING_TOOLS.has(name)).toBe(true);
  });

  it('never replays a write or a session tool after a re-login', () => {
    for (const name of MUTATING_TOOLS) expect(isReplayable(name)).toBe(false);
    for (const name of SESSION_TOOLS) expect(isReplayable(name)).toBe(false);
    expect(isReplayable('getObjectSource')).toBe(true);
  });
});

describe('lockRegistry', () => {
  beforeEach(() => lockRegistry.clear());

  it('remembers, forgets and counts locks', () => {
    lockRegistry.remember('/sap/bc/adt/oo/classes/zcl_a', 'H1', 'MODIFY');
    lockRegistry.remember('/sap/bc/adt/oo/classes/zcl_b', 'H2');
    expect(lockRegistry.count()).toBe(2);
    expect(lockRegistry.get('/sap/bc/adt/oo/classes/zcl_a')).toMatchObject({
      lockHandle: 'H1',
      accessMode: 'MODIFY'
    });
    lockRegistry.forget('/sap/bc/adt/oo/classes/zcl_a');
    expect(lockRegistry.count()).toBe(1);
    lockRegistry.clear();
    expect(lockRegistry.all()).toEqual([]);
  });

  it('ignores an incomplete lock', () => {
    lockRegistry.remember('', 'H1');
    lockRegistry.remember('/url', '');
    expect(lockRegistry.count()).toBe(0);
  });
});

describe('sourceCache keys', () => {
  it('keeps the working version under the plain URL', () => {
    const url = '/sap/bc/adt/oo/classes/zcl_a/source/main';
    expect(sourceCacheKey(url)).toBe(url);
    expect(sourceCacheKey(url, 'inactive')).toBe(url);
    expect(sourceCacheKey(url, 'active')).toBe(`${url}?version=active`);
  });

  it('does not let an active read shadow the code being edited', () => {
    const url = '/sap/bc/adt/oo/classes/zcl_a/source/main';
    sourceCache.clear();
    sourceCache.set(sourceCacheKey(url), 'edited');
    sourceCache.set(sourceCacheKey(url, 'active'), 'live');
    expect(sourceCache.get(url)).toBe('edited');
  });
});

describe('metrics', () => {
  it('totals per handler and overall', () => {
    metrics.reset();
    metrics.record('ObjectSourceHandlers', 100, true);
    metrics.record('ObjectSourceHandlers', 300, false);
    metrics.record('QueryHandlers', 50, true);
    const snapshot = metrics.snapshot();
    expect(snapshot).toMatchObject({ requests: 3, successes: 2, failures: 1, averageMs: 150 });
    expect(snapshot.handlers.ObjectSourceHandlers).toMatchObject({ requests: 2, averageMs: 200 });
  });
});

/**
 * The pool limits are the numbers an operator tunes per system - one may run 16
 * dialogue work processes and icm/max_conn = 100, another system will not -
 * so what matters here is that a value set in the environment is honoured and
 * that nonsense falls back to something safe rather than to zero, which would
 * close every session the moment it was opened.
 */
describe('serverConfig pool limits', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('takes the idle limits in seconds and answers in milliseconds', () => {
    delete process.env.SAP_SESSION_IDLE_TTL;
    delete process.env.SAP_SESSION_IDLE_TTL_LOCKED;
    expect(sessionIdleTtlMs()).toBe(900_000);
    expect(lockedSessionIdleTtlMs()).toBe(1_680_000);

    process.env.SAP_SESSION_IDLE_TTL = '60';
    process.env.SAP_SESSION_IDLE_TTL_LOCKED = '120';
    expect(sessionIdleTtlMs()).toBe(60_000);
    expect(lockedSessionIdleTtlMs()).toBe(120_000);
  });

  /**
   * The locked limit is only useful while it lands inside what SAP allows,
   * with room for the sweep interval on top - past that the backend closes
   * the session first and the deliberate unlock never happens.
   */
  it('leaves room between the locked limit and the backend timeout', () => {
    delete process.env.SAP_SESSION_IDLE_TTL_LOCKED;
    delete process.env.SAP_ASSUMED_SESSION_TIMEOUT;
    expect(assumedSessionTimeoutMs()).toBe(1_800_000);
    expect(lockedSessionIdleTtlMs() + 60_000).toBeLessThanOrEqual(assumedSessionTimeoutMs());

    process.env.SAP_ASSUMED_SESSION_TIMEOUT = '3600';
    expect(assumedSessionTimeoutMs()).toBe(3_600_000);
  });

  it('keeps a locked session longer than an idle one by default', () => {
    delete process.env.SAP_SESSION_IDLE_TTL;
    delete process.env.SAP_SESSION_IDLE_TTL_LOCKED;
    expect(lockedSessionIdleTtlMs()).toBeGreaterThan(sessionIdleTtlMs());
  });

  it('refuses a zero or unreadable limit instead of expiring everything at once', () => {
    process.env.SAP_SESSION_IDLE_TTL = '0';
    expect(sessionIdleTtlMs()).toBe(900_000);
    process.env.SAP_SESSION_IDLE_TTL = 'soon';
    expect(sessionIdleTtlMs()).toBe(900_000);
    process.env.SAP_SESSION_IDLE_TTL = '-30';
    expect(sessionIdleTtlMs()).toBe(900_000);
  });

  it('reads the session and concurrency caps, and defaults them below what a system can take', () => {
    delete process.env.SAP_MAX_SESSIONS;
    delete process.env.SAP_MAX_CONCURRENT;
    expect(maxSessions()).toBe(25);
    expect(maxConcurrentCalls()).toBe(8);

    process.env.SAP_MAX_SESSIONS = '10';
    process.env.SAP_MAX_CONCURRENT = '4';
    expect(maxSessions()).toBe(10);
    expect(maxConcurrentCalls()).toBe(4);

    process.env.SAP_MAX_SESSIONS = 'plenty';
    expect(maxSessions()).toBe(25);
  });
});
