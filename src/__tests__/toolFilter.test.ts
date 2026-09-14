import { refusalFor, isAllowedDespiteReadOnly, annotationsFor, presetGroups, TOOL_PRESETS } from '../lib/toolFilter';
import type { ToolProfile } from '../lib/toolFilter';
import { MUTATING_TOOLS } from '../lib/toolClasses';
import { readOnlyAllowances, includedTokens, toolProfileName } from '../lib/serverConfig';

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

describe('serving a narrowed list', () => {
  it('serves what is included and refuses the rest, saying what it does serve', () => {
    const p = profile({ included: new Set(['source', 'package']) });
    expect(refusalFor('getObjectSource', 'source', p, SYSTEM)).toBeUndefined();
    expect(refusalFor('packageTree', 'package', p, SYSTEM)).toBeUndefined();
    const refusal = refusalFor('debuggerAttach', 'debugger', p, SYSTEM);
    expect(refusal?.reason).toBe('notIncluded');
    expect(refusal?.message).toContain('package, source');
  });

  it('serves a tool named on its own, without its group', () => {
    const p = profile({ included: new Set(['impactOf']) });
    expect(refusalFor('impactOf', 'codeAnalysis', p, SYSTEM)).toBeUndefined();
    expect(refusalFor('usageReferences', 'codeAnalysis', p, SYSTEM)?.reason).toBe('notIncluded');
  });

  it('keeps healthcheck whatever the list says, and lets exclusion win over inclusion', () => {
    const p = profile({ included: new Set(['source']), excluded: new Set(['source']) });
    expect(refusalFor('healthcheck', 'health', p, SYSTEM)).toBeUndefined();
    expect(refusalFor('getObjectSource', 'source', p, SYSTEM)?.reason).toBe('excluded');
  });

  it('narrows nothing when no list was given', () => {
    expect(refusalFor('debuggerAttach', 'debugger', profile({ included: new Set() }), SYSTEM)).toBeUndefined();
  });
});

describe('presets', () => {
  it('names the groups of a known preset and nothing for an unknown one', () => {
    expect(presetGroups('read')).toContain('source');
    expect(presetGroups('READ')).toContain('source');
    expect(presetGroups('dev')).toContain('activation');
    expect(presetGroups('read')).not.toContain('debugger');
    expect(presetGroups('nope')).toEqual([]);
    expect(presetGroups('')).toEqual([]);
  });

  it('gives every preset the health group, so a narrowed server can still say what it is', () => {
    for (const groups of Object.values(TOOL_PRESETS)) expect(groups).toContain('health');
  });

  it('keeps read to tools that read: nothing in it changes the system', () => {
    // The preset is a promise about the list it serves, and MUTATING_TOOLS is
    // where that promise is kept or broken.
    const writesInRead = [...MUTATING_TOOLS].filter(tool =>
      ['runClass', 'setObjectSource', 'lock', 'activateSafe', 'setTextElements', 'createTransport']
        .includes(tool));
    expect(writesInRead.length).toBeGreaterThan(0);
    const p = profile({ readOnly: true, included: new Set(TOOL_PRESETS.read) });
    // codeAnalysis carries runClass, and textElement carries setTextElements:
    // the preset narrows the list, and SAP_READONLY is what forbids writing.
    expect(refusalFor('runClass', 'codeAnalysis', p, SYSTEM)?.reason).toBe('readOnly');
    expect(refusalFor('setTextElements', 'textElement', p, SYSTEM)?.reason).toBe('readOnly');
  });
});

describe('SAP_TOOLS_INCLUDE and SAP_TOOLS_PROFILE parsing', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('is empty unless set, and splits on commas and whitespace', () => {
    delete process.env.SAP_TOOLS_INCLUDE;
    expect(includedTokens().size).toBe(0);
    process.env.SAP_TOOLS_INCLUDE = 'source, package  impactOf';
    expect([...includedTokens()].sort()).toEqual(['impactOf', 'package', 'source']);
  });

  it('reads the preset name in any case, and empty when there is none', () => {
    delete process.env.SAP_TOOLS_PROFILE;
    expect(toolProfileName()).toBe('');
    process.env.SAP_TOOLS_PROFILE = ' Read ';
    expect(toolProfileName()).toBe('read');
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
