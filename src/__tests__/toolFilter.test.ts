import { refusalFor, isAllowedDespiteReadOnly, annotationsFor } from '../lib/toolFilter';
import type { ToolProfile } from '../lib/toolFilter';
import { readOnlyAllowances } from '../lib/serverConfig';

const profile = (over: Partial<ToolProfile> = {}): ToolProfile => ({
  readOnly: false,
  excluded: new Set<string>(),
  allowed: new Set<string>(),
  ...over
});

const SYSTEM = 'https://sap.example/QAS';

describe('open profile', () => {
  it('refuses nothing', () => {
    expect(refusalFor('setObjectSource', 'source', profile(), SYSTEM)).toBeUndefined();
    expect(refusalFor('getObjectSource', 'source', profile(), SYSTEM)).toBeUndefined();
  });
});

describe('read-only', () => {
  const p = profile({ readOnly: true });

  it('refuses a mutating tool and names the system', () => {
    const refusal = refusalFor('lock', 'lock', p, SYSTEM);
    expect(refusal?.reason).toBe('readOnly');
    expect(refusal?.message).toContain(SYSTEM);
    expect(refusal?.message).toContain('Nothing was sent to SAP');
  });

  it('leaves reads alone', () => {
    expect(refusalFor('getObjectSource', 'source', p, SYSTEM)).toBeUndefined();
    expect(refusalFor('listLocks', 'lock', p, SYSTEM)).toBeUndefined();
  });
});

describe('exclusion', () => {
  it('hides a whole group', () => {
    const p = profile({ excluded: new Set(['traces']) });
    expect(refusalFor('tracesList', 'traces', p, SYSTEM)?.reason).toBe('excluded');
    expect(refusalFor('tracesList', 'traces', p, SYSTEM)?.message).toContain('group traces');
    expect(refusalFor('getObjectSource', 'source', p, SYSTEM)).toBeUndefined();
  });

  it('hides a single tool by name', () => {
    const p = profile({ excluded: new Set(['runQuery']) });
    expect(refusalFor('runQuery', 'query', p, SYSTEM)?.reason).toBe('excluded');
    expect(refusalFor('tableContents', 'query', p, SYSTEM)).toBeUndefined();
  });
});

describe('read-only allowance', () => {
  const p = profile({ readOnly: true, allowed: new Set(['debugger']) });

  it('lets the allowed group write, by group or by tool name', () => {
    for (const tool of ['debuggerAttach', 'debuggerSetBreakpoints', 'debuggerStep', 'debuggerSetVariableValue']) {
      expect(refusalFor(tool, 'debugger', p, SYSTEM)).toBeUndefined();
    }
    const byName = profile({ readOnly: true, allowed: new Set(['debuggerAttach']) });
    expect(refusalFor('debuggerAttach', 'debugger', byName, SYSTEM)).toBeUndefined();
    expect(refusalFor('debuggerStep', 'debugger', byName, SYSTEM)?.reason).toBe('readOnly');
  });

  it('keeps the fence around everything else', () => {
    for (const tool of ['setObjectSource', 'patchObjectSource', 'deleteObject', 'activateSafe', 'lock']) {
      expect(refusalFor(tool, undefined, p, SYSTEM)?.reason).toBe('readOnly');
    }
  });

  it('still calls those tools mutating, so a client keeps treating them as such', () => {
    expect(annotationsFor('debuggerAttach').readOnlyHint).toBe(false);
    expect(annotationsFor('debuggerStackTrace').readOnlyHint).toBe(true);
    expect(annotationsFor('deleteObject').destructiveHint).toBe(true);
  });

  it('lets exclusion win over an allowance', () => {
    const conflicting = profile({
      readOnly: true,
      excluded: new Set(['debugger']),
      allowed: new Set(['debugger'])
    });
    expect(isAllowedDespiteReadOnly('debuggerAttach', 'debugger', conflicting)).toBe(false);
    expect(refusalFor('debuggerAttach', 'debugger', conflicting, SYSTEM)?.reason).toBe('excluded');
  });
});

describe('SAP_READONLY_ALLOW parsing', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('is empty unless set, and splits on commas and whitespace', () => {
    delete process.env.SAP_READONLY_ALLOW;
    expect(readOnlyAllowances().size).toBe(0);
    process.env.SAP_READONLY_ALLOW = 'debugger, traces  runClass';
    expect([...readOnlyAllowances()].sort()).toEqual(['debugger', 'runClass', 'traces']);
  });
});
