import { ClassMemberHandlers } from '../handlers/ClassMemberHandlers';
import { MUTATING_TOOLS, DESTRUCTIVE_TOOLS } from '../lib/toolClasses';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * The handler plans the edits and hands them to editObject, so what is checked
 * here is the planning and the delegation: which source it reads, which edits
 * come out, and that a class-edit refusal reaches the caller as a bad
 * parameter rather than as a backend failure.
 */
const CLASS = [
  'class ZDEV_MCP_CLS definition',
  '  public',
  '  create public .',
  '',
  '  public section.',
  '    methods RUN',
  '      returning',
  '        value(rv_ok) type abap_bool .',
  '  private section.',
  '    data mv_state type i .',
  'ENDCLASS.',
  '',
  'CLASS ZDEV_MCP_CLS IMPLEMENTATION.',
  '  METHOD run.',
  '    rv_ok = abap_true.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\r\n');

const SOURCE_URL = '/sap/bc/adt/oo/classes/zdev_mcp_cls/source/main';

/** One inactive row for the class, as the inactive list serves them. */
const INACTIVE = {
  object: {
    'adtcore:uri': '/sap/bc/adt/oo/classes/zdev_mcp_cls',
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'ZDEV_MCP_CLS',
    'adtcore:parentUri': '/sap/bc/adt/packages/%24tmp',
    user: 'TESTER',
    deleted: false
  }
};

const handlers = (over: Record<string, unknown> = {}) => {
  const calls: any[] = [];
  let inactiveReads = 0;
  const client = {
    stateful: 'stateful',
    getObjectSource: async (url: string) => {
      calls.push({ read: url });
      return CLASS;
    },
    lock: async () => {
      calls.push({ lock: true });
      return { LOCK_HANDLE: 'HANDLE' };
    },
    setObjectSource: async (url: string, source: string, lockHandle: string, transport?: string) => {
      calls.push({ write: url, transport, source });
    },
    unLock: async () => { calls.push({ unlock: true }); },
    activate: async () => {
      calls.push({ activate: true });
      return { success: true, messages: [], inactive: [] };
    },
    // Inactive before the activation, empty after it - which is the only proof
    // the activation took.
    inactiveObjects: async () => (++inactiveReads === 1 ? [INACTIVE] : []),
    findObjectPath: async () => [],
    ...over
  };
  return { handler: new ClassMemberHandlers(client as any), calls };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => lockRegistry.clear());

describe('addMethod', () => {
  it('plans both edits and reports what it added', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleAddMethod({
      className: 'zdev_mcp_cls',
      methodName: 'get_state',
      visibility: 'public',
      returning: { name: 'rv_state', type: 'i' },
      implementation: ['rv_state = mv_state.'],
      dryRun: true
    }));
    expect(calls[0]).toEqual({ read: SOURCE_URL });
    expect(result.dryRun).toBe(true);
    expect(result.member).toMatchObject({
      action: 'addMethod',
      className: 'ZDEV_MCP_CLS',
      methodName: 'GET_STATE',
      visibility: 'public'
    });
    // The declaration lands in the public section, the body before ENDCLASS.
    expect(result.patch.diff).toContain('+    METHODS get_state');
    expect(result.patch.diff).toContain('+  METHOD get_state.');
    expect(result.patch.diff).toContain('+    rv_state = mv_state.');
  });

  it('locks, writes, unlocks and activates when it is not a dry run', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleAddMethod({
      className: 'ZDEV_MCP_CLS',
      methodName: 'HELPER',
      visibility: 'private',
      transport: 'DEVK9A3XXXX'
    }));
    expect(calls.map(call => Object.keys(call)[0]))
      .toEqual(['read', 'lock', 'read', 'write', 'unlock', 'activate']);
    expect(calls.find(call => call.write)).toMatchObject({ transport: 'DEVK9A3XXXX' });
    expect(result).toMatchObject({ status: 'success', activated: true });
    const written = calls.find(call => call.write).source as string;
    expect(written).toContain('    METHODS HELPER .');
    expect(written).toContain('  METHOD helper.');
    // The new declaration is inside the private section, after its attribute.
    expect(written.indexOf('METHODS HELPER')).toBeGreaterThan(written.indexOf('mv_state'));
  });

  it('refuses a method that is already there as a bad parameter', async () => {
    const { handler } = handlers();
    await expect(handler.handleAddMethod({ className: 'ZDEV_MCP_CLS', methodName: 'run' }))
      .rejects.toThrow(/RUN is already there/);
  });

  it('insists on a class and a method name', async () => {
    const { handler } = handlers();
    await expect(handler.handleAddMethod({ methodName: 'x' })).rejects.toThrow(/Pass className/);
    await expect(handler.handleAddMethod({ className: 'x' })).rejects.toThrow(/Pass methodName/);
  });

  it('names the visibilities it accepts', async () => {
    const { handler } = handlers();
    await expect(handler.handleAddMethod({
      className: 'ZDEV_MCP_CLS', methodName: 'x', visibility: 'protected-ish'
    })).rejects.toThrow(/public, protected or private/);
  });

  it('takes its structured arguments as JSON strings too', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleAddMethod({
      className: 'ZDEV_MCP_CLS',
      methodName: 'calc',
      importing: '[{"name":"iv_a","type":"i"}]',
      implementation: '["RETURN."]',
      dryRun: true
    }));
    expect(result.patch.diff).toContain('+        !iv_a TYPE i');
  });

  it('reports a source that cannot be read as an ADT failure', async () => {
    const { handler } = handlers({
      getObjectSource: async () => { throw new Error('Resource not found'); }
    });
    await expect(handler.handleAddMethod({ className: 'ZDEV_NOPE', methodName: 'x' }))
      .rejects.toThrow(/Failed to read the source of ZDEV_NOPE/);
  });
});

describe('deleteMethod', () => {
  it('removes declaration and implementation and says what went', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleDeleteMethod({
      className: 'ZDEV_MCP_CLS', methodName: 'run'
    }));
    const written = calls.find(call => call.write).source as string;
    expect(written).not.toContain('METHODS RUN');
    expect(written).not.toContain('METHOD run.');
    expect(written).toContain('data mv_state type i .');
    expect(result.member.removed).toEqual([
      'implementation of RUN',
      'declaration of RUN'
    ]);
  });

  it('refuses a method the class does not have', async () => {
    const { handler } = handlers();
    await expect(handler.handleDeleteMethod({ className: 'ZDEV_MCP_CLS', methodName: 'nope' }))
      .rejects.toThrow(/NOPE is not declared or implemented/);
  });
});

describe('addAttribute', () => {
  it('adds a private data declaration by default', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleAddAttribute({
      className: 'ZDEV_MCP_CLS', attributeName: 'mv_count', type: 'i'
    }));
    expect((calls.find(call => call.write).source as string)).toContain('    DATA mv_count TYPE i .');
    expect(result.member).toMatchObject({ kind: 'data', visibility: 'private' });
  });

  it('adds a public constant with its value', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleAddAttribute({
      className: 'ZDEV_MCP_CLS',
      attributeName: 'co_flag',
      type: 'char1',
      value: `'X'`,
      constant: true,
      visibility: 'public'
    }));
    expect((calls.find(call => call.write).source as string))
      .toContain(`    CONSTANTS co_flag TYPE char1 VALUE 'X' .`);
    expect(result.member.kind).toBe('constant');
  });

  it('insists on a type', async () => {
    const { handler } = handlers();
    await expect(handler.handleAddAttribute({ className: 'ZDEV_MCP_CLS', attributeName: 'mv_x' }))
      .rejects.toThrow(/Pass type/);
  });
});

describe('classification', () => {
  it('counts all three as writing, and deleteMethod as destructive', () => {
    for (const tool of ['addMethod', 'deleteMethod', 'addAttribute']) {
      expect(MUTATING_TOOLS.has(tool)).toBe(true);
    }
    expect(DESTRUCTIVE_TOOLS.has('deleteMethod')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('addMethod')).toBe(false);
  });
});
