import { AdtErrorException } from 'abap-adt-api';
import { DdicHandlers } from '../handlers/DdicHandlers';
import { FeedHandlers } from '../handlers/FeedHandlers';
import { NodeHandlers } from '../handlers/NodeHandlers';
import { UnitTestHandlers } from '../handlers/UnitTestHandlers';
import { pageNodes, trimNode } from '../lib/nodePage';
import { isMissingCollection } from '../lib/adtError';

/**
 * The read-only tools no smoke run had ever called, and what a live run found
 * in them on a classic ERP system:
 *
 *  - nodeContents answers a whole level at once: SABAPDEMOS holds 802 nodes
 *    and 238,596 characters, past the response cap, and every node writes the
 *    same SAPGUI bridge URI twice;
 *  - dumps answers six entries in 61,644 characters, because each carries its
 *    whole ST22 page;
 *  - ddicElement answers an empty shell with status 200 for a data element,
 *    for a domain and for a name that does not exist alike - while answering
 *    T000 with its 17 fields;
 *  - unitTestEvaluation without a class read testmethods off undefined, and
 *    the TypeError left as a transport error.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const rawNode = (over: any = {}) => ({
  OBJECT_TYPE: 'CLAS/OC',
  OBJECT_NAME: 'CL_ONE',
  TECH_NAME: 'CL_ONE',
  OBJECT_URI: '/sap/bc/adt/vit/wb/object_type/clasoc/object_name/CL_ONE',
  OBJECT_VIT_URI: '/sap/bc/adt/vit/wb/object_type/clasoc/object_name/CL_ONE',
  EXPANDABLE: '',
  DESCRIPTION: '',
  ...over
});

const contents = (nodes: any[]) => ({
  categories: [{ CATEGORY: '<none>', CATEGORY_LABEL: 'Others' }],
  objectTypes: [{ OBJECT_TYPE: 'CLAS/OC', OBJECT_TYPE_LABEL: 'Classes', NODE_ID: 1 }],
  nodes
});

describe('one level of the repository tree, cut down', () => {
  it('drops the URI written twice and the fields that are empty', () => {
    expect(trimNode(rawNode())).toEqual({
      type: 'CLAS/OC',
      name: 'CL_ONE',
      uri: '/sap/bc/adt/vit/wb/object_type/clasoc/object_name/CL_ONE'
    });
    expect(trimNode(rawNode({ TECH_NAME: 'CL_ONE=======CP', DESCRIPTION: 'A class', EXPANDABLE: 'X' })))
      .toMatchObject({ techName: 'CL_ONE=======CP', description: 'A class', expandable: true });
  });

  it('counts the whole level by type and returns one page of it', () => {
    const nodes = [
      ...Array.from({ length: 150 }, (_, i) => rawNode({ OBJECT_NAME: `CL_${i}` })),
      ...Array.from({ length: 30 }, (_, i) => rawNode({ OBJECT_TYPE: 'PROG/P', OBJECT_NAME: `Z_${i}` }))
    ];
    const page = pageNodes(contents(nodes));
    expect(page.counts.nodes).toBe(180);
    expect(page.counts.byType).toEqual({ 'CLAS/OC': 150, 'PROG/P': 30 });
    expect(page.returned).toBe(100);
    expect(page.more).toBe(true);
    const programs = pageNodes(contents(nodes), { objectType: 'prog/p' });
    expect(programs.total).toBe(30);
    expect(programs.more).toBe(false);
    expect(programs.counts.nodes).toBe(180);
  });

  it('says an empty level is indistinguishable from a package that is not there', async () => {
    const handlers = new NodeHandlers({ nodeContents: async () => contents([]) } as any);
    const payload = answer(await handlers.handle('nodeContents', { parent_type: 'DEVC/K', parent_name: 'NOPE' }));
    expect(payload.total).toBe(0);
    expect(payload.hint).toContain('unknown package answers exactly like an empty one');
  });

  it('shrinks a level that would not fit through the response cap', async () => {
    const nodes = Array.from({ length: 802 }, (_, i) => rawNode({ OBJECT_NAME: `OBJ_${i}` }));
    const handlers = new NodeHandlers({ nodeContents: async () => contents(nodes) } as any);
    const payload = answer(await handlers.handle('nodeContents', {
      parent_type: 'DEVC/K', parent_name: 'SABAPDEMOS', maxResults: 20
    }));
    expect(payload.counts.nodes).toBe(802);
    expect(payload.returned).toBe(20);
    expect(payload.hint).toContain('offset=20');
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(contents(nodes)).length / 5);
  });
});

describe('dumps without their pages', () => {
  const dump = (index: number) => ({
    id: `dump-${index}`,
    author: 'TESTER',
    type: 'E',
    links: [{ href: `adt://EUD/dump/${index}` }],
    categories: [
      { term: 'GETWA_NOT_ASSIGNED', label: 'ABAP runtime error' },
      { term: 'CL_SOMETHING=========CP', label: 'Terminated ABAP program' }
    ],
    text: 'x'.repeat(11739)
  });
  const feed = (count: number) => ({ href: '/sap/bc/adt/runtime/dumps', title: 'Dumps', dumps: Array.from({ length: count }, (_, i) => dump(i)) });

  it('keeps the header and leaves out the ST22 page', async () => {
    const handlers = new FeedHandlers({ dumps: async () => feed(6) } as any);
    const payload = answer(await handlers.handle('dumps', {}));
    expect(payload.count).toBe(6);
    expect(payload.returned).toBe(6);
    expect(payload.dumps.dumps[0]).toMatchObject({
      runtimeError: 'GETWA_NOT_ASSIGNED',
      program: 'CL_SOMETHING=========CP',
      textChars: 11739
    });
    expect(payload.dumps.dumps[0].text).toBeUndefined();
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(feed(6)).length / 10);
  });

  it('hands over the pages when they are what is wanted, and caps the count', async () => {
    const handlers = new FeedHandlers({ dumps: async () => feed(20) } as any);
    const full = answer(await handlers.handle('dumps', { full: true, max: 2 }));
    expect(full.returned).toBe(2);
    expect(full.more).toBe(true);
    expect(full.dumps.dumps[0].text.length).toBe(11739);
    expect(full.hint).toBeUndefined();
  });
});

describe('ddicElement answers for entities with fields, and only for those', () => {
  const handlers = (result: any) => new DdicHandlers({ ddicElement: async () => result } as any);

  it('reports the fields of a table', async () => {
    const payload = answer(await handlers({
      type: 'TABL/DT',
      name: 't000',
      properties: { elementProps: false, annotations: [] },
      children: [{ type: 'TABL/DTF', name: 'mandt', properties: {}, children: [] }]
    }).handle('ddicElement', { path: 'T000' }));
    expect(payload).toMatchObject({ found: true, fields: 1 });
    expect(payload.result.name).toBe('t000');
  });

  it('says so when the answer is the empty shell a data element gets', async () => {
    const payload = answer(await handlers({
      properties: { elementProps: false, annotations: [] },
      children: []
    }).handle('ddicElement', { path: 'WERKS_D' }));
    expect(payload.found).toBe(false);
    expect(payload.result).toBeUndefined();
    expect(payload.hint).toContain('getDataElementProperties');
  });
});

describe('the answers that are not answers', () => {
  it('refuses unitTestEvaluation without a class instead of reading testmethods off undefined', async () => {
    const handlers = new UnitTestHandlers({ unitTestEvaluation: async () => [] } as any);
    await expect(handlers.handle('unitTestEvaluation', {})).rejects.toThrow(/Pass clas/);
  });

  it('knows a collection that is absent from one that is empty', () => {
    // What abapGit answers on a system without the plugin, as it arrives.
    const absent = new AdtErrorException(
      404,
      {},
      'ExceptionResourceNotFound',
      'Resource  /sap/bc/adt/abapgit/repos does not exist.',
      undefined,
      'com.sap.adt',
      'Resource  /sap/bc/adt/abapgit/repos does not exist.'
    );
    expect(isMissingCollection(absent)).toBe(true);
    const refused = new AdtErrorException(
      403, {}, 'ExceptionSecurity', 'Not authorised', undefined, 'com.sap.adt', 'Not authorised'
    );
    expect(isMissingCollection(refused)).toBe(false);
    expect(isMissingCollection(new Error('connect ETIMEDOUT'))).toBe(false);
  });
});
