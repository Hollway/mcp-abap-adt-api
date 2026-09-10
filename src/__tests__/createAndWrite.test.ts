import { ObjectRegistrationHandlers } from '../handlers/ObjectRegistrationHandlers';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * createAndWrite is create + write + activate as one operation. What these
 * tests hold in place: the order, the source URL derived per object type, the
 * refusal to create outside $TMP without a transport, and that a failure after
 * the creation reports the empty object rather than pretending it is not there.
 */
const CLASS_SOURCE = [
  'CLASS zcl_mcp_test DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS run.',
  'ENDCLASS.',
  '',
  'CLASS zcl_mcp_test IMPLEMENTATION.',
  '  METHOD run.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

const handler = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const created: any[] = [];
  const writes: any[] = [];
  let activations = 0;
  const client = {
    stateful: 'stateless',
    username: 'TESTER',
    language: 'EN',
    validateNewObject: async () => { calls.push('validate'); return { success: true }; },
    createObject: async (options: any) => { calls.push('create'); created.push(options); },
    lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; },
    setObjectSource: async (url: string, source: string) => {
      calls.push('write');
      writes.push({ url, source });
    },
    unLock: async () => { calls.push('unlock'); },
    inactiveObjects: async () => {
      calls.push('inactiveObjects');
      return activations === 0
        ? [{
          object: {
            'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_mcp_test',
            'adtcore:type': 'CLAS/OC',
            'adtcore:name': 'ZCL_MCP_TEST',
            'adtcore:parentUri': '/sap/bc/adt/packages/%24tmp',
            user: 'TESTER',
            deleted: false
          }
        }]
        : [];
    },
    activate: async () => { calls.push('activate'); activations += 1; return { success: true, messages: [], inactive: [] }; },
    httpClient: {
      request: async () => { calls.push('createIncludePost'); return { body: '' }; }
    },
    ...over
  };
  return { handlers: new ObjectRegistrationHandlers(client as any), calls, created, writes };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

const CLASS_ARGS = {
  objtype: 'CLAS/OC',
  name: 'ZCL_MCP_TEST',
  description: 'Test',
  packageName: '$TMP',
  source: CLASS_SOURCE
};

beforeEach(() => lockRegistry.clear());

describe('createAndWrite', () => {
  it('validates, creates, locks, writes, unlocks and only then activates', async () => {
    const { handlers, calls, writes } = handler();
    const result = answer(await handlers.handleCreateAndWrite(CLASS_ARGS));

    expect(calls).toEqual([
      'validate', 'create', 'lock', 'write', 'unlock',
      'inactiveObjects', 'activate', 'inactiveObjects'
    ]);
    expect(result).toMatchObject({
      status: 'success',
      created: true,
      written: true,
      activated: true,
      objectUrl: '/sap/bc/adt/oo/classes/zcl_mcp_test',
      sourceUrl: '/sap/bc/adt/oo/classes/zcl_mcp_test/source/main'
    });
    expect(writes[0].url).toBe('/sap/bc/adt/oo/classes/zcl_mcp_test/source/main');
    expect(writes[0].source).toBe(CLASS_SOURCE);
    expect(lockRegistry.count()).toBe(0);
  });

  it('creates in the logon language rather than the library default of EN', async () => {
    const { handlers, created } = handler({ language: 'RU' });
    await handlers.handleCreateAndWrite(CLASS_ARGS);
    expect(created[0]).toMatchObject({
      objtype: 'CLAS/OC',
      name: 'ZCL_MCP_TEST',
      language: 'RU',
      masterLanguage: 'RU'
    });
  });

  it('derives the source URL per object type', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ objtype: 'PROG/P', name: 'ZR_MCP_TEST' }, '/sap/bc/adt/programs/programs/zr_mcp_test/source/main'],
      [{ objtype: 'INTF/OI', name: 'ZIF_MCP_TEST' }, '/sap/bc/adt/oo/interfaces/zif_mcp_test/source/main'],
      [{ objtype: 'FUGR/F', name: 'ZFG_MCP' }, '/sap/bc/adt/functions/groups/zfg_mcp/source/main'],
      [
        { objtype: 'FUGR/FF', name: 'Z_MCP_FM', functionGroup: 'ZFG_MCP' },
        '/sap/bc/adt/functions/groups/zfg_mcp/fmodules/z_mcp_fm/source/main'
      ]
    ];
    for (const [over, url] of cases) {
      const { handlers, writes } = handler();
      await handlers.handleCreateAndWrite({ ...CLASS_ARGS, ...over });
      expect(writes[0].url).toBe(url);
    }
  });

  it('creates a report include the way createInclude does, not with createObject', async () => {
    const { handlers, calls, writes } = handler();
    const result = answer(await handlers.handleCreateAndWrite({
      ...CLASS_ARGS,
      objtype: 'PROG/I',
      name: 'ZR_MCP_TEST_F01',
      mainProgram: 'ZR_MCP_TEST',
      source: '*&---'
    }));
    expect(calls).toContain('createIncludePost');
    expect(calls).not.toContain('create');
    expect(writes[0].url).toBe('/sap/bc/adt/programs/includes/zr_mcp_test_f01/source/main');
    expect(result).toMatchObject({ status: 'success', activated: true });
  });

  it('refuses an include with no main program, and a type it cannot place', async () => {
    const { handlers, calls } = handler();
    await expect(handlers.handleCreateAndWrite({ ...CLASS_ARGS, objtype: 'PROG/I', name: 'ZR_X_F01' }))
      .rejects.toThrow(/needs mainProgram/);
    await expect(handlers.handleCreateAndWrite({ ...CLASS_ARGS, objtype: 'ENQU/DL' }))
      .rejects.toThrow(/does not know where the source/);
    // A transparent table is refused for its own reason: the collection the
    // library would post to does not exist on a classic ERP system.
    await expect(handlers.handleCreateAndWrite({ ...CLASS_ARGS, objtype: 'TABL/DT' }))
      .rejects.toThrow(/no ddic\/tables collection/);
    expect(calls).toEqual([]);
  });

  it('refuses a package other than $TMP without a transport, before creating anything', async () => {
    const { handlers, calls } = handler();
    await expect(handlers.handleCreateAndWrite({ ...CLASS_ARGS, packageName: 'ZAPP_BASE' }))
      .rejects.toThrow(/needs a transport request/);
    expect(calls).toEqual([]);
  });

  it('reports the empty object when the source cannot be written', async () => {
    const { handlers, calls } = handler({
      setObjectSource: async () => { throw new Error('syntax error in source'); }
    });
    const result = answer(await handlers.handleCreateAndWrite(CLASS_ARGS));
    expect(result).toMatchObject({ status: 'error', created: true, written: false });
    expect(result.hint).toContain('exists but is empty');
    expect(calls).toEqual(['validate', 'create', 'lock', 'unlock']);
    expect(lockRegistry.count()).toBe(0);
  });

  it('a dry run reports the URLs and creates nothing', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleCreateAndWrite({ ...CLASS_ARGS, dryRun: true }));
    expect(result).toMatchObject({
      status: 'success',
      dryRun: true,
      created: false,
      sourceUrl: '/sap/bc/adt/oo/classes/zcl_mcp_test/source/main'
    });
    expect(calls).toEqual(['validate']);
  });
});
