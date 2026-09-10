import { DdicStructureHandlers } from '../handlers/DdicStructureHandlers';
import { ObjectRegistrationHandlers } from '../handlers/ObjectRegistrationHandlers';
import { lockRegistry } from '../lib/lockRegistry';

const STUB = [
  "@EndUserText.label : 'MCP probe structure'",
  '@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE',
  'define type zdev_mcp_struc {',
  '  component_to_be_changed : abap.string(0);',
  '',
  '}'
].join('\n');

const harness = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const writes: any[] = [];
  let activations = 0;
  const client: any = {
    stateful: 'stateless',
    language: 'RU',
    username: 'TESTER',
    validateNewObject: async () => { calls.push('validate'); return { success: true }; },
    createObject: async () => { calls.push('create'); },
    lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; },
    unLock: async () => { calls.push('unlock'); },
    setObjectSource: async (url: string, source: string) => { calls.push('write'); writes.push({ url, source }); },
    syntaxCheck: async () => { calls.push('syntaxCheck'); return []; },
    // A freshly written structure really is inactive, and activateAndVerify
    // activates only what the backend reports as such.
    inactiveObjects: async () => {
      calls.push('inactiveObjects');
      return activations === 0
        ? [{
          object: {
            'adtcore:uri': '/sap/bc/adt/ddic/structures/zdev_mcp_struc',
            'adtcore:type': 'TABL/DS',
            'adtcore:name': 'ZDEV_MCP_STRUC',
            'adtcore:parentUri': '/sap/bc/adt/packages/%24tmp',
            user: 'TESTER',
            deleted: false
          }
        }]
        : [];
    },
    activate: async () => { calls.push('activate'); activations += 1; return { success: true, messages: [], inactive: [] }; },
    httpClient: {
      request: async (url: string) => { calls.push(`GET ${url}`); return { body: STUB, headers: {} }; }
    },
    ...over
  };
  if (!('statelessClone' in over)) client.statelessClone = client;
  return { handlers: new DdicStructureHandlers(client), calls, writes, client };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

const ARGS = {
  name: 'ZDEV_MCP_STRUC',
  packageName: '$TMP',
  description: 'MCP probe structure',
  fields: [
    { name: 'WERKS', type: 'WERKS_D', keyField: true },
    { name: 'MATNR', type: 'MATNR' }
  ]
};

beforeEach(() => lockRegistry.clear());

describe('createStructure', () => {
  it('validates, creates, reads the stub, writes, checks, unlocks and activates', async () => {
    const { handlers, calls, writes } = harness();
    const result = answer(await handlers.handleCreateStructure(ARGS));

    expect(calls).toEqual([
      'validate',
      'create',
      'GET /sap/bc/adt/ddic/structures/zdev_mcp_struc/source/main',
      'lock',
      'write',
      'syntaxCheck',
      'unlock',
      'inactiveObjects',
      'activate',
      'inactiveObjects'
    ]);
    expect(result.status).toBe('success');
    expect(result.activated).toBe(true);
    // The stub's keyword, not a guessed one.
    expect(writes[0].source).toContain('define type zdev_mcp_struc {');
    expect(writes[0].source).toContain('key werks : werks_d not null;');
  });

  it('creates in the logon language', async () => {
    const created: any[] = [];
    const { handlers } = harness({ createObject: async (o: any) => { created.push(o); } });
    await handlers.handleCreateStructure(ARGS);
    expect(created[0].language).toBe('RU');
    expect(created[0].masterLanguage).toBe('RU');
    expect(created[0].objtype).toBe('TABL/DS');
  });

  // The DDIC error from a syntax check names the field and the reason; the
  // same problem from activation arrives as a localized sentence about
  // reference tables.
  it('does not activate when the definition does not check out', async () => {
    const { handlers, calls } = harness({
      syntaxCheck: async () => [{
        uri: '/sap/bc/adt/ddic/structures/zdev_mcp_struc/source/main',
        line: 6, offset: 2, severity: 'E',
        text: 'Annotation with reference to unit code for field MENGE is missing'
      }]
    });
    const result = answer(await handlers.handleCreateStructure({
      ...ARGS,
      fields: [{ name: 'MENGE', type: 'MENGE_D' }]
    }));

    expect(calls).not.toContain('activate');
    expect(result.status).toBe('error');
    expect(result.written).toBe(true);
    expect(result.activated).toBe(false);
    expect(JSON.stringify(result.steps)).toMatch(/unit code/);
  });

  it('reports the created placeholder object when the write is refused', async () => {
    const { handlers, calls } = harness({
      setObjectSource: async () => { throw new Error("Can't save due to errors in source"); }
    });
    const result = answer(await handlers.handleCreateStructure(ARGS));

    expect(result.status).toBe('error');
    expect(result.created).toBe(true);
    expect(result.written).toBe(false);
    expect(calls).toContain('unlock');
    expect(result.hint).toMatch(/placeholder field/);
  });

  it('builds the DDL and stops on a dry run', async () => {
    const { handlers, calls } = harness();
    const result = answer(await handlers.handleCreateStructure({ ...ARGS, dryRun: true }));

    expect(calls).toEqual(['validate']);
    expect(result.created).toBe(false);
    expect(result.source).toContain('key werks : werks_d not null;');
  });

  it('refuses a bad field list before touching the backend', async () => {
    const { handlers, calls } = harness();
    await expect(handlers.handleCreateStructure({ ...ARGS, fields: [{ name: 'A', type: '' }] }))
      .rejects.toThrow(/has no type/);
    expect(calls).toEqual([]);
  });

  it('asks for fields and for a transport outside $TMP', async () => {
    const { handlers } = harness();
    await expect(handlers.handleCreateStructure({ ...ARGS, fields: [] }))
      .rejects.toThrow(/at least one/);
    await expect(handlers.handleCreateStructure({ ...ARGS, packageName: 'ZAPP_BASE' }))
      .rejects.toThrow(/transport request/);
  });
});

describe('getStructureSource', () => {
  it('answers with the text and the parsed fields', async () => {
    const table = [
      "@EndUserText.label : 'Route requests'",
      'define type zappstep {',
      '  key mandt : mandt not null;',
      '  aedat     : aedat;',
      '}'
    ].join('\n');
    const { handlers } = harness({
      statelessClone: { httpClient: { request: async () => ({ body: table, headers: {} }) } }
    });
    const result = answer(await handlers.handleGetStructureSource({ name: 'ZAPPSTEP' }));

    expect(result.status).toBe('success');
    expect(result.label).toBe('Route requests');
    expect(result.fieldCount).toBe(2);
    expect(result.fields[0]).toEqual({ name: 'MANDT', type: 'mandt', keyField: true, notNull: true });
    expect(result.sourceUrl).toBe('/sap/bc/adt/ddic/structures/zappstep/source/main');
  });

  it('passes the version through when asked', async () => {
    const seen: any[] = [];
    const { handlers } = harness({
      statelessClone: {
        httpClient: { request: async (url: string, cfg: any) => { seen.push(cfg); return { body: STUB, headers: {} }; } }
      }
    });
    await handlers.handleGetStructureSource({ name: 'ZAPPSTEP', version: 'active' });
    expect(seen[0].qs).toEqual({ version: 'active' });
  });

  it('asks for a name', async () => {
    const { handlers } = harness();
    await expect(handlers.handleGetStructureSource({})).rejects.toThrow(/Pass name/);
  });
});

describe('createAndWrite and the DDIC types', () => {
  const registration = () => {
    const client: any = {
      stateful: 'stateless', language: 'RU', username: 'TESTER',
      validateNewObject: async () => ({ success: true }),
      createObject: async () => undefined,
      lock: async () => ({ LOCK_HANDLE: 'HANDLE' }),
      unLock: async () => undefined,
      setObjectSource: async () => undefined,
      inactiveObjects: async () => [],
      activate: async () => ({ success: true, messages: [], inactive: [] }),
      httpClient: { request: async () => ({ body: '' }) }
    };
    return new ObjectRegistrationHandlers(client);
  };

  // The type map inside abap-adt-api points at a ddic/tables collection that a
  // classic ERP system does not have, so this refusal saves a confusing 404.
  it('refuses a transparent table with the reason', async () => {
    await expect(registration().handleCreateAndWrite({
      objtype: 'TABL/DT', name: 'ZDEV_MCP_TAB', description: 'x',
      packageName: '$TMP', source: 'define type zdev_mcp_tab { a : abap.char(1); }'
    })).rejects.toThrow(/no ddic\/tables collection/);
  });

  // Reading, validating and creating a package all answer 404 here: only
  // /sap/bc/adt/packages/settings is served.
  it('refuses a package with the reason, from either creation tool', async () => {
    await expect(registration().handleCreateAndWrite({
      objtype: 'DEVC/K', name: 'ZDEV_MCP_PKG', description: 'x', packageName: '$TMP', source: 'x'
    })).rejects.toThrow(/packages is not served at all/);
    await expect(registration().handleCreateObject({
      objtype: 'DEVC/K', name: 'ZDEV_MCP_PKG', description: 'x', parentName: '$TMP'
    })).rejects.toThrow(/packages is not served at all/);
    await expect(registration().handleCreateObject({
      objtype: 'TABL/DT', name: 'ZDEV_MCP_TAB', description: 'x', parentName: '$TMP'
    })).rejects.toThrow(/no ddic\/tables collection/);
  });

  it('knows where a CDS view and a structure keep their source', async () => {
    const cds = JSON.parse((await registration().handleCreateAndWrite({
      objtype: 'DDLS/DF', name: 'ZDEV_MCP_CDS', description: 'x', packageName: '$TMP',
      source: "@AbapCatalog.sqlViewName: 'ZDEVV'\ndefine view zdev_mcp_cds as select from t000 { key mandt as Client }"
    })).content[0].text);
    expect(cds.sourceUrl).toBe('/sap/bc/adt/ddic/ddl/sources/zdev_mcp_cds/source/main');

    const structure = JSON.parse((await registration().handleCreateAndWrite({
      objtype: 'TABL/DS', name: 'ZDEV_MCP_STRUC', description: 'x', packageName: '$TMP',
      source: 'define type zdev_mcp_struc { a : abap.char(1); }'
    })).content[0].text);
    expect(structure.sourceUrl).toBe('/sap/bc/adt/ddic/structures/zdev_mcp_struc/source/main');
  });
});
