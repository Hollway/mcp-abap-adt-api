import {
  parseFunctionSource,
  parseParameter,
  buildFunctionSource,
  signatureCounts,
  FunctionModuleError
} from '../lib/functionModule';
import { FunctionModuleHandlers } from '../handlers/FunctionModuleHandlers';
import { MUTATING_TOOLS } from '../lib/toolClasses';

/**
 * The interface exactly as ADT serves it, taken from GUI_UPLOAD on ECC:
 * bare names for by-reference parameters, VALUE(NAME) for by-value ones, a
 * TABLES entry carrying the pragma ADT adds for an untyped parameter, classic
 * exceptions, and the full stop of the whole statement on the last line.
 */
const GUI_UPLOAD = [
  'FUNCTION GUI_UPLOAD',
  '  IMPORTING',
  '    FILENAME TYPE STRING',
  `    FILETYPE TYPE CHAR10 DEFAULT 'ASC'`,
  '    HAS_FIELD_SEPARATOR TYPE CHAR01 DEFAULT SPACE',
  '    VIRUS_SCAN_PROFILE TYPE VSCAN_PROFILE OPTIONAL',
  '  EXPORTING',
  '    VALUE(FILELENGTH) TYPE I',
  '  CHANGING',
  '    ISSCANPERFORMED TYPE CHAR01 DEFAULT SPACE',
  '  TABLES',
  '    DATA_TAB TYPE STANDARD TABLE ##ADT_PARAMETER_UNTYPED',
  '  EXCEPTIONS',
  '    FILE_OPEN_ERROR',
  '    NO_AUTHORITY.',
  '',
  '  DATA lv_x TYPE i.',
  '  lv_x = 1.',
  '',
  'ENDFUNCTION.'
].join('\r\n');

describe('parseParameter', () => {
  it('reads a by-reference parameter with a default', () => {
    expect(parseParameter(`FILETYPE TYPE CHAR10 DEFAULT 'ASC'`))
      .toEqual({ name: 'FILETYPE', type: 'CHAR10', default: `'ASC'` });
  });

  it('reads a by-value parameter', () => {
    expect(parseParameter('VALUE(ET_INVOICE) TYPE ZAPP_INVOICE_LIST_TT'))
      .toEqual({ name: 'ET_INVOICE', type: 'ZAPP_INVOICE_LIST_TT', byValue: true });
  });

  it('reads REFERENCE(...) as by reference', () => {
    expect(parseParameter('REFERENCE(IV_X) TYPE I')).toEqual({ name: 'IV_X', type: 'I' });
  });

  it('marks an optional parameter', () => {
    expect(parseParameter('VIRUS_SCAN_PROFILE TYPE VSCAN_PROFILE OPTIONAL'))
      .toEqual({ name: 'VIRUS_SCAN_PROFILE', type: 'VSCAN_PROFILE', optional: true });
  });

  it('reads the older STRUCTURE and LIKE forms', () => {
    expect(parseParameter('IT_TAB STRUCTURE MARA')).toEqual({ name: 'IT_TAB', structure: 'MARA' });
    expect(parseParameter('IV_OLD LIKE SY-DATUM')).toEqual({ name: 'IV_OLD', like: 'SY-DATUM' });
  });

  it('drops the pragma on an untyped tables parameter', () => {
    expect(parseParameter('DATA_TAB TYPE STANDARD TABLE ##ADT_PARAMETER_UNTYPED'))
      .toEqual({ name: 'DATA_TAB', type: 'STANDARD TABLE' });
  });

  it('answers nothing for an empty line', () => {
    expect(parseParameter('   ')).toBeUndefined();
  });
});

describe('parseFunctionSource', () => {
  it('reads the whole interface and the body', () => {
    const parsed = parseFunctionSource(GUI_UPLOAD);
    expect(parsed.signature.name).toBe('GUI_UPLOAD');
    expect(parsed.signature.importing.map(p => p.name))
      .toEqual(['FILENAME', 'FILETYPE', 'HAS_FIELD_SEPARATOR', 'VIRUS_SCAN_PROFILE']);
    expect(parsed.signature.exporting).toEqual([{ name: 'FILELENGTH', type: 'I', byValue: true }]);
    expect(parsed.signature.changing).toEqual([
      { name: 'ISSCANPERFORMED', type: 'CHAR01', default: 'SPACE' }
    ]);
    expect(parsed.signature.tables).toEqual([{ name: 'DATA_TAB', type: 'STANDARD TABLE' }]);
    expect(parsed.signature.exceptions).toEqual(['FILE_OPEN_ERROR', 'NO_AUTHORITY']);
    expect(parsed.headerStart).toBe(1);
    expect(parsed.headerEnd).toBe(15);
    expect(parsed.body).toEqual(['', '  DATA lv_x TYPE i.', '  lv_x = 1.', '']);
    expect(signatureCounts(parsed.signature)).toEqual({
      importing: 4, exporting: 1, changing: 1, tables: 1, exceptions: 2
    });
  });

  it('reads a module with no parameters at all', () => {
    const parsed = parseFunctionSource('FUNCTION Z_NOTHING.\n  RETURN.\nENDFUNCTION.');
    expect(parsed.signature).toMatchObject({ name: 'Z_NOTHING', importing: [], exceptions: [] });
    expect(parsed.body).toEqual(['  RETURN.']);
  });

  it('refuses a source that is not a function module', () => {
    expect(() => parseFunctionSource('REPORT zfoo.\nWRITE 1.'))
      .toThrow(/does not start with a FUNCTION statement/);
  });
});

describe('buildFunctionSource', () => {
  it('writes the interface as one statement, with the full stop on its last line', () => {
    const source = buildFunctionSource({
      name: 'z_mcp_add',
      importing: [{ name: 'iv_a', type: 'i' }, { name: 'iv_b', type: 'i', default: '0' }],
      exporting: [{ name: 'ev_sum', type: 'i', byValue: true }],
      exceptions: ['OVERFLOW'],
      implementation: ['ev_sum = iv_a + iv_b.']
    });
    expect(source.split('\n')).toEqual([
      'FUNCTION Z_MCP_ADD',
      '  IMPORTING',
      '    IV_A TYPE i',
      '    IV_B TYPE i DEFAULT 0',
      '  EXPORTING',
      '    VALUE(EV_SUM) TYPE i',
      '  EXCEPTIONS',
      '    OVERFLOW.',
      '',
      '  ev_sum = iv_a + iv_b.',
      '',
      'ENDFUNCTION.',
      ''
    ]);
  });

  it('puts the full stop on the FUNCTION line when there are no parameters', () => {
    expect(buildFunctionSource({ name: 'Z_NOTHING' }).split('\n')[0]).toBe('FUNCTION Z_NOTHING.');
  });

  // Seen on the live run: flattening the body turned an IF block into a list.
  it("keeps the caller's own indentation in the body", () => {
    const source = buildFunctionSource({
      name: 'Z_NESTED',
      implementation: ['IF iv_a > 0.', '  ev_sum = iv_a.', 'ENDIF.']
    });
    expect(source.split(/\n/).slice(1, 5))
      .toEqual(['', '  IF iv_a > 0.', '    ev_sum = iv_a.', '  ENDIF.']);
  });

  it('leaves a marker when there is no body', () => {
    expect(buildFunctionSource({ name: 'Z_TODO' })).toContain('" TODO: implement z_todo');
  });

  it('round-trips: what it writes, the parser reads back', () => {
    const source = buildFunctionSource({
      name: 'Z_ROUND_TRIP',
      importing: [{ name: 'IV_X', type: 'STRING', optional: true }],
      tables: [{ name: 'IT_TAB', structure: 'MARA' }],
      exceptions: ['NOT_FOUND'],
      implementation: ['CLEAR iv_x.']
    });
    const parsed = parseFunctionSource(source);
    expect(parsed.signature.importing).toEqual([{ name: 'IV_X', type: 'STRING', optional: true }]);
    expect(parsed.signature.tables).toEqual([{ name: 'IT_TAB', structure: 'MARA' }]);
    expect(parsed.signature.exceptions).toEqual(['NOT_FOUND']);
  });

  it('insists on a name and on a type for every parameter', () => {
    expect(() => buildFunctionSource({ name: '' })).toThrow(/needs a name/);
    expect(() => buildFunctionSource({ name: 'Z_X', importing: [{ name: 'IV_A' }] }))
      .toThrow(/needs a type/);
  });
});

const NODE_CONTENTS = {
  nodes: [
    {
      OBJECT_TYPE: 'FUGR/FF',
      OBJECT_NAME: 'Z_APP_GET_INVOICE',
      OBJECT_URI: '/sap/bc/adt/functions/groups/zapp_core_fm/fmodules/z_app_get_invoice',
      OBJECT_VIT_URI: '/sap/bc/adt/vit/wb/object_type/fugrff/object_name/SAPLZAPP_CORE_FM%20%20%20%20Z_APP_GET_INVOICE'
    },
    {
      OBJECT_TYPE: 'FUGR/I',
      OBJECT_NAME: 'LZAPP_CORE_FMTOP',
      OBJECT_URI: '/sap/bc/adt/functions/groups/zapp_core_fm/includes/lzapp_core_fmtop/source/main'
    },
    { OBJECT_TYPE: 'FUGR/PD', OBJECT_NAME: 'GT_T604' },
    { OBJECT_TYPE: 'FUGR/PY', OBJECT_NAME: 'GTY_S_DELIVERY_POS' }
  ]
};

const SEARCH_HIT = [{
  'adtcore:uri': '/sap/bc/adt/functions/groups/zapp_core_fm/fmodules/z_app_get_invoice',
  'adtcore:type': 'FUGR/FF',
  'adtcore:name': 'Z_APP_GET_INVOICE',
  'adtcore:packageName': 'ZAPP_ARM',
  'adtcore:description': 'Функциональный модуль'
}];

const handlers = (over: Record<string, unknown> = {}) => {
  const calls: any[] = [];
  const client = {
    // The type filter is not passed to the backend: objType=FUGR/FF answers
    // with an empty list there, so the search is unfiltered and the row is
    // picked by type here. The stub therefore answers both kinds at once.
    searchObject: async (query: string, type: string | undefined) => {
      calls.push({ search: query, type });
      return [
        { 'adtcore:name': 'ZAPP_CORE_FM', 'adtcore:type': 'FUGR/F', 'adtcore:packageName': 'ZAPP_ARM' },
        ...SEARCH_HIT
      ];
    },
    getObjectSource: async (url: string) => {
      calls.push({ read: url });
      return GUI_UPLOAD;
    },
    nodeContents: async (type: string, name: string) => {
      calls.push({ nodes: `${type}:${name}` });
      return NODE_CONTENTS;
    },
    ...over
  };
  return { handler: new FunctionModuleHandlers(client as any), calls };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('getFunctionModule', () => {
  it('finds the group from the name alone and reads the signature', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleGetFunctionModule({ name: 'z_app_get_invoice' }));
    expect(calls[0]).toEqual({ search: 'Z_APP_GET_INVOICE', type: undefined });
    expect(calls[1]).toEqual({
      read: '/sap/bc/adt/functions/groups/zapp_core_fm/fmodules/z_app_get_invoice/source/main'
    });
    expect(result).toMatchObject({ functionGroup: 'ZAPP_CORE_FM', package: 'ZAPP_ARM' });
    expect(result.counts).toEqual({ importing: 4, exporting: 1, changing: 1, tables: 1, exceptions: 2 });
    // The body is not returned unless asked for: these are often 1000 lines.
    expect(result.body).toBeUndefined();
    expect(result.bodyLines).toBe(4);
  });

  it('skips the lookup when the group is given', async () => {
    const { handler, calls } = handlers();
    await handler.handleGetFunctionModule({ name: 'Z_X', functionGroup: 'ZAPP_CORE_FM' });
    expect(calls[0]).toEqual({ read: '/sap/bc/adt/functions/groups/zapp_core_fm/fmodules/z_x/source/main' });
  });

  it('returns a page of the body when asked', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleGetFunctionModule({
      name: 'Z_X', functionGroup: 'ZFG', includeSource: true, startLine: 2, maxLines: 1
    }));
    expect(result.body).toBe('  DATA lv_x TYPE i.');
    expect(result).toMatchObject({ bodyReturnedLines: 1, bodyHasMore: true });
  });

  it('says the module is not there when the search finds nothing', async () => {
    const { handler } = handlers({ searchObject: async () => [] });
    await expect(handler.handleGetFunctionModule({ name: 'Z_NO_SUCH_FM' }))
      .rejects.toThrow(/No function module Z_NO_SUCH_FM was found .* pass functionGroup/);
  });

  it('insists on a name', async () => {
    const { handler } = handlers();
    await expect(handler.handleGetFunctionModule({})).rejects.toThrow(/Pass name/);
  });
});

describe('listFunctionGroup', () => {
  it('lists the modules, includes and globals without the SAPGUI padding', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleListFunctionGroup({ functionGroup: 'zapp_core_fm' }));
    expect(calls[0]).toEqual({ nodes: 'FUGR/F:ZAPP_CORE_FM' });
    expect(result.counts).toEqual({ modules: 1, includes: 1, globalData: 1, globalTypes: 1 });
    expect(result.modules).toEqual([{
      name: 'Z_APP_GET_INVOICE',
      sourceUrl: '/sap/bc/adt/functions/groups/zapp_core_fm/fmodules/z_app_get_invoice/source/main'
    }]);
    expect(JSON.stringify(result)).not.toContain('OBJECT_VIT_URI');
  });

  it('leaves the globals out when asked', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleListFunctionGroup({
      functionGroup: 'ZAPP_CORE_FM', includeGlobals: false
    }));
    expect(result.globalData).toBeUndefined();
  });

  // An unknown group and an empty one both answer with no nodes.
  it('tells an unknown group from an empty one', async () => {
    const empty = handlers({
      nodeContents: async () => ({ nodes: [] }),
      searchObject: async () => [{ 'adtcore:name': 'ZFG_EMPTY', 'adtcore:type': 'FUGR/F' }]
    });
    expect(answer(await empty.handler.handleListFunctionGroup({ functionGroup: 'ZFG_EMPTY' })))
      .toMatchObject({ status: 'success', modules: [], note: expect.stringContaining('no modules') });

    const missing = handlers({
      nodeContents: async () => ({ nodes: [] }),
      searchObject: async () => []
    });
    expect(answer(await missing.handler.handleListFunctionGroup({ functionGroup: 'ZFG_NOPE' })))
      .toMatchObject({ status: 'error', error: expect.stringContaining('No function group ZFG_NOPE') });
  });
});

describe('createFunctionModule', () => {
  it('shows the source it would write without touching anything', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleCreateFunctionModule({
      name: 'z_mcp_add',
      functionGroup: 'ZDEV_MCP_FG',
      description: 'adds two numbers',
      importing: [{ name: 'iv_a', type: 'i' }],
      exporting: [{ name: 'ev_sum', type: 'i' }],
      implementation: ['ev_sum = iv_a.'],
      dryRun: true
    }));
    expect(calls).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.source).toContain('FUNCTION Z_MCP_ADD');
    expect(result.source).toContain('    IV_A TYPE i');
  });

  it('refuses a group that is not there, and says how to make one', async () => {
    const { handler } = handlers({ searchObject: async () => [] });
    await expect(handler.handleCreateFunctionModule({
      name: 'Z_X', functionGroup: 'ZFG_NOPE', description: 'x'
    })).rejects.toThrow(/No function group ZFG_NOPE .* createAndWrite \(objtype FUGR\/F\)/);
  });

  it('insists on name, group and description', async () => {
    const { handler } = handlers();
    await expect(handler.handleCreateFunctionModule({ name: 'Z_X' }))
      .rejects.toThrow(/Pass name, functionGroup and description/);
  });

  it('reports a bad signature as a bad parameter, before creating anything', async () => {
    const { handler, calls } = handlers();
    await expect(handler.handleCreateFunctionModule({
      name: 'Z_X', functionGroup: 'ZFG', description: 'x', importing: [{ name: 'IV_A' }]
    })).rejects.toThrow(/needs a type/);
    expect(calls).toEqual([]);
  });

  it('counts as a writing tool', () => {
    expect(MUTATING_TOOLS.has('createFunctionModule')).toBe(true);
    expect(MUTATING_TOOLS.has('getFunctionModule')).toBe(false);
  });
});

describe('FunctionModuleError', () => {
  it('is an Error, so a handler can tell it from an ADT failure', () => {
    expect(new FunctionModuleError('x')).toBeInstanceOf(Error);
  });
});
