import { CodeAnalysisHandlers } from '../handlers/CodeAnalysisHandlers';
import { cursorAt } from '../lib/symbolPosition';
import { pageUsages, summariseUsages, snippetableReferences, trimUsageRow } from '../lib/usageReferences';

/**
 * What the navigation family does when it is pointed at the wrong place, and
 * what a where-used answer costs. Measured live on a classic ERP system and
 * held here:
 *
 *  - usageReferences answers with the whole tree and no paging of its own -
 *    40,660 rows and 21 million characters for CL_ABAP_TYPEDESCR, a hundred
 *    times the response cap;
 *  - only the rows carrying objectIdentifier are usage sites, and
 *    usageReferenceSnippets silently drops every row without one;
 *  - findDefinition answers a cursor on blank space with an empty URL and
 *    status 200, and a line out by one with a confident answer about a
 *    different object;
 *  - codeCompletion answers a position outside the source with an empty list.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const SOURCE = [
  'CLASS zcl_probe IMPLEMENTATION.',
  '  METHOD run.',
  '    CALL METHOD cl_abap_elemdescr=>load_class.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

const usageRow = (over: any = {}) => ({
  uri: '/sap/bc/adt/oo/classes/zcl_caller',
  objectIdentifier: '',
  parentUri: '/sap/bc/adt/packages/ztest',
  isResult: false,
  canHaveChildren: false,
  usageInformation: 'gradeDirect,includeProductive',
  'adtcore:responsible': 'SAP',
  'adtcore:name': 'ZCL_CALLER',
  'adtcore:type': 'CLAS/OC',
  'adtcore:description': 'A caller, with a description nobody asked for',
  packageRef: { 'adtcore:uri': '/sap/bc/adt/packages/ztest', 'adtcore:name': 'ZTEST' },
  ...over
});

describe('cursorAt checks a position against the source it came with', () => {
  it('names the token under the cursor, and the one the cursor sits just after', () => {
    expect(cursorAt(SOURCE, 3, 16).token).toBe('cl_abap_elemdescr');
    expect(cursorAt(SOURCE, 3, 33).token).toBe('cl_abap_elemdescr');
    expect(cursorAt(SOURCE, 3, 16).problem).toBeUndefined();
  });

  it('refuses a line outside the source and says how lines are counted', () => {
    const outside = cursorAt(SOURCE, 99, 0);
    expect(outside.outside).toBe(true);
    expect(outside.problem).toContain('has 5 lines');
    expect(outside.problem).toContain('count from 1');
    expect(cursorAt(SOURCE, 0, 0).outside).toBe(true);
  });

  it('refuses a column past the end of its line, counting from 0', () => {
    const outside = cursorAt(SOURCE, 2, 999);
    expect(outside.outside).toBe(true);
    expect(outside.problem).toContain('count from 0');
  });

  it('reports blank space as not-a-name without calling it outside the source', () => {
    const blank = cursorAt(SOURCE, 3, 0);
    expect(blank.outside).toBeUndefined();
    expect(blank.token).toBeUndefined();
    expect(blank.problem).toContain('not on a name');
  });
});

describe('where-used rows are summarised and paged', () => {
  const rows = [
    usageRow({ 'adtcore:name': 'ZCL_A', objectIdentifier: 'ABAPFullName;ZCL_A;1' }),
    usageRow({ 'adtcore:name': 'ZCL_B', 'adtcore:type': 'CLAS/OM' }),
    usageRow({
      'adtcore:name': 'ZTEST2',
      'adtcore:type': 'DEVC/K',
      packageRef: { 'adtcore:uri': '/x', 'adtcore:name': 'ZTEST2' }
    })
  ];

  it('trims a row to what identifies it and what the next call needs', () => {
    const trimmed = trimUsageRow(usageRow({ objectIdentifier: 'ABAPFullName;ZCL_A;1' }) as any);
    expect(trimmed).toEqual({
      name: 'ZCL_CALLER',
      type: 'CLAS/OC',
      package: 'ZTEST',
      uri: '/sap/bc/adt/oo/classes/zcl_caller',
      objectIdentifier: 'ABAPFullName;ZCL_A;1',
      usage: 'gradeDirect,includeProductive'
    });
    expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(usageRow()).length / 2);
  });

  it('counts the whole answer, not the page', () => {
    const summary = summariseUsages(rows as any);
    expect(summary).toMatchObject({ total: 3, usageSites: 1, objects: 3, packages: 2 });
    expect(summary.byType).toEqual({ 'CLAS/OC': 1, 'CLAS/OM': 1, 'DEVC/K': 1 });
    expect(summary.topPackages[0]).toEqual({ name: 'ZTEST', rows: 2 });
  });

  it('pages, and says when more follows', () => {
    const first = pageUsages(rows as any, { maxResults: 2 });
    expect(first.returned).toBe(2);
    expect(first.more).toBe(true);
    expect(first.summary.total).toBe(3);
    const second = pageUsages(rows as any, { maxResults: 2, offset: 2 });
    expect(second.returned).toBe(1);
    expect(second.more).toBe(false);
  });

  it('keeps only the usage sites when asked, the summary still covering everything', () => {
    const sites = pageUsages(rows as any, { onlyWithSnippets: true });
    expect(sites.returned).toBe(1);
    expect(sites.rows[0].objectIdentifier).toBe('ABAPFullName;ZCL_A;1');
    expect(sites.summary.total).toBe(3);
  });

  it('keeps only references a snippet request can be built from', () => {
    expect(snippetableReferences(rows).length).toBe(1);
    expect(snippetableReferences(undefined)).toEqual([]);
  });
});

describe('the handlers, against a client that answers like the backend does', () => {
  const handlers = (client: any) => new CodeAnalysisHandlers(client as any);

  it('summarises a where-used answer instead of handing over the whole tree', async () => {
    const rows = Array.from({ length: 250 }, (_, index) =>
      usageRow({
        'adtcore:name': `ZCL_${index}`,
        objectIdentifier: index % 2 === 0 ? `ABAPFullName;ZCL_${index};1` : ''
      }));
    const result = await handlers({ usageReferences: async () => rows })
      .handle('usageReferences', { url: '/sap/bc/adt/oo/classes/zcl_probe' });
    const payload = answer(result);
    expect(payload.summary.total).toBe(250);
    expect(payload.summary.usageSites).toBe(125);
    expect(payload.returned).toBe(100);
    expect(payload.more).toBe(true);
    expect(payload.hint).toContain('offset=100');
    expect(payload.snippetsHint).toContain('125 of the 250');
    // The point of the exercise: the answer is a fraction of the raw tree.
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(rows).length / 3);
  });

  it('refuses snippet rows that carry no identifier, and says which ones would', async () => {
    const client = { usageReferenceSnippets: async () => [] };
    await expect(handlers(client).handle('usageReferenceSnippets', { references: [usageRow()] }))
      .rejects.toThrow(/onlyWithSnippets/);
    await expect(handlers(client).handle('usageReferenceSnippets', { references: [] }))
      .rejects.toThrow(/references is empty/);
  });

  it('asks only for the rows that can answer, and says how many it ignored', async () => {
    let asked: any[] = [];
    const client = {
      usageReferenceSnippets: async (references: any[]) => { asked = references; return [{ snippets: [] }]; }
    };
    const result = await handlers(client).handle('usageReferenceSnippets', {
      references: [usageRow(), usageRow({ objectIdentifier: 'ABAPFullName;ZCL_A;1' })]
    });
    expect(asked.length).toBe(1);
    expect(answer(result)).toMatchObject({ asked: 1, ignored: 1 });
  });

  it('refuses a findDefinition position that is not on a name', async () => {
    const client = { findDefinition: async () => ({ url: '/x', line: 1, column: 0 }) };
    await expect(handlers(client).handle('findDefinition', {
      url: '/sap/bc/adt/oo/classes/zcl_probe/source/main', source: SOURCE, line: 3, startCol: 0, endCol: 1
    })).rejects.toThrow(/not on a name/);
    await expect(handlers(client).handle('findDefinition', {
      url: '/sap/bc/adt/oo/classes/zcl_probe/source/main', source: SOURCE, line: 400, startCol: 4, endCol: 8
    })).rejects.toThrow(/outside the source/);
  });

  it('says found: false for the empty URL the backend answers 200 with', async () => {
    const client = { findDefinition: async () => ({ url: '', line: 0, column: 0 }) };
    const payload = answer(await handlers(client).handle('findDefinition', {
      url: '/sap/bc/adt/oo/classes/zcl_probe/source/main', source: SOURCE, line: 3, startCol: 16, endCol: 33
    }));
    expect(payload.found).toBe(false);
    expect(payload.result).toBeUndefined();
    expect(payload.at).toBe('cl_abap_elemdescr');
    expect(payload.hint).toContain('out by one');
  });

  it('quotes the name it resolved when it does find one', async () => {
    const client = {
      findDefinition: async () => ({ url: '/sap/bc/adt/oo/classes/cl_abap_elemdescr/source/main', line: 1, column: 6 })
    };
    const payload = answer(await handlers(client).handle('findDefinition', {
      url: '/sap/bc/adt/oo/classes/zcl_probe/source/main', source: SOURCE, line: 3, startCol: 16, endCol: 33
    }));
    expect(payload).toMatchObject({ found: true, at: 'cl_abap_elemdescr' });
    expect(payload.result.url).toContain('cl_abap_elemdescr');
  });

  it('reads the whole source itself when none is passed, and says where it came from', async () => {
    let read = 0;
    const client = {
      getObjectSource: async () => { read++; return SOURCE; },
      findDefinition: async (_url: string, source: string) => ({
        url: source === SOURCE ? '/sap/bc/adt/oo/classes/cl_abap_elemdescr/source/main' : '',
        line: 1,
        column: 6
      })
    };
    const payload = answer(await handlers(client).handle('findDefinition', {
      url: '/sap/bc/adt/oo/classes/zcl_probe_uncached/source/main', line: 3, startCol: 16, endCol: 33
    }));
    expect(read).toBe(1);
    expect(payload).toMatchObject({ found: true, sourceFrom: 'server' });
  });

  it('marks a source that came with the call, since that one may be a page of the real thing', async () => {
    const client = { codeCompletion: async () => [] };
    const payload = answer(await handlers(client).handle('codeCompletion', {
      sourceUrl: '/x/source/main', source: SOURCE, line: 3, column: 10
    }));
    expect(payload.sourceFrom).toBe('argument');
  });

  it('refuses a completion position outside the source but allows one on blank space', async () => {
    const client = { codeCompletion: async () => [{ KIND: 2, IDENTIFIER: 'LOAD_CLASS' }] };
    await expect(handlers(client).handle('codeCompletion', {
      sourceUrl: '/x/source/main', source: SOURCE, line: 3, column: 999
    })).rejects.toThrow(/outside line 3/);
    const payload = answer(await handlers(client).handle('codeCompletion', {
      sourceUrl: '/x/source/main', source: SOURCE, line: 3, column: 0
    }));
    expect(payload.proposals).toBe(1);
    expect(payload.hint).toContain('patternKey');
  });

  it('says what an empty proposal list means rather than leaving it bare', async () => {
    const payload = answer(await handlers({ codeCompletion: async () => [] }).handle('codeCompletion', {
      sourceUrl: '/x/source/main', source: SOURCE, line: 3, column: 10
    }));
    expect(payload.proposals).toBe(0);
    expect(payload.hint).toContain('does not parse');
  });

  it('refuses a blank patternKey instead of letting the backend raise an exception', async () => {
    const client = { codeCompletionFull: async () => 'load_class' };
    await expect(handlers(client).handle('codeCompletionFull', {
      sourceUrl: '/x/source/main', source: SOURCE, line: 3, column: 10, patternKey: '  '
    })).rejects.toThrow(/IDENTIFIER of the proposal/);
    const payload = answer(await handlers(client).handle('codeCompletionFull', {
      sourceUrl: '/x/source/main', source: SOURCE, line: 3, column: 10, patternKey: 'LOAD_CLASS'
    }));
    expect(payload.result).toBe('load_class');
  });
});
