import { rollUpUsages, ownerFromUri } from '../lib/impact';
import { ImpactHandlers } from '../handlers/ImpactHandlers';

/**
 * Rows shaped exactly like a live where-used answer for ZCL_APP_RETURN on
 * ECC: a package row, an object row under it, and the places inside the
 * object - a method, an include of a function group, a function module, a test
 * include. That answer is 352 rows for some 40 objects.
 */
const ROWS = [
  {
    uri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZAPP',
    'adtcore:name': 'ZAPP',
    'adtcore:type': 'DEVC/K',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order',
    parentUri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZAPP',
    'adtcore:name': 'ZCL_APP_ORDER',
    'adtcore:type': 'CLAS/OC',
    'adtcore:description': 'Order helpers',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order/source/main#type=CLAS%2FOM;name=CHECK',
    parentUri: '/sap/bc/adt/oo/classes/zcl_app_order',
    usageInformation: 'gradeDirect,includeProductive',
    'adtcore:name': 'CHECK',
    'adtcore:type': 'CLAS/OM',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order/source/main#type=CLAS%2FOM;name=SAVE',
    parentUri: '/sap/bc/adt/oo/classes/zcl_app_order',
    usageInformation: 'gradeDirect,includeProductive',
    'adtcore:name': 'SAVE',
    'adtcore:type': 'CLAS/OM',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  // Class include rows repeat the class name and say nothing about the call.
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order/source/main#type=CLAS%2FOSU;name=ZCL_APP_ORDER',
    parentUri: '/sap/bc/adt/oo/classes/zcl_app_order',
    'adtcore:name': 'Класс (ABAP Objects)',
    'adtcore:type': 'CLAS/OSU',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  {
    uri: '/sap/bc/adt/functions/groups/zapp_3pl_fg',
    parentUri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZAPP_3PL',
    'adtcore:name': 'ZAPP_3PL_FG',
    'adtcore:type': 'FUGR/F',
    packageRef: { 'adtcore:name': 'ZAPP_3PL' }
  },
  {
    uri: '/sap/bc/adt/functions/groups/zapp_3pl_fg/fmodules/zapp_3pl_mark_create',
    parentUri: '/sap/bc/adt/functions/groups/zapp_3pl_fg',
    usageInformation: 'gradeDirect,includeProductive',
    'adtcore:name': 'ZAPP_3PL_MARK_CREATE',
    'adtcore:type': 'FUGR/FF',
    packageRef: { 'adtcore:name': 'ZAPP_3PL' }
  },
  // A place whose parent row is not in the answer: the URI has to carry it.
  {
    uri: '/sap/bc/adt/programs/programs/zr_app_orphan/source/main#type=PROG%2FI;name=ZR_APP_ORPHAN_F01',
    parentUri: '/sap/bc/adt/programs/programs/zr_app_orphan',
    usageInformation: 'gradeDirect,includeProductive',
    'adtcore:name': 'ZR_APP_ORPHAN_F01',
    'adtcore:type': 'PROG/I',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  // Standard SAP code, hidden unless asked for.
  {
    uri: '/sap/bc/adt/oo/classes/cl_sap_thing',
    parentUri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/SABAPDEMOS',
    'adtcore:name': 'CL_SAP_THING',
    'adtcore:type': 'CLAS/OC',
    packageRef: { 'adtcore:name': 'SABAPDEMOS' }
  },
  {
    uri: '/sap/bc/adt/oo/classes/cl_sap_thing/source/main#type=CLAS%2FOM;name=DO_IT',
    parentUri: '/sap/bc/adt/oo/classes/cl_sap_thing',
    usageInformation: 'gradeDirect,includeProductive',
    'adtcore:name': 'DO_IT',
    'adtcore:type': 'CLAS/OM',
    packageRef: { 'adtcore:name': 'SABAPDEMOS' }
  },
  // Only used from a test include.
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order_test',
    parentUri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZAPP',
    'adtcore:name': 'ZCL_APP_ORDER_TEST',
    'adtcore:type': 'CLAS/OC',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order_test/includes/testclasses#start=1,0',
    parentUri: '/sap/bc/adt/oo/classes/zcl_app_order_test',
    usageInformation: 'gradeDirect,includeTest',
    'adtcore:name': 'Локальные тест-классы',
    'adtcore:type': 'CLAS/OSO',
    packageRef: { 'adtcore:name': 'ZAPP' }
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app_order_test/source/main#type=CLAS%2FOM;name=TEST_SAVE',
    parentUri: '/sap/bc/adt/oo/classes/zcl_app_order_test',
    usageInformation: 'gradeDirect,includeTest',
    'adtcore:name': 'TEST_SAVE',
    'adtcore:type': 'CLAS/OM',
    packageRef: { 'adtcore:name': 'ZAPP' }
  }
];

describe('ownerFromUri', () => {
  it('reads the object out of a place URI', () => {
    expect(ownerFromUri('/sap/bc/adt/oo/classes/zcl_x/source/main#type=CLAS%2FOM;name=M'))
      .toEqual({ name: 'ZCL_X', type: 'CLAS/OC', objectUrl: '/sap/bc/adt/oo/classes/zcl_x' });
    expect(ownerFromUri('/sap/bc/adt/functions/groups/zfg/fmodules/z_fm'))
      .toMatchObject({ name: 'ZFG', type: 'FUGR/F' });
    expect(ownerFromUri('/sap/bc/adt/oo/interfaces/zif_x')).toMatchObject({ type: 'INTF/OI' });
    expect(ownerFromUri('/sap/bc/adt/programs/programs/zr_x')).toMatchObject({ type: 'PROG/P' });
  });

  it('decodes a namespaced name', () => {
    expect(ownerFromUri('/sap/bc/adt/oo/classes/%2Farm%2Fcl_foo')!.name).toBe('/ARM/CL_FOO');
  });

  it('answers nothing for a URI it does not recognise', () => {
    expect(ownerFromUri('/sap/bc/adt/vit/wb/object_type/devck/object_name/ZAPP')).toBeUndefined();
  });
});

describe('rollUpUsages', () => {
  it('groups the places under the object they sit in', () => {
    const result = rollUpUsages(ROWS);
    const order = result.objects.find(entry => entry.name === 'ZCL_APP_ORDER')!;
    expect(order).toMatchObject({ type: 'CLAS/OC', package: 'ZAPP', description: 'Order helpers' });
    expect(order.places).toEqual([
      { name: 'CHECK', kind: 'method' },
      { name: 'SAVE', kind: 'method' }
    ]);
  });

  it('drops the package rows and the class include noise', () => {
    const result = rollUpUsages(ROWS);
    expect(result.objects.some(entry => entry.type.startsWith('DEVC'))).toBe(false);
    expect(result.objects.flatMap(entry => entry.places).some(place => place.kind === 'class include'))
      .toBe(false);
  });

  it('reports a function module as a place inside its group', () => {
    const group = rollUpUsages(ROWS).objects.find(entry => entry.name === 'ZAPP_3PL_FG')!;
    expect(group).toMatchObject({ type: 'FUGR/F', package: 'ZAPP_3PL' });
    expect(group.places).toEqual([{ name: 'ZAPP_3PL_MARK_CREATE', kind: 'function module' }]);
  });

  // Seen live: a standalone include is its own object here, because the
  // program that includes it is not in the answer.
  it('does not list an include as a place inside itself', () => {
    const result = rollUpUsages([
      {
        uri: '/sap/bc/adt/programs/includes/zreport_zdemo_f02',
        usageInformation: 'gradeDirect,includeProductive',
        'adtcore:name': 'ZREPORT_ZDEMO_F02',
        'adtcore:type': 'PROG/I',
        packageRef: { 'adtcore:name': 'ZAPPSOFT' }
      }
    ]);
    expect(result.objects).toEqual([{
      name: 'ZREPORT_ZDEMO_F02',
      type: 'PROG/I',
      package: 'ZAPPSOFT',
      objectUrl: '/sap/bc/adt/programs/includes/zreport_zdemo_f02',
      places: []
    }]);
  });

  it('attaches a place whose parent row is missing, from its URI', () => {
    const orphan = rollUpUsages(ROWS).objects.find(entry => entry.name === 'ZR_APP_ORPHAN')!;
    expect(orphan).toMatchObject({ type: 'PROG/P', objectUrl: '/sap/bc/adt/programs/programs/zr_app_orphan' });
    expect(orphan.places).toEqual([{ name: 'ZR_APP_ORPHAN_F01', kind: 'include' }]);
  });

  it('hides standard objects by default and counts them', () => {
    const hidden = rollUpUsages(ROWS);
    expect(hidden.objects.some(entry => entry.name === 'CL_SAP_THING')).toBe(false);
    expect(hidden.standardObjectsHidden).toBe(2);

    const shown = rollUpUsages(ROWS, { onlyCustom: false });
    expect(shown.objects.some(entry => entry.name === 'CL_SAP_THING')).toBe(true);
    expect(shown.standardObjectsHidden).toBe(0);
  });

  it('marks a caller that only uses it from a test include', () => {
    const result = rollUpUsages(ROWS);
    const test = result.objects.find(entry => entry.name === 'ZCL_APP_ORDER_TEST')!;
    expect(test.testOnly).toBe(true);
    expect(test.places).toEqual([{ name: 'TEST_SAVE', kind: 'method', test: true }]);
    expect(result.summary.testOnlyObjects).toBe(1);
  });

  it('leaves the test-only callers out when asked', () => {
    const result = rollUpUsages(ROWS, { includeTests: false });
    expect(result.objects.some(entry => entry.name === 'ZCL_APP_ORDER_TEST')).toBe(false);
  });

  it('filters by package', () => {
    const result = rollUpUsages(ROWS, { packageName: 'zapp_3pl' });
    expect(result.objects.map(entry => entry.name)).toEqual(['ZAPP_3PL_FG']);
  });

  it('summarises by type and package', () => {
    const result = rollUpUsages(ROWS);
    expect(result.summary).toMatchObject({
      objects: 4,
      packages: 2,
      places: 5,
      byType: { 'CLAS/OC': 2, 'FUGR/F': 1, 'PROG/P': 1 },
      byPackage: { ZAPP: 3, ZAPP_3PL: 1 }
    });
  });

  it('lists the most affected objects first', () => {
    expect(rollUpUsages(ROWS).objects[0].name).toBe('ZCL_APP_ORDER');
  });

  it('caps the objects and the places, and says how many it held back', () => {
    const capped = rollUpUsages(ROWS, { maxObjects: 2, maxPlacesPerObject: 1 });
    expect(capped.objects).toHaveLength(2);
    expect(capped.objectsHidden).toBe(2);
    expect(capped.objects[0].places).toHaveLength(1);
    expect(capped.objects[0].morePlaces).toBe(1);
    // The counts still describe everything that was found.
    expect(capped.summary.objects).toBe(4);
    expect(capped.summary.places).toBe(5);
  });

  it('answers an empty list for no references', () => {
    expect(rollUpUsages([])).toMatchObject({
      objects: [],
      summary: { objects: 0, packages: 0, places: 0 }
    });
  });
});

const CLASS_SOURCE = [
  'class ZCL_APP_RETURN definition public .',
  '  public section.',
  '    methods ADD_RETURN .',
  'ENDCLASS.',
  'CLASS ZCL_APP_RETURN IMPLEMENTATION.',
  '  METHOD add_return.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

const handlers = (over: Record<string, unknown> = {}) => {
  const asked: any[] = [];
  const client = {
    getObjectSource: async () => CLASS_SOURCE,
    usageReferences: async (url: string, line?: number, column?: number) => {
      asked.push({ url, line, column });
      return ROWS;
    },
    ...over
  };
  return { handler: new ImpactHandlers(client as any), asked };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('impactOf', () => {
  it('asks the object URL and reports the roll-up', async () => {
    const { handler, asked } = handlers();
    const result = answer(await handler.handleImpactOf({ objectName: 'zcl_app_return' }));
    expect(asked).toEqual([{ url: '/sap/bc/adt/oo/classes/zcl_app_return', line: undefined, column: undefined }]);
    expect(result.target.object).toBe('ZCL_APP_RETURN (CLAS/OC)');
    expect(result.rowsFromBackend).toBe(ROWS.length);
    expect(result.summary.objects).toBe(4);
    expect(result.usedBy[0].name).toBe('ZCL_APP_ORDER');
    expect(result.depth).toBe(1);
  });

  it('works out the position of a method and reports it', async () => {
    const { handler, asked } = handlers();
    const result = answer(await handler.handleImpactOf({
      objectName: 'ZCL_APP_RETURN', methodName: 'add_return'
    }));
    expect(asked[0].url).toBe('/sap/bc/adt/oo/classes/zcl_app_return/source/main');
    expect(asked[0].line).toBeGreaterThan(0);
    expect(result.target).toMatchObject({ method: 'ADD_RETURN' });
    expect(result.target.resolvedAt.kind).toBeDefined();
  });

  it('falls back to the object URL when the source URL answers nothing', async () => {
    let call = 0;
    const { handler, asked } = handlers({
      usageReferences: async (url: string) => {
        asked.push({ url });
        return ++call === 1 ? [] : ROWS;
      }
    });
    const result = answer(await handler.handleImpactOf({
      objectName: 'ZCL_APP_RETURN', methodName: 'add_return'
    }));
    expect(asked.map(entry => entry.url)).toEqual([
      '/sap/bc/adt/oo/classes/zcl_app_return/source/main',
      '/sap/bc/adt/oo/classes/zcl_app_return'
    ]);
    expect(result.summary.objects).toBe(4);
  });

  it('says what an empty answer does and does not prove', async () => {
    const { handler } = handlers({ usageReferences: async () => [] });
    const result = answer(await handler.handleImpactOf({
      objectName: 'ZCL_APP_RETURN', methodName: 'add_return'
    }));
    expect(result.emptyNote).toMatch(/reached only dynamically/);
  });

  it('refuses a method name it cannot find', async () => {
    const { handler } = handlers();
    await expect(handler.handleImpactOf({ objectName: 'ZCL_APP_RETURN', methodName: 'nope' }))
      .rejects.toThrow(/No declaration or implementation of 'nope'/);
  });

  it('refuses a method name with no object name to look in', async () => {
    const { handler } = handlers();
    await expect(handler.handleImpactOf({
      objectUrl: '/sap/bc/adt/oo/classes/zcl_app_return', methodName: 'add_return'
    })).rejects.toThrow(/methodName needs objectName/);
  });

  it('refuses a type it cannot address', async () => {
    const { handler } = handlers();
    await expect(handler.handleImpactOf({ objectName: 'ZAPP_DOM', objectType: 'DOMA/DD' }))
      .rejects.toThrow(/No ADT URL is known for a DOMA\/DD/);
  });

  it('says what to pass when nothing identifies the object', async () => {
    const { handler } = handlers();
    await expect(handler.handleImpactOf({})).rejects.toThrow(/Pass objectName .* or objectUrl/);
  });

  it('follows the callers one step further at depth 2', async () => {
    const SECOND = [
      {
        uri: '/sap/bc/adt/oo/classes/zcl_far_away',
        parentUri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZFAR',
        'adtcore:name': 'ZCL_FAR_AWAY',
        'adtcore:type': 'CLAS/OC',
        packageRef: { 'adtcore:name': 'ZFAR' }
      },
      {
        uri: '/sap/bc/adt/oo/classes/zcl_far_away/source/main#type=CLAS%2FOM;name=CALLER',
        parentUri: '/sap/bc/adt/oo/classes/zcl_far_away',
        usageInformation: 'gradeDirect,includeProductive',
        'adtcore:name': 'CALLER',
        'adtcore:type': 'CLAS/OM',
        packageRef: { 'adtcore:name': 'ZFAR' }
      }
    ];
    const { handler, asked } = handlers({
      usageReferences: async (url: string) => {
        asked.push({ url });
        return url === '/sap/bc/adt/oo/classes/zcl_app_return' ? ROWS : SECOND;
      }
    });
    const result = answer(await handler.handleImpactOf({ objectName: 'ZCL_APP_RETURN', depth: 2 }));
    expect(result.depth).toBe(2);
    expect(result.indirect.map((entry: any) => entry.name)).toEqual(['ZCL_FAR_AWAY']);
    // Named by the caller it was reached through, and every direct caller was asked.
    expect(result.indirect[0].via.length).toBeGreaterThan(0);
    expect(result.indirectNote).toMatch(/followed through 4 of 4 callers/);
  });

  it('carries on when one branch cannot be read', async () => {
    const { handler } = handlers({
      usageReferences: async (url: string) =>
        (url === '/sap/bc/adt/oo/classes/zcl_app_return' ? ROWS : Promise.reject(new Error('gone')))
    });
    const result = answer(await handler.handleImpactOf({ objectName: 'ZCL_APP_RETURN', depth: 2 }));
    expect(result.indirect).toEqual([]);
  });
});

describe('impactOf snippets', () => {
  const ROWS_ONE_OBJECT = [
    {
      uri: '/sap/bc/adt/oo/classes/zcl_app_order',
      'adtcore:name': 'ZCL_APP_ORDER',
      'adtcore:type': 'CLAS/OC',
      packageRef: { 'adtcore:name': 'ZAPP' }
    },
    {
      uri: '/sap/bc/adt/oo/classes/zcl_app_order/source/main#type=CLAS%2FOM;name=CHECK',
      parentUri: '/sap/bc/adt/oo/classes/zcl_app_order',
      usageInformation: 'gradeDirect,includeProductive',
      objectIdentifier: 'id-check',
      'adtcore:name': 'CHECK',
      'adtcore:type': 'CLAS/OM',
      packageRef: { 'adtcore:name': 'ZAPP' }
    },
    {
      uri: '/sap/bc/adt/oo/classes/zcl_app_order/source/main#type=CLAS%2FOM;name=SAVE',
      parentUri: '/sap/bc/adt/oo/classes/zcl_app_order',
      usageInformation: 'gradeDirect,includeProductive',
      objectIdentifier: 'id-save',
      'adtcore:name': 'SAVE',
      'adtcore:type': 'CLAS/OM',
      packageRef: { 'adtcore:name': 'ZAPP' }
    }
  ];

  it('fetches a snippet only for the places actually listed, and drops the correlation id', async () => {
    const snippetCalls: any[] = [];
    const { handler } = handlers({
      usageReferences: async () => ROWS_ONE_OBJECT,
      usageReferenceSnippets: async (refs: any[]) => {
        snippetCalls.push(refs);
        return refs.map(r => ({
          objectIdentifier: r.objectIdentifier,
          snippets: [{ uri: { uri: r.uri }, matches: '1', content: `snippet for ${r.objectIdentifier}`, description: '' }]
        }));
      }
    });
    const result = answer(await handler.handleImpactOf({ objectName: 'ZCL_APP_RETURN', snippets: true }));
    expect(snippetCalls[0].map((r: any) => r.objectIdentifier).sort()).toEqual(['id-check', 'id-save']);
    const order = result.usedBy[0];
    expect(order.places.every((p: any) => Array.isArray(p.snippets) && p.snippets[0].content.startsWith('snippet for'))).toBe(true);
    expect(order.places.some((p: any) => 'objectIdentifier' in p)).toBe(false);
    expect(result.snippetsFetched).toBe(2);
  });

  it('does not fetch snippets unless asked, and never leaks the correlation id', async () => {
    const { handler } = handlers({
      usageReferences: async () => ROWS_ONE_OBJECT,
      usageReferenceSnippets: async () => { throw new Error('should not be called'); }
    });
    const result = answer(await handler.handleImpactOf({ objectName: 'ZCL_APP_RETURN' }));
    expect(result.snippetsFetched).toBeUndefined();
    expect(result.usedBy[0].places.some((p: any) => 'objectIdentifier' in p)).toBe(false);
  });
});

describe('abapPath', () => {
  it('finds a direct caller in one hop', async () => {
    const { handler } = handlers({
      usageReferences: async (url: string) => (url === '/sap/bc/adt/oo/classes/zcl_app_return' ? ROWS : [])
    });
    const result = answer(await handler.handleAbapPath({ toName: 'ZCL_APP_RETURN', fromName: 'ZCL_APP_ORDER' }));
    expect(result.found).toBe(true);
    expect(result.hops).toBe(1);
    expect(result.path.map((n: any) => n.name)).toEqual(['ZCL_APP_ORDER', 'ZCL_APP_RETURN']);
    expect(result.path[0].callsNextVia).toEqual([{ name: 'CHECK', kind: 'method' }, { name: 'SAVE', kind: 'method' }]);
    expect(result.path[1].callsNextVia).toBeUndefined();
  });

  it('finds a two-hop path (BFS, so the shortest one)', async () => {
    const CALLS_ORDER = [
      {
        uri: '/sap/bc/adt/oo/classes/zcl_far_away',
        parentUri: '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZFAR',
        'adtcore:name': 'ZCL_FAR_AWAY',
        'adtcore:type': 'CLAS/OC',
        packageRef: { 'adtcore:name': 'ZFAR' }
      },
      {
        uri: '/sap/bc/adt/oo/classes/zcl_far_away/source/main#type=CLAS%2FOM;name=CALLER',
        parentUri: '/sap/bc/adt/oo/classes/zcl_far_away',
        usageInformation: 'gradeDirect,includeProductive',
        'adtcore:name': 'CALLER',
        'adtcore:type': 'CLAS/OM',
        packageRef: { 'adtcore:name': 'ZFAR' }
      }
    ];
    const { handler } = handlers({
      usageReferences: async (url: string) => {
        if (url === '/sap/bc/adt/oo/classes/zcl_app_return') return ROWS;
        if (url === '/sap/bc/adt/oo/classes/zcl_app_order') return CALLS_ORDER;
        return [];
      }
    });
    const result = answer(await handler.handleAbapPath({ toName: 'ZCL_APP_RETURN', fromName: 'ZCL_FAR_AWAY' }));
    expect(result.found).toBe(true);
    expect(result.hops).toBe(2);
    expect(result.path.map((n: any) => n.name)).toEqual(['ZCL_FAR_AWAY', 'ZCL_APP_ORDER', 'ZCL_APP_RETURN']);
    expect(result.path[0].callsNextVia).toEqual([{ name: 'CALLER', kind: 'method' }]);
  });

  it('reports no path within budget instead of failing', async () => {
    const { handler } = handlers({
      usageReferences: async (url: string) => (url === '/sap/bc/adt/oo/classes/zcl_app_return' ? ROWS : [])
    });
    const result = answer(await handler.handleAbapPath({
      toName: 'ZCL_APP_RETURN', fromName: 'ZCL_NEVER_CALLS_IT', maxDepth: 2
    }));
    expect(result.found).toBe(false);
    expect(result.note).toMatch(/No path found/);
    expect(result.nodesVisited).toBeGreaterThan(0);
  });

  it('answers immediately, with no backend calls, when from and to are the same object', async () => {
    const { handler, asked } = handlers();
    const result = answer(await handler.handleAbapPath({ toName: 'ZCL_APP_RETURN', fromName: 'ZCL_APP_RETURN' }));
    expect(result.found).toBe(true);
    expect(result.hops).toBe(0);
    expect(result.path).toHaveLength(1);
    expect(asked).toHaveLength(0);
  });

  it('says what to pass when the target is missing', async () => {
    const { handler } = handlers();
    await expect(handler.handleAbapPath({ fromName: 'ZCL_APP_ORDER' }))
      .rejects.toThrow(/What is the target object/);
  });

  it('says what to pass when the start is missing', async () => {
    const { handler } = handlers();
    await expect(handler.handleAbapPath({ toName: 'ZCL_APP_RETURN' }))
      .rejects.toThrow(/What is the starting object/);
  });
});

/**
 * Sources shaped like the real thing: a class that calls a helper, a function
 * group whose own source is nothing but INCLUDE lines, and the include that
 * holds the function module body.
 */
const CALLER_SOURCE = [
  'CLASS zcl_app_caller DEFINITION PUBLIC.',
  '  PUBLIC SECTION.',
  '    DATA mo_helper TYPE REF TO zcl_app_helper.',
  'ENDCLASS.',
  'CLASS zcl_app_caller IMPLEMENTATION.',
  '  METHOD run.',
  '    mo_helper->add( 1 ).',
  '    mo_helper->add( 2 ).',
  "    CALL FUNCTION 'Z_APP_SAVE'.",
  '    SELECT * FROM zorders INTO TABLE @DATA(lt_any).',
  '    CALL METHOD (lv_class)=>(lv_method).',
  '    cl_gui_frontend_services=>file_exist( ).',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

const GROUP_MAIN = [
  'FUNCTION-POOL zapp_fg.',
  'INCLUDE lzapp_fgtop.',
  'INCLUDE lzapp_fgu01.'
].join('\n');

const GROUP_INCLUDE = [
  'FUNCTION z_app_save.',
  '  zcl_app_helper=>store( ).',
  'ENDFUNCTION.'
].join('\n');

describe('callsFrom', () => {
  it('reads the source of the object and groups what it calls by target', async () => {
    const read: string[] = [];
    const { handler } = handlers({
      getObjectSource: async (url: string) => { read.push(url); return CALLER_SOURCE; }
    });
    const result = answer(await handler.handleCallsFrom({ objectName: 'zcl_app_caller' }));
    expect(read).toEqual(['/sap/bc/adt/oo/classes/zcl_app_caller/source/main']);
    expect(result.target.object).toBe('ZCL_APP_CALLER (CLAS/OC)');
    const helper = result.calls.find((entry: any) => entry.target === 'ZCL_APP_HELPER');
    expect(helper.calls).toBe(2);
    expect(helper.members).toEqual(['ADD']);
    expect(result.summary.byKind).toMatchObject({ method: 2, function: 1, table: 1 });
    expect(result.standardTargetsHidden).toBe(1);
  });

  it('lists the dynamic call it cannot name instead of leaving the edge out', async () => {
    const { handler } = handlers({ getObjectSource: async () => CALLER_SOURCE });
    const result = answer(await handler.handleCallsFrom({ objectName: 'ZCL_APP_CALLER' }));
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toMatch(/both in variables/);
    expect(result.unresolvedNote).toMatch(/cannot name/);
  });

  it('reads the includes of a function group without being asked, and says which source each call is in', async () => {
    const read: string[] = [];
    const { handler } = handlers({
      getObjectSource: async (url: string) => {
        read.push(url);
        if (url.includes('/includes/lzapp_fgu01')) return GROUP_INCLUDE;
        if (url.includes('/includes/')) return '';
        return GROUP_MAIN;
      }
    });
    const result = answer(await handler.handleCallsFrom({ objectName: 'ZAPP_FG', objectType: 'FUGR/F' }));
    expect(read).toEqual([
      '/sap/bc/adt/functions/groups/zapp_fg/source/main',
      '/sap/bc/adt/functions/groups/zapp_fg/includes/lzapp_fgtop/source/main',
      '/sap/bc/adt/functions/groups/zapp_fg/includes/lzapp_fgu01/source/main'
    ]);
    const helper = result.calls.find((entry: any) => entry.target === 'ZCL_APP_HELPER');
    expect(helper.places[0].source).toBe('LZAPP_FGU01');
    expect(result.sourcesScanned.map((entry: any) => entry.name)).toEqual(['ZAPP_FG', 'LZAPP_FGTOP', 'LZAPP_FGU01']);
  });

  it('falls back to the report include collection when the group does not serve one, and reports one it cannot read', async () => {
    const read: string[] = [];
    const { handler } = handlers({
      getObjectSource: async (url: string) => {
        read.push(url);
        if (url.includes('/functions/groups/zapp_fg/includes/')) throw new Error('404 not found');
        if (url.includes('/programs/includes/lzapp_fgu01')) return GROUP_INCLUDE;
        if (url.includes('/programs/includes/')) throw new Error('404 not found');
        return GROUP_MAIN;
      }
    });
    const result = answer(await handler.handleCallsFrom({ objectName: 'ZAPP_FG', objectType: 'FUGR/F' }));
    expect(read).toContain('/sap/bc/adt/programs/includes/lzapp_fgu01/source/main');
    expect(result.calls.some((entry: any) => entry.target === 'ZCL_APP_HELPER')).toBe(true);
    expect(result.includesUnread.map((entry: any) => entry.name)).toEqual(['LZAPP_FGTOP']);
  });

  it('leaves the includes of a program alone unless asked, and says so when nothing was found', async () => {
    const read: string[] = [];
    const { handler } = handlers({
      getObjectSource: async (url: string) => { read.push(url); return 'REPORT zr_app.\nINCLUDE zr_app_f01.'; }
    });
    const result = answer(await handler.handleCallsFrom({ objectName: 'ZR_APP', objectType: 'PROG/P', kinds: ['method'] }));
    expect(read).toHaveLength(1);
    expect(result.calls).toHaveLength(0);
    expect(result.emptyNote).toMatch(/followIncludes/);
  });

  it('keeps the standard targets when asked to', async () => {
    const { handler } = handlers({ getObjectSource: async () => CALLER_SOURCE });
    const result = answer(await handler.handleCallsFrom({ objectName: 'ZCL_APP_CALLER', onlyCustom: false }));
    expect(result.calls.some((entry: any) => entry.target === 'CL_GUI_FRONTEND_SERVICES')).toBe(true);
    expect(result.standardTargetsHidden).toBeUndefined();
  });

  it('rejects a kind that does not exist, naming the ones that do', async () => {
    const { handler } = handlers();
    await expect(handler.handleCallsFrom({ objectName: 'ZCL_APP_CALLER', kinds: ['methods'] }))
      .rejects.toThrow(/not one of method, constructor/);
  });

  it('says what to pass when nothing names the object', async () => {
    const { handler } = handlers();
    await expect(handler.handleCallsFrom({})).rejects.toThrow(/Whose calls\?/);
  });

  it('says so when the type has no source to read', async () => {
    const { handler } = handlers();
    await expect(handler.handleCallsFrom({ objectName: 'ZAPP_DOMAIN', objectType: 'DOMA/DD' }))
      .rejects.toThrow(/No ADT source is served for a DOMA\/DD/);
  });

  it('scans a source URL on its own, taking the name from it', async () => {
    const { handler } = handlers({ getObjectSource: async () => CALLER_SOURCE });
    const result = answer(await handler.handleCallsFrom({
      sourceUrl: '/sap/bc/adt/programs/programs/zr_app_daily/source/main'
    }));
    expect(result.target.object).toBe('ZR_APP_DAILY');
    expect(result.calls.length).toBeGreaterThan(0);
  });
});
