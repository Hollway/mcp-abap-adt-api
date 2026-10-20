import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SapGraphHandlers } from '../handlers/SapGraphHandlers';
import { closeGraphs, graphFileFor, graphStore } from '../lib/sapGraph';
import { sourceCache } from '../lib/sourceCache';
import { fakeSql } from './helpers/fakeSql';
import { graphTables, graphSources } from './helpers/graphFixture';

const saved = { ...process.env };
let dir: string;

const client = (tables = graphTables()) => {
  const sql = fakeSql(tables);
  const read: string[] = [];
  const stateless = {
    runQuery: async (query: string, rowNumber: number) => ({ columns: [], values: await sql.rows(query, rowNumber) }),
    getObjectSource: async (url: string) => {
      read.push(url);
      const source = graphSources[url];
      if (source === undefined) throw new Error(`404 ${url}`);
      return source;
    }
  };
  return { sql, read, adt: { baseUrl: 'https://sap.example/DEV00', client: '100', language: 'RU', statelessClone: stateless } as any };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapgraph-handlers-'));
  process.env.SAP_GRAPH_DIR = dir;
  process.env.SAP_GRAPH_MAX_AGE_MIN = '60';
});
afterEach(() => {
  closeGraphs();
  process.env = { ...saved };
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the WAL may linger on Windows */ }
});

describe('sapGraphSync and sapGraphExplore', () => {
  it('says there is no graph yet, and how to get one', async () => {
    const answer = await new SapGraphHandlers(client().adt).exploreCore({ names: ['ZCL_A'] });
    expect(answer.status).toBe('empty');
    expect(answer.hint).toMatch(/mode full/);
  });

  it('loads the graph and reports what it holds', async () => {
    const handlers = new SapGraphHandlers(client().adt);
    const answer: any = await handlers.syncCore({ wait: 30 });
    expect(answer.status).toBe('success');
    expect(answer.note).toMatch(/full load/);
    expect(answer.load.result.mode).toBe('full');
    expect(answer.graph.counts.edges).toBeGreaterThan(10);
    expect(answer.graph.file).toBe(graphFileFor('https://sap.example/DEV00', '100'));

    const status: any = await handlers.syncCore({ mode: 'status' });
    expect(status.graph.lastSyncAt).toBeDefined();
  });

  it('answers who calls a method with the code of the method and of the calling places', async () => {
    sourceCache.clear();
    const { adt, read } = client();
    const handlers = new SapGraphHandlers(adt);
    await handlers.syncCore({ wait: 30 });
    const answer: any = await handlers.exploreCore({ names: ['ZCL_A=>GET_BUKRS'] });

    expect(answer.matched[0]).toMatchObject({ name: 'ZCL_A=>GET_BUKRS', kind: 'method', package: 'ZPK1', text: 'Балансовая единица по заводу' });
    expect(answer.results[0].callers.map((caller: any) => caller.name)).toEqual(['ZCL_A=>RUN', 'ZCL_B=>EXECUTE', 'ZR_REP_F01']);
    expect(answer.results[0].callees).toBeUndefined();

    const sources = answer.sources.map((source: any) => `${source.role}|${source.of}|${source.blocks[0].title}|${source.blocks[0].hits}`);
    expect(sources).toEqual([
      'asked|ZCL_A=>GET_BUKRS|METHOD get_bukrs|',
      'caller of ZCL_A=>GET_BUKRS|ZCL_A=>RUN|METHOD run|11',
      'caller of ZCL_A=>GET_BUKRS|ZCL_B=>EXECUTE|METHOD execute|4',
      'caller of ZCL_A=>GET_BUKRS|ZR_REP_F01|FORM read_data|3'
    ]);
    // The class source is read once for the method and its caller in the same class.
    expect(read.filter(url => url.includes('zcl_a')).length).toBe(1);
  });

  it('finds existing logic by its description and by what it uses', async () => {
    const handlers = new SapGraphHandlers(client().adt);
    await handlers.syncCore({ wait: 30 });
    const found: any = await handlers.exploreCore({ search: 'балансовая единица завода', withSource: false });
    expect(found.search.hits[0]).toMatchObject({ name: 'ZCL_A=>GET_BUKRS', usedBy: 3 });

    const shared: any = await handlers.exploreCore({ usesAll: ['ZCL_A=>GET_BUKRS', 'BAPI_PO_CREATE1'], withSource: false });
    expect(shared.usesAll.callers.map((caller: any) => caller.name).sort()).toEqual(['ZCL_A=>RUN', 'ZR_REP_F01']);
  });

  it('lists what a report reaches and cuts long lists, saying so', async () => {
    const handlers = new SapGraphHandlers(client().adt);
    await handlers.syncCore({ wait: 30 });
    const answer: any = await handlers.exploreCore({ names: ['ZR_REP'], direction: 'callees', maxResults: 2 });
    expect(answer.results[0].calleeCount).toBe(5);
    expect(answer.results[0].callees).toHaveLength(2);
    expect(answer.results[0].standardCalleesHidden).toBe(1);
    expect(answer.truncated).toEqual({ 'callees of ZR_REP': 5 });
  });

  it('walks several levels, counting each one and sharing the list between them', async () => {
    const handlers = new SapGraphHandlers(client().adt);
    await handlers.syncCore({ wait: 30 });
    const answer: any = await handlers.exploreCore({ names: ['ZCL_B=>EXECUTE'], depth: 3, withSource: false });
    expect(answer.results[0].callersByDepth).toEqual({ 1: 1, 2: 1 });
    expect(answer.results[0].callers.map((entry: any) => `${entry.depth}:${entry.name}<-${entry.via}`)).toEqual([
      '1:Z_FM_READ<-ZCL_B=>EXECUTE', '2:ZR_REP<-Z_FM_READ'
    ]);
  });

  it('brings an old graph up to date before answering', async () => {
    const tables = graphTables();
    const { adt, sql } = client(tables);
    const handlers = new SapGraphHandlers(adt);
    await handlers.syncCore({ wait: 30 });
    const writer = graphStore(graphFileFor(adt.baseUrl, adt.client)).writer();
    writer.setMeta('lastSyncAt', new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    writer.close();

    const include = tables.reposrc.find(row => row.PROGNAME === 'ZR_REP_F01')!;
    include.UDAT = '20261002';
    tables.wbcrossgt = tables.wbcrossgt.filter(row => row.INCLUDE !== 'ZR_REP_F01');
    const before = sql.statements.length;

    const answer: any = await handlers.exploreCore({ names: ['ZCL_A=>GET_BUKRS'], withSource: false });
    expect(sql.statements.length).toBeGreaterThan(before);
    expect(answer.graph.refreshed).toMatch(/1 changed object/);
    expect(answer.results[0].callers.map((caller: any) => caller.name)).toEqual(['ZCL_A=>RUN', 'ZCL_B=>EXECUTE']);
  });

  it('refuses a question about nothing and a direction it does not know', async () => {
    const handlers = new SapGraphHandlers(client().adt);
    await expect(handlers.exploreCore({})).rejects.toThrow(/names, search or usesAll/);
    await expect(handlers.exploreCore({ names: ['ZCL_A'], direction: 'up' })).rejects.toThrow(/direction/);
    await expect(handlers.syncCore({ mode: 'all' })).rejects.toThrow(/mode/);
  });
});
