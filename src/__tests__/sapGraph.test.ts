import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ownerOfInclude, sourcePartOf, parseGtName, crossTarget, ftsQuery, normalizeText, languageKey, methodIndexOf, isCustomerName
} from '../lib/sapGraph/names';
import { GraphStore } from '../lib/sapGraph/store';
import { fullSync, deltaSync, batchedSql, ownerStatements, changeStamp } from '../lib/sapGraph/sync';
import { GraphExplorer } from '../lib/sapGraph/explore';
import { methodBlock, blocksNaming, sourceUrlOf, linesNaming } from '../lib/sapGraph/source';
import { graphFileFor, foreignLoad, startLoad, waitFor, closeGraphs, graphStore } from '../lib/sapGraph';
import { fakeSql } from './helpers/fakeSql';
import { extractCallsAcross, groupCalls } from '../lib/abapCalls';
import { SourceSearchHandlers } from '../handlers/SourceSearchHandlers';
import { graphTables, classInclude } from './helpers/graphFixture';

const options = { prefixes: ['Z', 'Y'], languages: ['R', 'E'] };

let dir: string;
const tempFile = (name = 'graph.db') => path.join(dir, name);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapgraph-')); });
afterEach(() => {
  closeGraphs();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL a moment longer */ }
});

describe('include names', () => {
  it('reads a method include of a class, counting methods in base 36', () => {
    expect(ownerOfInclude(classInclude('ZCL_A', 'CM00A'))).toEqual({ object: 'ZCL_A', objectType: 'CLAS', part: 'CM00A', methodIndex: 10 });
    expect(methodIndexOf('010')).toBe(36);
  });

  it('reads a class whose name fills all 30 characters', () => {
    const owner = ownerOfInclude('ZCL_A_CLASS_NAME_OF_30_LETTERSCM001');
    expect(owner.object).toBe('ZCL_A_CLASS_NAME_OF_30_LETTERS');
    expect(owner.methodIndex).toBe(1);
  });

  it('tells the sections, local parts and interfaces apart', () => {
    expect(sourcePartOf(ownerOfInclude(classInclude('ZCL_A', 'CU')))).toBe('definition');
    expect(sourcePartOf(ownerOfInclude(classInclude('ZCL_A', 'CCIMP')))).toBe('local');
    expect(ownerOfInclude(classInclude('ZIF_C', 'IU')).objectType).toBe('INTF');
  });

  it('reads function group includes and their main program', () => {
    expect(ownerOfInclude('LZFGU01')).toEqual({ object: 'ZFG', objectType: 'FUGR', part: 'U01', functionInclude: '01' });
    expect(sourcePartOf(ownerOfInclude('LZFGTOP'))).toBe('functionGroup');
    expect(ownerOfInclude('SAPLZFG')).toEqual({ object: 'ZFG', objectType: 'FUGR', part: 'SAPL' });
  });

  it('keeps a program a program, even one starting with L', () => {
    expect(ownerOfInclude('ZR_REP_F01')).toEqual({ object: 'ZR_REP_F01', objectType: 'PROG', part: '' });
    expect(ownerOfInclude('LIST_USERS').objectType).toBe('PROG');
  });
});

describe('index names', () => {
  it('reads a method, an interface method through a class and a local class method', () => {
    expect(parseGtName('ZCL_A\\ME:GET_BUKRS')).toEqual({ object: 'ZCL_A', member: 'GET_BUKRS' });
    expect(parseGtName('CX_ROOT\\IN:IF_MESSAGE\\ME:GET_LONGTEXT')).toEqual({ object: 'CX_ROOT', member: 'IF_MESSAGE~GET_LONGTEXT' });
    expect(parseGtName('\\PR:ZR_REP\\CL:LCL_APP\\ME:RUN')).toEqual({ object: 'ZR_REP', member: 'LCL_APP=>RUN', local: true });
  });

  it('flags a method parameter and leaves a global type whole', () => {
    expect(parseGtName('ZCL_A\\ME:GET_BUKRS\\DA:IV_WERKS').parameter).toBe(true);
    expect(parseGtName('ZTAB')).toEqual({ object: 'ZTAB' });
  });

  it('reads a PERFORM and a message from CROSS', () => {
    expect(crossTarget('U', 'READ_DATA', 'ZR_OTHER')).toEqual({ object: 'ZR_OTHER', member: 'READ_DATA' });
    expect(crossTarget('N', 'SBDS                349', '')).toEqual({ object: 'SBDS', member: '349' });
  });

  it('knows customer names', () => {
    expect(isCustomerName('ZCL_A')).toBe(true);
    expect(isCustomerName('/ARM/CL_X')).toBe(true);
    expect(isCustomerName('CL_ABAP_TYPEDESCR')).toBe(false);
  });
});

describe('search text', () => {
  it('folds ё and splits names into words', () => {
    expect(normalizeText('Пересчёт ZCL_MM=>GET_BUKRS')).toBe('пересчет zcl mm get bukrs');
  });

  it('quotes every word as a prefix term', () => {
    expect(ftsQuery('цена "OR" завод')).toBe('"цен"* "or"* "завод"*');
    expect(ftsQuery('цены завод', 'any')).toBe('"цен"* OR "завод"*');
    expect(ftsQuery('балансовая единица prices')).toBe('"балансов"* "единиц"* "price"*');
    expect(ftsQuery('  ')).toBeUndefined();
  });

  it('maps a logon language to its SPRAS key', () => {
    expect(languageKey('RU')).toBe('R');
    expect(languageKey('E')).toBe('E');
    expect(languageKey(undefined)).toBe('E');
  });
});

describe('statements', () => {
  it('batches conditions under 255 characters', () => {
    const terms = Array.from({ length: 40 }, (_, i) => `obj_name = 'ZCL_SOME_RATHER_LONG_NAME_${i}'`);
    const statements = batchedSql('SELECT object, obj_name FROM tadir WHERE ', terms, " AND pgmid = 'R3TR'");
    expect(statements.length).toBeGreaterThan(1);
    for (const sql of statements) expect(sql.length).toBeLessThanOrEqual(255);
    expect(statements.join(' ').match(/obj_name =/g)).toHaveLength(40);
  });

  it('reads a change date however the data preview hands it over', () => {
    // In process a DATS column arrives as a Date at UTC midnight.
    expect(changeStamp({ UDAT: new Date(Date.UTC(2019, 4, 3)), UTIME: '094850' })).toBe('20190503094850');
    expect(changeStamp({ UDAT: '2019-05-03T00:00:00.000Z', UTIME: '094850' })).toBe('20190503094850');
    expect(changeStamp({ UDAT: '20190503', UTIME: '09:48:50' })).toBe('20190503094850');
    expect(changeStamp({ UDAT: '00000000', UTIME: '000000' })).toBeNull();
    expect(changeStamp({ UDAT: new Date('invalid'), UTIME: '' })).toBeNull();
  });

  it('selects each owner with one LIKE, and programs together - an OR of LIKEs reads the whole table', () => {
    const statements = ownerStatements('SELECT otype FROM wbcrossgt WHERE ', [
      { objectType: 'CLAS', object: 'ZCL_A' }, { objectType: 'FUGR', object: 'ZFG' },
      { objectType: 'PROG', object: 'ZR_REP' }, { objectType: 'PROG', object: 'ZR_REP_F01' }
    ]);
    expect(statements).toEqual([
      `SELECT otype FROM wbcrossgt WHERE include LIKE '${classInclude('ZCL_A', '')}%'`,
      "SELECT otype FROM wbcrossgt WHERE include LIKE 'LZFG___'",
      "SELECT otype FROM wbcrossgt WHERE include IN ( 'SAPLZFG', 'ZR_REP', 'ZR_REP_F01' )"
    ]);
    const many = ownerStatements('SELECT otype FROM wbcrossgt WHERE ', Array.from({ length: 30 }, (_, i) => ({ objectType: 'PROG' as const, object: `ZR_SOME_REPORT_${i}` })));
    expect(many.length).toBeGreaterThan(1);
    for (const sql of many) expect(sql.length).toBeLessThanOrEqual(255);
  });
});

describe('a full load', () => {
  const load = async (pageSize?: number) => {
    const store = new GraphStore(tempFile());
    const sql = fakeSql(graphTables());
    const result = await fullSync(store, sql, { ...options, pageSize });
    return { store, sql, result };
  };

  it('resolves includes to their methods and function modules', async () => {
    const { store } = await load();
    const callers = store.edgesTo('ZCL_A', 'GET_BUKRS');
    const from = callers.map(edge => `${edge.srcObj}=>${edge.srcMember}:${edge.srcPart}`).sort();
    expect(from).toEqual(['ZCL_A=>RUN:method', 'ZCL_B=>EXECUTE:method', 'ZR_REP_F01=>null:program']);
    expect(store.edgesTo('ZCL_B', 'EXECUTE')[0]).toMatchObject({ srcObj: 'ZFG', srcMember: 'Z_FM_READ', srcPart: 'function' });
    store.close();
  });

  it('leaves out parameters, locals, standard types and standard code', async () => {
    const { store } = await load();
    expect(store.edgesTo('ZCL_A', 'GET_BUKRS/IV_WERKS')).toHaveLength(0);
    expect(store.edgesTo('MARA')).toHaveLength(0);
    expect(store.edgesTo('ZR_REP', 'LTY_ROW')).toHaveLength(0);
    expect(store.edgesTo('ZCL_A', 'RUN')).toHaveLength(0);
    expect(store.edgesTo('ZCL_A', 'GC_PLANT')).toHaveLength(1);
    store.close();
  });

  it('keeps CROSS references: function modules, forms, submits, messages', async () => {
    const { store } = await load();
    expect(store.edgesTo('Z_FM_READ').map(edge => edge.kind)).toEqual(['function']);
    expect(store.edgesTo('ZR_REP', 'READ_DATA')[0].kind).toBe('perform');
    expect(store.edgesTo('ZR_OTHER')[0].kind).toBe('submit');
    expect(store.edgesTo('ZMSG', '001')[0].kind).toBe('message');
    store.close();
  });

  it('reads program includes, texts and packages', async () => {
    const { store } = await load();
    expect(store.includesOf('ZR_REP')).toEqual(['ZR_REP_F01']);
    expect(store.textOf('ZCL_A', null, ['R', 'E'])).toBe('Утилиты завода');
    expect(store.textOf('ZCL_A', null, ['E', 'R'])).toBe('Plant utilities');
    expect(store.textOf('ZFG', 'Z_FM_READ', ['R'])).toBe('Чтение цены материала');
    expect(store.packageOf('ZCL_A')).toBe('ZPK1');
    expect(store.meta('newestChange')).toBe('20261001120000');
    store.close();
  });

  it('pages by key and gets the same graph with tiny pages', async () => {
    const whole = await load();
    const counts = whole.store.counts();
    whole.store.close();
    fs.rmSync(tempFile(), { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(tempFile() + suffix, { force: true });
    const paged = await load(2);
    expect(paged.store.counts()).toEqual(counts);
    expect(paged.sql.statements.some(sql => / >= '/.test(sql))).toBe(true);
    for (const sql of paged.sql.statements) expect(sql.length).toBeLessThanOrEqual(255);
    paged.store.close();
  });

  it('rolls back a load that fails, keeping the previous graph', async () => {
    const { store } = await load();
    const before = store.counts();
    const failing = { rows: async (sql: string) => { if (/FROM cross/.test(sql)) throw new Error('504'); return fakeSql(graphTables()).rows(sql, 100000); } };
    await expect(fullSync(store, failing, options)).rejects.toThrow('504');
    expect(store.counts()).toEqual(before);
    store.close();
  });
});

describe('a delta load', () => {
  it('reloads a changed object whole, dropping references that are gone', async () => {
    const tables = graphTables();
    const store = new GraphStore(tempFile());
    await fullSync(store, fakeSql(tables), options);

    // ZCL_B=>EXECUTE no longer calls GET_BUKRS but HELPER now.
    const include = classInclude('ZCL_B', 'CM001');
    tables.wbcrossgt = tables.wbcrossgt.filter(row => row.INCLUDE !== include);
    tables.wbcrossgt.push({ OTYPE: 'ME', NAME: 'ZCL_A\\ME:HELPER', INCLUDE: include });
    const changed = tables.reposrc.find(row => row.PROGNAME === include && row.R3STATE === 'A')!;
    changed.UDAT = '20261002';

    const sql = fakeSql(tables);
    const result = await deltaSync(store, sql, options);
    expect(result.mode).toBe('delta');
    expect(result.objectsReloaded).toEqual(['CLAS ZCL_B']);
    expect(store.edgesTo('ZCL_A', 'GET_BUKRS').map(edge => edge.srcObj).sort()).toEqual(['ZCL_A', 'ZR_REP_F01']);
    expect(store.edgesTo('ZCL_A', 'HELPER').map(edge => edge.srcMember).sort()).toEqual(['EXECUTE', 'RUN']);
    expect(store.textOf('ZCL_B', null, ['R'])).toBe('Обработка заказов');
    expect(store.meta('newestChange')).toBe('20261002120000');
    for (const statement of sql.statements) expect(statement.length).toBeLessThanOrEqual(255);
    store.close();
  });

  it('does nothing when nothing changed', async () => {
    const store = new GraphStore(tempFile());
    await fullSync(store, fakeSql(graphTables()), options);
    const before = store.counts();
    const result = await deltaSync(store, fakeSql(graphTables()), options);
    expect(result.objectsReloaded).toEqual([]);
    expect(store.counts()).toEqual(before);
    store.close();
  });

  it('loads everything when there is no graph yet, and when too much changed', async () => {
    const store = new GraphStore(tempFile());
    expect((await deltaSync(store, fakeSql(graphTables()), options)).mode).toBe('full');
    const tables = graphTables();
    for (const row of tables.reposrc) row.UDAT = '20261003';
    const result = await deltaSync(store, fakeSql(tables), { ...options, maxDeltaObjects: 2 });
    expect(result.mode).toBe('full');
    expect(result.escalated).toMatch(/more than the 2/);
    store.close();
  });
});

describe('questions', () => {
  const explorer = async () => {
    const store = new GraphStore(tempFile());
    await fullSync(store, fakeSql(graphTables()), options);
    return { store, explorer: new GraphExplorer(store, ['R', 'E']) };
  };

  it('resolves the ways a name is written', async () => {
    const { store, explorer: graph } = await explorer();
    const { matched, ambiguous, unknown } = graph.resolve([
      'zcl_a=>get_bukrs', 'ZCL_A->RUN', 'ZIF_C~DO', 'Z_FM_READ', 'ZCL_B', 'HELPER', 'BAPI_PO_CREATE1', 'ZNOTHING'
    ]);
    expect(matched.map(node => `${node.label}:${node.kind}`)).toEqual([
      'ZCL_A=>GET_BUKRS:method', 'ZCL_A=>RUN:method', 'ZIF_C=>DO:method', 'Z_FM_READ:function', 'ZCL_B:class',
      'ZCL_A=>HELPER:method', 'BAPI_PO_CREATE1:external'
    ]);
    expect(ambiguous).toEqual([]);
    expect(unknown).toEqual(['ZNOTHING']);
    store.close();
  });

  it('groups callers per method, include or function module, with what they are', async () => {
    const { store, explorer: graph } = await explorer();
    const [node] = graph.resolve(['ZCL_A=>GET_BUKRS']).matched;
    const callers = graph.callers(node);
    expect(callers.map(caller => caller.label)).toEqual(['ZCL_A=>RUN', 'ZCL_B=>EXECUTE', 'ZR_REP_F01']);
    expect(callers.find(caller => caller.label === 'ZR_REP_F01')).toMatchObject({ kind: 'include', programs: ['ZR_REP'], package: 'ZPK2' });
    store.close();
  });

  it('leaves declarations and the object itself out of who uses a class', async () => {
    const { store, explorer: graph } = await explorer();
    const [iface] = graph.resolve(['ZIF_C']).matched;
    expect(graph.callers(iface).map(caller => caller.label)).toEqual(['ZCL_A=>RUN']);
    expect(graph.callers(iface, { includeDeclarations: true }).map(caller => caller.label)).toEqual(['ZCL_A=>RUN', 'ZCL_B']);
    const [cls] = graph.resolve(['ZCL_A']).matched;
    const users = graph.callers(cls);
    expect(users.map(caller => caller.label)).toEqual(['ZCL_B=>EXECUTE', 'ZR_REP_F01']);
    expect(users[0].uses.sort()).toEqual(['GC_PLANT', 'GET_BUKRS']);
    store.close();
  });

  it('lists what a report reaches through its includes, standard targets counted apart', async () => {
    const { store, explorer: graph } = await explorer();
    const [report] = graph.resolve(['ZR_REP']).matched;
    const { entries, standardHidden } = graph.callees(report);
    expect(entries.map(entry => `${entry.kind}:${entry.label}`)).toEqual([
      'function:Z_FM_READ', 'method:ZCL_A=>GET_BUKRS', 'perform:FORM READ_DATA IN ZR_REP', 'submit:ZR_OTHER', 'type:ZTAB'
    ]);
    expect(entries.find(entry => entry.label === 'Z_FM_READ')?.text).toBe('Чтение цены материала');
    expect(standardHidden).toBe(1);
    expect(graph.callees(report, { onlyCustom: false }).entries.some(entry => entry.label === 'BAPI_PO_CREATE1')).toBe(true);
    store.close();
  });

  it('walks callers more than one level, saying the way', async () => {
    const { store, explorer: graph } = await explorer();
    const [node] = graph.resolve(['ZCL_B=>EXECUTE']).matched;
    const walk = graph.walk(node, 'callers', 3, 50);
    expect(walk.map(entry => `${entry.depth}:${entry.node.label}<-${entry.via}`)).toEqual([
      '1:Z_FM_READ<-ZCL_B=>EXECUTE',
      '2:ZR_REP<-Z_FM_READ'
    ]);
    store.close();
  });

  it('finds logic by the words of its description, ё or е', async () => {
    const { store, explorer: graph } = await explorer();
    const found = graph.search('балансовая единица завод', 10);
    expect(found.mode).toBe('all');
    expect(found.hits[0]).toMatchObject({ label: 'ZCL_A=>GET_BUKRS', usedBy: 3 });
    expect(graph.search('выполнить расчет', 10).hits[0].label).toBe('ZIF_C=>DO');
    const loose = graph.search('цены несуществующееслово', 10);
    expect(loose.mode).toBe('any');
    expect(loose.hits.map(hit => hit.label)).toEqual(expect.arrayContaining(['ZTAB', 'Z_FM_READ', 'ZR_REP']));
    store.close();
  });

  it('puts code before data among equal matches, and calls an attribute a component', async () => {
    const { store, explorer: graph } = await explorer();
    const hits = graph.search('завод', 10).hits;
    expect(hits.map(hit => `${hit.label}:${hit.kind}`)).toEqual(['ZCL_A:class', 'ZCL_A=>GET_BUKRS:method', 'ZCL_A=>GC_PLANT:component']);
    store.close();
  });

  it('finds the code that uses several things at once', async () => {
    const { store, explorer: graph } = await explorer();
    const nodes = graph.resolve(['ZCL_A=>GET_BUKRS', 'BAPI_PO_CREATE1']).matched;
    expect(graph.sharedCallers(nodes).map(caller => caller.label).sort()).toEqual(['ZCL_A=>RUN', 'ZR_REP_F01']);
    store.close();
  });
});

describe('code of the places an answer points at', () => {
  const source = [
    'CLASS zcl_a IMPLEMENTATION.',
    '  METHOD get_bukrs.',
    '    rv_bukrs = 1.',
    '  ENDMETHOD.',
    '  METHOD zif_c~do.',
    '    get_bukrs( ).',
    '  ENDMETHOD.',
    'ENDCLASS.'
  ].join('\n');

  it('cuts one method out of a class, interface methods included', () => {
    expect(methodBlock(source, 'GET_BUKRS')).toMatchObject({ title: 'METHOD get_bukrs', from: 2, to: 4 });
    expect(methodBlock(source, 'ZIF_C~DO', 150, 'GET_BUKRS')).toMatchObject({ from: 5, to: 7, hits: [6] });
    expect(methodBlock(source, 'NOPE')).toBeUndefined();
  });

  it('finds the block around a reference, and only words, not comments', () => {
    const report = ['* get_bukrs here is a comment', 'FORM a.', '  x = get_bukrs_list( ).', 'ENDFORM.', 'FORM b.', '  x = zcl_a=>get_bukrs( ).', 'ENDFORM.'];
    expect(linesNaming(report, 'ZCL_A=>GET_BUKRS')).toEqual([5]);
    expect(blocksNaming(report.join('\n'), 'GET_BUKRS')).toEqual([
      expect.objectContaining({ title: 'FORM b', from: 5, to: 7, hits: [6] })
    ]);
  });

  it('shortens a long block around the hits', () => {
    const lines = ['METHOD big.', ...Array.from({ length: 300 }, (_, i) => (i === 150 ? '  zcl_a=>get_bukrs( ).' : `  x = ${i}.`)), 'ENDMETHOD.'];
    const [block] = blocksNaming(lines.join('\n'), 'GET_BUKRS', 1, 20);
    expect(block.omitted).toBeGreaterThan(250);
    expect(block.code).toMatch(/get_bukrs/);
    expect(block.code).toMatch(/left out/);
  });

  it('builds the ADT address of each kind of source', () => {
    expect(sourceUrlOf({ objectType: 'CLAS', object: 'ZCL_A' })).toBe('/sap/bc/adt/oo/classes/zcl_a/source/main');
    expect(sourceUrlOf({ objectType: 'CLAS', object: 'ZCL_A', part: 'CCIMP' })).toBe('/sap/bc/adt/oo/classes/zcl_a/includes/implementations');
    expect(sourceUrlOf({ objectType: 'FUGR', object: 'ZFG', member: 'Z_FM_READ' })).toBe('/sap/bc/adt/functions/groups/zfg/fmodules/z_fm_read/source/main');
    expect(sourceUrlOf({ objectType: 'PROG', object: 'ZR_REP_F01', subc: 'I' })).toBe('/sap/bc/adt/programs/includes/zr_rep_f01/source/main');
    expect(sourceUrlOf({ objectType: 'PROG', object: '/ARM/R_X' })).toBe('/sap/bc/adt/programs/programs/%2Farm%2Fr_x/source/main');
  });
});

describe('what a statement does to a table', () => {
  const sites = (lines: string[]) =>
    extractCallsAcross([{ name: 'X', source: lines.join('\n') }], { onlyCustom: false, kinds: ['table'] }).calls
      .map(call => `${call.target}:${call.access}`);

  it('tells reading from each way of writing, and leaves internal tables out', () => {
    expect(sites([
      'DATA lt_rows TYPE STANDARD TABLE OF ztab.',
      'SELECT a~x FROM ztab AS a INNER JOIN ekko AS k ON k~ebeln = a~ebeln INTO TABLE @lt_rows.',
      'INSERT ztab FROM TABLE lt_rows.',
      'INSERT INTO zlog VALUES ls_log.',
      'UPDATE ekko SET loekz = space WHERE ebeln = lv_ebeln.',
      'MODIFY ztab FROM ls_row.',
      'DELETE FROM zlog WHERE id = 1.',
      'DELETE lt_rows WHERE x = 1.',
      'MODIFY lt_rows FROM ls_row INDEX 1.',
      'TABLES t001w.'
    ])).toEqual(['ZTAB:read', 'EKKO:read', 'ZTAB:insert', 'ZLOG:insert', 'EKKO:update', 'ZTAB:modify', 'ZLOG:delete', 'T001W:declare']);
  });

  it('groups the accesses of a target with the writes first', () => {
    const found = extractCallsAcross([{ name: 'X', source: 'SELECT * FROM ztab INTO TABLE @DATA(lt).\nMODIFY ztab FROM ls.' }], { kinds: ['table'] });
    expect(groupCalls(found.calls).targets[0].access).toEqual(['modify', 'read']);
  });
});

describe('findInSource without its address', () => {
  it('names the argument it needs, and the one it was given instead', async () => {
    await expect(new SourceSearchHandlers({} as any).handle('findInSource', { objectUrl: '/sap/bc/adt/oo/classes/zcl_x', pattern: 'x' }))
      .rejects.toThrow(/needs objectSourceUrl.*passed as objectUrl/);
  });
});

describe('one load at a time', () => {
  it('names the graph file after host, path and client', () => {
    process.env.SAP_GRAPH_DIR = dir;
    expect(graphFileFor('https://sap.example.com/DEV00', '100')).toBe(path.join(dir, 'sap.example.com_DEV00_100.db'));
    delete process.env.SAP_GRAPH_DIR;
  });

  it('ignores a lock left by a process that is gone, and respects a live one', () => {
    const file = tempFile();
    const lock = (pid: number, heartbeat = new Date().toISOString()) =>
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid, mode: 'full', startedAt: heartbeat, heartbeat, phase: 'references', rows: 5, queries: 1 }));
    lock(999999);
    expect(foreignLoad(file)).toBeUndefined();
    lock(process.ppid);
    expect(foreignLoad(file)).toMatchObject({ phase: 'references', rows: 5 });
    lock(process.ppid, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    expect(foreignLoad(file)).toBeUndefined();
  });

  it('refuses a second load while one runs, and removes its lock when done', async () => {
    const file = tempFile();
    graphStore(file);
    const first = startLoad(file, fakeSql(graphTables()), 'full', options);
    expect(first.started).toBe(true);
    const second = startLoad(file, fakeSql(graphTables()), 'full', options);
    expect(second.started).toBe(false);
    if (!first.started) return;
    expect(await waitFor(first.job, 30)).toBe(true);
    expect(first.job.result?.mode).toBe('full');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});
