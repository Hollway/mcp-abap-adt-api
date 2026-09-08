import { isReadOnly, excludedTokens, logLevel, maxResponseChars } from '../lib/serverConfig';
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
