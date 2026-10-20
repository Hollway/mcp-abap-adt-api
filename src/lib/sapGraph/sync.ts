/**
 * Loading the graph from SAP's own where-used index.
 *
 * Measured on a classic ERP system (20.10.2026): one data preview call
 * returns 213,699 WBCROSSGT rows in 38 seconds without a gateway timeout, 50,000
 * in about 7; a full load of every customer reference is some 0.9 million
 * rows. The bridge's own offset fetches offset+n rows and keeps the tail, so
 * paging is done by key instead - ordered by the include (or name), the next
 * page starting at the last key of the previous one, whose rows are dropped
 * from the page that ended inside it.
 *
 * The index is updated row by row - an include's rows carry different change
 * dates - so a reference that was removed leaves nothing a date filter could
 * find. A delta therefore reloads every object one of whose includes changed
 * (REPOSRC UDAT/UTIME), whole. Objects deleted since the last full load stay in
 * the graph until the next one.
 */
import {
  ownerOfInclude, sourcePartOf, parseGtName, kindOfGt, kindOfCross, crossTarget,
  isCustomerName, sqlLiteral, IncludeOwner, OwnerType
} from './names';
import type { GraphStore, GraphWriter, EdgeRow, IncludeRow, ObjectRow, MemberRow, TextRow } from './store';

/** Where the rows come from: a SELECT and the number of rows to return. */
export interface RowSource {
  rows(sql: string, rowNumber: number): Promise<Record<string, unknown>[]>;
}

export interface SyncProgress {
  phase: string;
  /** Rows read from SAP so far, all phases together. */
  rows: number;
  queries: number;
}

export interface SyncOptions {
  /** First letters of customer objects. */
  prefixes: string[];
  /** SPRAS keys of the texts to keep, preferred first. */
  languages: string[];
  pageSize?: number;
  /** A delta that would reload more objects than this does a full load instead. */
  maxDeltaObjects?: number;
  onProgress?: (progress: SyncProgress) => void;
  /** Now, for the stamps - injectable for tests. */
  now?: () => Date;
}

export interface SyncResult {
  mode: 'full' | 'delta';
  durationMs: number;
  rowsRead: number;
  queries: number;
  counts: Record<string, number>;
  /** Objects a delta reloaded. */
  objectsReloaded?: string[];
  /** Set when a delta found too much and loaded everything instead. */
  escalated?: string;
  /** Newest REPOSRC change the graph has seen, YYYYMMDDHHMMSS. */
  newestChange?: string;
}

export const MAX_SQL = 255;
const DEFAULT_PAGE = 50000;
const INSERT_SLICE = 5000;

/** A column of a data preview row, whatever case the endpoint wrote it in. */
export const field = (row: Record<string, unknown>, name: string): string => {
  const value = row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()];
  return value === undefined || value === null ? '' : String(value).trim();
};

/**
 * A DATS column as YYYYMMDD. In process the data preview hands a date over as
 * a Date at UTC midnight, not as the eight digits - String() of it was the
 * first stamp a live load wrote, "Fri May 03 2019 03:00:00 GMT+0300".
 */
export const dateField = (row: Record<string, unknown>, name: string): string => {
  const value = row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()];
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const pad = (n: number, width: number) => String(n).padStart(width, '0');
    return `${pad(value.getUTCFullYear(), 4)}${pad(value.getUTCMonth() + 1, 2)}${pad(value.getUTCDate(), 2)}`;
  }
  const text = value === undefined || value === null ? '' : String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  return /^\d{8}$/.test(text) ? text : '';
};

/** REPOSRC UDAT and UTIME as one YYYYMMDDHHMMSS stamp, or null when the date is not one. */
export const changeStamp = (row: Record<string, unknown>): string | null => {
  const date = dateField(row, 'UDAT');
  if (!date || date === '00000000') return null;
  const time = field(row, 'UTIME').replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
  return `${date}${time}`;
};

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Write in slices, letting the event loop breathe between them: node:sqlite is synchronous. */
async function sliced<T>(rows: T[], write: (slice: T[]) => void): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_SLICE) {
    write(rows.slice(start, start + INSERT_SLICE));
    await tick();
  }
}

/**
 * SELECT statements of at most 255 characters, the terms ORed together in as
 * few statements as fit: head + '( t1 OR t2 ... )' + tail.
 */
export function batchedSql(head: string, terms: string[], tail = ''): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  const build = (list: string[]) => `${head}( ${list.join(' OR ')} )${tail}`;
  for (const term of terms) {
    if (build([term]).length > MAX_SQL) {
      throw new Error(`A single condition does not fit the ${MAX_SQL}-character limit: ${build([term])}`);
    }
    if (current.length > 0 && build([...current, term]).length > MAX_SQL) {
      statements.push(build(current));
      current = [];
    }
    current.push(term);
  }
  if (current.length > 0) statements.push(build(current));
  return statements;
}

/** The include patterns customer code lives in: Z%, LZ% (function group parts), SAPLZ% (their main programs). */
export const includePatterns = (prefixes: string[]): string[] =>
  prefixes.flatMap(prefix => [`${prefix}%`, `L${prefix}%`, `SAPL${prefix}%`]);

/** Condition on a name column for the customer prefixes. */
const customerNames = (column: string, prefixes: string[]): string =>
  prefixes.length === 1
    ? `${column} LIKE ${sqlLiteral(`${prefixes[0]}%`)}`
    : `( ${prefixes.map(prefix => `${column} LIKE ${sqlLiteral(`${prefix}%`)}`).join(' OR ')} )`;

const inList = (values: string[]): string => `IN ( ${values.map(sqlLiteral).join(', ')} )`;

/** The include filter that selects every include of one owner, and nothing of another. */
export function ownerFilter(owner: { objectType: OwnerType; object: string }, column = 'include'): string {
  switch (owner.objectType) {
    case 'CLAS':
    case 'INTF':
      // Padded to 30 with '=', so ZCL_A does not also pick up ZCL_AB.
      return `${column} LIKE ${sqlLiteral(`${owner.object.padEnd(30, '=')}%`)}`;
    case 'FUGR':
      // L<group> and exactly three characters - '_' is the one-character wildcard.
      return `( ${column} LIKE ${sqlLiteral(`L${owner.object}___`)} OR ${column} = ${sqlLiteral(`SAPL${owner.object}`)} )`;
    default:
      return `${column} = ${sqlLiteral(owner.object)}`;
  }
}

const ownerKey = (owner: { objectType: string; object: string }): string => `${owner.objectType}:${owner.object}`;

/** What turns an include into its owner and member: the method and function module directories. */
class Resolver {
  readonly methods = new Map<string, Map<number, string>>();
  readonly functions = new Map<string, string>();
  readonly includes = new Map<string, IncludeRow>();
  constructor(private readonly prefixes: string[]) {}

  addMethod(className: string, index: number, name: string): void {
    let byIndex = this.methods.get(className);
    if (!byIndex) this.methods.set(className, byIndex = new Map());
    byIndex.set(index, name);
  }

  addFunction(group: string, include: string, name: string): void {
    this.functions.set(`${group}|${include}`, name);
  }

  memberOf(owner: IncludeOwner): string | null {
    if (owner.methodIndex !== undefined) return this.methods.get(owner.object)?.get(owner.methodIndex) ?? null;
    if (owner.functionInclude) return this.functions.get(`${owner.object}|${owner.functionInclude}`) ?? null;
    return null;
  }

  /** The include's row: from REPOSRC when it was read, worked out from the name otherwise. */
  include(include: string): IncludeRow {
    const known = this.includes.get(include);
    if (known) return known;
    const owner = ownerOfInclude(include, this.prefixes);
    const row: IncludeRow = {
      include, object: owner.object, objectType: owner.objectType, member: this.memberOf(owner),
      part: owner.part, subc: null, stamp: null
    };
    this.includes.set(include, row);
    return row;
  }

  includeFromRepository(row: Record<string, unknown>): IncludeRow {
    const include = field(row, 'PROGNAME').toUpperCase();
    const owner = ownerOfInclude(include, this.prefixes);
    const stamp = changeStamp(row);
    const included: IncludeRow = {
      include, object: owner.object, objectType: owner.objectType, member: this.memberOf(owner),
      part: owner.part, subc: field(row, 'SUBC') || null, stamp
    };
    this.includes.set(include, included);
    return included;
  }
}

const partOf = (row: IncludeRow) => sourcePartOf(row);

/** A WBCROSSGT row as an edge, or nothing for the references the graph leaves out. */
export function gtEdge(row: Record<string, unknown>, resolver: { include(name: string): IncludeRow }, prefixes: string[]): EdgeRow | undefined {
  const otype = field(row, 'OTYPE').toUpperCase();
  const name = field(row, 'NAME');
  const include = field(row, 'INCLUDE').toUpperCase();
  if (!otype || !name || !include) return undefined;
  const target = parseGtName(name);
  if (!target.object) return undefined;
  if (otype === 'DA' || otype === 'TY') {
    // A method's own parameters and a program's locals say nothing about
    // what the code depends on; standard types would be most of the table.
    if (target.parameter || target.local || !isCustomerName(target.object, prefixes)) return undefined;
  }
  const source = resolver.include(include);
  return {
    srcObj: source.object, srcType: source.objectType, srcMember: source.member, srcPart: partOf(source),
    include, kind: kindOfGt(otype), dstObj: target.object, dstMember: target.member ?? null, origin: otype
  };
}

/** A CROSS row as an edge. */
export function crossEdge(row: Record<string, unknown>, resolver: { include(name: string): IncludeRow }): EdgeRow | undefined {
  const type = field(row, 'TYPE').toUpperCase();
  const name = field(row, 'NAME');
  const include = field(row, 'INCLUDE').toUpperCase();
  if (!name || !include) return undefined;
  const target = crossTarget(type, name, field(row, 'PROG'));
  const source = resolver.include(include);
  // PERFORM without IN PROGRAM: the form is in the caller's own program.
  const dstObj = target.object || (type === 'U' ? source.object : '');
  if (!dstObj && !target.member) return undefined;
  return {
    srcObj: source.object, srcType: source.objectType, srcMember: source.member, srcPart: partOf(source),
    include, kind: kindOfCross(type), dstObj, dstMember: target.member ?? null, origin: type || '?'
  };
}

/** One load, from the first query to the commit. */
class Load {
  rowsRead = 0;
  queries = 0;
  phase = '';
  readonly resolver: Resolver;
  readonly pageSize: number;

  constructor(readonly source: RowSource, readonly options: SyncOptions) {
    this.resolver = new Resolver(options.prefixes);
    this.pageSize = options.pageSize || DEFAULT_PAGE;
  }

  enter(phase: string): void {
    this.phase = phase;
    this.report();
  }

  report(): void {
    this.options.onProgress?.({ phase: this.phase, rows: this.rowsRead, queries: this.queries });
  }

  async query(sql: string, rowNumber: number): Promise<Record<string, unknown>[]> {
    if (sql.length > MAX_SQL) throw new Error(`Statement over ${MAX_SQL} characters: ${sql}`);
    this.queries += 1;
    const rows = await this.source.rows(sql, rowNumber);
    this.rowsRead += rows.length;
    this.report();
    return rows;
  }

  /**
   * Every row of a SELECT, page by page in key order. A page that comes back
   * full may end in the middle of a key, so its last key is read again as the
   * start of the next page; a page that is all one key is asked for again
   * twice as large.
   */
  async *pages(select: string, where: string, key: string): AsyncGenerator<Record<string, unknown>[]> {
    let last: string | undefined;
    let size = this.pageSize;
    for (;;) {
      const from = last === undefined ? '' : ` AND ${key} >= ${sqlLiteral(last)}`;
      const rows = await this.query(`${select} WHERE ${where}${from} ORDER BY ${key}`, size);
      if (rows.length < size) {
        if (rows.length > 0) yield rows;
        return;
      }
      const lastKey = field(rows[rows.length - 1], key);
      const kept = rows.filter(row => field(row, key) !== lastKey);
      if (kept.length === 0) {
        size *= 2;
        continue;
      }
      yield kept;
      last = lastKey;
      size = this.pageSize;
    }
  }

  /** Every row of a set of statements that each fit one call. */
  async all(statements: string[]): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const sql of statements) rows.push(...await this.query(sql, 1000000));
    return rows;
  }
}

const OBJECT_TYPES = ['CLAS', 'INTF', 'PROG', 'FUGR', 'TABL', 'TTYP', 'DDLS', 'TRAN', 'MSAG', 'VIEW', 'DTEL'];
const OWNER_TYPES = ['CLAS', 'INTF', 'PROG', 'FUGR'];

const objectRow = (row: Record<string, unknown>): ObjectRow => ({
  type: field(row, 'OBJECT').toUpperCase(),
  name: field(row, 'OBJ_NAME').toUpperCase(),
  package: field(row, 'DEVCLASS') || null
});

/** The kinds of member a SEOCOMPOTX row can be; the table does not say which, so it is 'component' unless TMDIR named it a method. */
const COMPONENT = 'component';

interface Collected {
  objects: ObjectRow[];
  members: MemberRow[];
  includes: IncludeRow[];
  edges: EdgeRow[];
  texts: TextRow[];
  programIncludes: { master: string; include: string }[];
}

const emptyCollected = (): Collected => ({ objects: [], members: [], includes: [], edges: [], texts: [], programIncludes: [] });

/** Methods and function modules, into the resolver and as member rows. */
function addMethodRows(load: Load, rows: Record<string, unknown>[], objectTypes: Map<string, string>, members: MemberRow[]): void {
  for (const row of rows) {
    const className = field(row, 'CLASSNAME').toUpperCase();
    const index = Number(field(row, 'METHODINDX'));
    const name = field(row, 'METHODNAME').toUpperCase();
    if (!className || !name || !Number.isFinite(index) || index <= 0) continue;
    load.resolver.addMethod(className, index, name);
    members.push({ object: className, objectType: objectTypes.get(className) || 'CLAS', member: name, kind: 'method' });
  }
}

function addFunctionRows(load: Load, rows: Record<string, unknown>[], members: MemberRow[], groupOf: Map<string, string>): void {
  for (const row of rows) {
    const name = field(row, 'FUNCNAME').toUpperCase();
    const program = field(row, 'PNAME').toUpperCase();
    const include = field(row, 'INCLUDE');
    if (!name || !program.startsWith('SAPL')) continue;
    const group = program.slice(4);
    load.resolver.addFunction(group, include.padStart(2, '0'), name);
    groupOf.set(name, group);
    members.push({ object: group, objectType: 'FUGR', member: name, kind: 'function' });
  }
}

function textRows(
  rows: Record<string, unknown>[],
  columns: { object: string; member?: string; lang: string; text: string },
  map?: (object: string, member: string) => { object: string; member: string } | undefined
): TextRow[] {
  const texts: TextRow[] = [];
  for (const row of rows) {
    const text = field(row, columns.text);
    if (!text) continue;
    let object = field(row, columns.object).toUpperCase();
    let member = columns.member ? field(row, columns.member).toUpperCase() : '';
    if (map) {
      const mapped = map(object, member);
      if (!mapped) continue;
      ({ object, member } = mapped);
    }
    texts.push({ object, member, lang: field(row, columns.lang).toUpperCase(), text });
  }
  return texts;
}

/** Components that have a text but are not methods TMDIR knows - interface methods, attributes, events. */
function componentMembers(texts: TextRow[], known: Set<string>, objectTypes: Map<string, string>): MemberRow[] {
  const added: MemberRow[] = [];
  for (const text of texts) {
    if (!text.member) continue;
    const key = `${text.object}|${text.member}`;
    if (known.has(key)) continue;
    known.add(key);
    added.push({ object: text.object, objectType: objectTypes.get(text.object) || 'CLAS', member: text.member, kind: COMPONENT });
  }
  return added;
}

const programIncludeRows = (rows: Record<string, unknown>[]) =>
  rows
    .map(row => ({ master: field(row, 'MASTER').toUpperCase(), include: field(row, 'INCLUDE').toUpperCase() }))
    .filter(row => row.master && row.include && row.master !== row.include);

/** A function module's text belongs to its group, as the member it is. */
const functionText = (groupOf: Map<string, string>) => (fm: string) => {
  const group = groupOf.get(fm);
  return group ? { object: group, member: fm } : undefined;
};

const newestOf = (rows: IncludeRow[], start?: string): string | undefined =>
  rows.reduce<string | undefined>((newest, row) => (row.stamp && (!newest || row.stamp > newest) ? row.stamp : newest), start);

async function writeCollected(writer: GraphWriter, collected: Collected): Promise<void> {
  await sliced(collected.objects, slice => writer.insertObjects(slice));
  await sliced(collected.members, slice => writer.insertMembers(slice));
  await sliced(collected.includes, slice => writer.insertIncludes(slice));
  await sliced(collected.texts, slice => writer.insertTexts(slice));
  await sliced(collected.edges, slice => writer.insertEdges(slice));
  await sliced(collected.programIncludes, slice => writer.insertProgramIncludes(slice));
}

const stampNow = (now: Date): string => now.toISOString();

/**
 * Everything, from scratch, in one transaction.
 *
 * Rows are written as their pages arrive rather than collected first: the
 * references alone are close to a million rows, and holding them as objects
 * would cost hundreds of megabytes. The transaction stays open across the
 * calls to SAP; in WAL mode readers keep seeing the previous graph until the
 * commit, and a failure rolls everything back.
 */
export async function fullSync(store: GraphStore, source: RowSource, options: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  const load = new Load(source, options);
  const { prefixes, languages } = options;
  const langs = inList(languages);
  const objectTypes = new Map<string, string>();
  const groupOf = new Map<string, string>();
  const memberKeys = new Set<string>();
  let newest: string | undefined;

  const writer = store.writer();
  try {
    writer.begin();
    writer.clearAll();

    load.enter('objects');
    for (const prefix of prefixes) {
      for (const type of OBJECT_TYPES) {
        for await (const page of load.pages(
          'SELECT object, obj_name, devclass FROM tadir',
          `pgmid = 'R3TR' AND object = ${sqlLiteral(type)} AND obj_name LIKE ${sqlLiteral(`${prefix}%`)}`,
          'obj_name'
        )) {
          const rows = page.map(objectRow);
          for (const row of rows) if (row.type === 'CLAS' || row.type === 'INTF') objectTypes.set(row.name, row.type);
          await sliced(rows, slice => writer.insertObjects(slice));
        }
      }
    }

    load.enter('methods');
    for (const prefix of prefixes) {
      for await (const page of load.pages('SELECT classname, methodindx, methodname FROM tmdir', `classname LIKE ${sqlLiteral(`${prefix}%`)}`, 'classname')) {
        const members: MemberRow[] = [];
        addMethodRows(load, page, objectTypes, members);
        for (const member of members) memberKeys.add(`${member.object}|${member.member}`);
        await sliced(members, slice => writer.insertMembers(slice));
      }
    }

    load.enter('functions');
    for (const prefix of prefixes) {
      for await (const page of load.pages('SELECT funcname, pname, include FROM tfdir', `pname LIKE ${sqlLiteral(`SAPL${prefix}%`)}`, 'funcname')) {
        const members: MemberRow[] = [];
        addFunctionRows(load, page, members, groupOf);
        await sliced(members, slice => writer.insertMembers(slice));
      }
    }

    load.enter('includes');
    for (const pattern of includePatterns(prefixes)) {
      for await (const page of load.pages(
        'SELECT progname, subc, udat, utime FROM reposrc',
        `r3state = 'A' AND progname LIKE ${sqlLiteral(pattern)}`,
        'progname'
      )) {
        const rows = page.map(row => load.resolver.includeFromRepository(row));
        newest = newestOf(rows, newest);
        await sliced(rows, slice => writer.insertIncludes(slice));
      }
    }

    load.enter('program includes');
    for (const prefix of prefixes) {
      const like = (column: string) => `${column} LIKE ${sqlLiteral(`${prefix}%`)}`;
      for await (const page of load.pages(
        'SELECT master, include FROM d010inc',
        // A class pool lists its own includes here too; those are read from the names.
        `${like('master')} AND ${customerNames('include', prefixes)} AND master NOT LIKE '%=CP'`,
        'master'
      )) {
        await sliced(programIncludeRows(page), slice => writer.insertProgramIncludes(slice));
      }
    }

    load.enter('references');
    const names = customerNames('name', prefixes);
    for (const pattern of includePatterns(prefixes)) {
      const include = `include LIKE ${sqlLiteral(pattern)}`;
      const wheres = [
        `otype IN ( 'ME', 'EV', 'TK' ) AND ${include}`,
        `otype = 'DA' AND ${include} AND ${names} AND name NOT LIKE '%\\ME:%'`,
        `otype = 'TY' AND ${include} AND ${names}`
      ];
      for (const where of wheres) {
        for await (const page of load.pages('SELECT otype, name, include FROM wbcrossgt', where, 'include')) {
          const edges = page.map(row => gtEdge(row, load.resolver, prefixes)).filter((edge): edge is EdgeRow => !!edge);
          await sliced(edges, slice => writer.insertEdges(slice));
        }
      }
      for await (const page of load.pages('SELECT type, name, prog, include FROM cross', include, 'include')) {
        const edges = page.map(row => crossEdge(row, load.resolver)).filter((edge): edge is EdgeRow => !!edge);
        await sliced(edges, slice => writer.insertEdges(slice));
      }
    }

    load.enter('texts');
    const writeTexts = (texts: TextRow[]) => sliced(texts, slice => writer.insertTexts(slice));
    for (const prefix of prefixes) {
      const like = (column: string) => `${column} LIKE ${sqlLiteral(`${prefix}%`)}`;
      for await (const page of load.pages('SELECT clsname, langu, descript FROM seoclasstx', `${like('clsname')} AND langu ${langs}`, 'clsname')) {
        await writeTexts(textRows(page, { object: 'CLSNAME', lang: 'LANGU', text: 'DESCRIPT' }));
      }
      for await (const page of load.pages('SELECT clsname, cmpname, langu, descript FROM seocompotx', `${like('clsname')} AND langu ${langs}`, 'clsname')) {
        const texts = textRows(page, { object: 'CLSNAME', member: 'CMPNAME', lang: 'LANGU', text: 'DESCRIPT' });
        const components = componentMembers(texts, memberKeys, objectTypes);
        await sliced(components, slice => writer.insertMembers(slice));
        await writeTexts(texts);
      }
      for await (const page of load.pages('SELECT funcname, spras, stext FROM tftit', `${like('funcname')} AND spras ${langs}`, 'funcname')) {
        await writeTexts(textRows(page, { object: 'FUNCNAME', lang: 'SPRAS', text: 'STEXT' }, functionText(groupOf)));
      }
      for await (const page of load.pages('SELECT name, sprsl, text FROM trdirt', `${like('name')} AND sprsl ${langs}`, 'name')) {
        await writeTexts(textRows(page, { object: 'NAME', lang: 'SPRSL', text: 'TEXT' }));
      }
      for await (const page of load.pages('SELECT area, spras, areat FROM tlibt', `${like('area')} AND spras ${langs}`, 'area')) {
        await writeTexts(textRows(page, { object: 'AREA', lang: 'SPRAS', text: 'AREAT' }));
      }
      for await (const page of load.pages('SELECT tabname, ddlanguage, ddtext FROM dd02t', `${like('tabname')} AND as4local = 'A' AND ddlanguage ${langs}`, 'tabname')) {
        await writeTexts(textRows(page, { object: 'TABNAME', lang: 'DDLANGUAGE', text: 'DDTEXT' }));
      }
    }

    load.enter('search index');
    writer.rebuildSearch();
    const now = stampNow(options.now?.() || new Date());
    writer.setMeta('fullSyncAt', now);
    writer.setMeta('lastSyncAt', now);
    if (newest) writer.setMeta('newestChange', newest);
    writer.setMeta('prefixes', prefixes.join(','));
    writer.setMeta('languages', languages.join(','));
    writer.commit();
    load.enter('done');
    return {
      mode: 'full',
      durationMs: Date.now() - started,
      rowsRead: load.rowsRead,
      queries: load.queries,
      counts: store.counts(),
      newestChange: newest
    };
  } finally {
    writer.close();
  }
}

/** The objects with an include changed since the newest change the graph has, reloaded whole. */
export async function deltaSync(store: GraphStore, source: RowSource, options: SyncOptions): Promise<SyncResult> {
  const newestKnown = store.meta('newestChange');
  if (!newestKnown || store.isEmpty()) return fullSync(store, source, options);

  const started = Date.now();
  const load = new Load(source, options);
  const { prefixes, languages } = options;
  const langs = inList(languages);
  const since = newestKnown.slice(0, 8);
  const limit = options.maxDeltaObjects ?? 300;

  load.enter('changes');
  const changed = new Map<string, { objectType: OwnerType; object: string }>();
  for (const pattern of includePatterns(prefixes)) {
    const rows = await load.query(
      `SELECT progname, udat, utime FROM reposrc WHERE r3state = 'A' AND progname LIKE ${sqlLiteral(pattern)} AND udat >= ${sqlLiteral(since)}`,
      1000000
    );
    for (const row of rows) {
      const include = field(row, 'PROGNAME').toUpperCase();
      const stamp = changeStamp(row) || '';
      const known = store.includeRow(include);
      if (known?.stamp && stamp <= known.stamp) continue;
      const owner = ownerOfInclude(include, prefixes);
      changed.set(ownerKey(owner), { objectType: owner.objectType, object: owner.object });
    }
  }

  if (changed.size > limit) {
    const result = await fullSync(store, source, options);
    return { ...result, escalated: `${changed.size} objects changed since the last load, more than the ${limit} a delta reloads - loaded everything instead.` };
  }

  const owners = [...changed.values()];
  const collected = emptyCollected();
  const objectTypes = new Map<string, string>();
  const groupOf = new Map<string, string>();

  if (owners.length > 0) {
    const ownerNames = owners.map(owner => owner.object);
    const classes = owners.filter(owner => owner.objectType === 'CLAS' || owner.objectType === 'INTF').map(owner => owner.object);
    const groups = owners.filter(owner => owner.objectType === 'FUGR').map(owner => owner.object);
    const programs = owners.filter(owner => owner.objectType === 'PROG').map(owner => owner.object);
    const nameTerms = (column: string, values: string[]) => values.map(value => `${column} = ${sqlLiteral(value)}`);

    load.enter('objects');
    for (const row of (await load.all(batchedSql(
      'SELECT object, obj_name, devclass FROM tadir WHERE ', nameTerms('obj_name', ownerNames), ` AND pgmid = 'R3TR' AND object ${inList(OWNER_TYPES)}`
    ))).map(objectRow)) {
      collected.objects.push(row);
      if (row.type === 'CLAS' || row.type === 'INTF') objectTypes.set(row.name, row.type);
    }

    load.enter('methods');
    if (classes.length > 0) {
      addMethodRows(load, await load.all(batchedSql('SELECT classname, methodindx, methodname FROM tmdir WHERE ', nameTerms('classname', classes))), objectTypes, collected.members);
    }
    load.enter('functions');
    if (groups.length > 0) {
      addFunctionRows(load, await load.all(batchedSql('SELECT funcname, pname, include FROM tfdir WHERE ', nameTerms('pname', groups.map(group => `SAPL${group}`)))), collected.members, groupOf);
    }

    load.enter('includes');
    const includeTerms = owners.map(owner => ownerFilter(owner, 'progname'));
    for (const row of await load.all(batchedSql('SELECT progname, subc, udat, utime FROM reposrc WHERE ', includeTerms, ` AND r3state = 'A'`))) {
      collected.includes.push(load.resolver.includeFromRepository(row));
    }

    if (programs.length > 0) {
      collected.programIncludes.push(...programIncludeRows(await load.all(batchedSql('SELECT master, include FROM d010inc WHERE ', nameTerms('master', programs))))
        .filter(row => isCustomerName(row.include, prefixes)));
    }

    load.enter('references');
    const referenceTerms = owners.map(owner => ownerFilter(owner));
    for (const row of await load.all(batchedSql('SELECT otype, name, include FROM wbcrossgt WHERE ', referenceTerms))) {
      const edge = gtEdge(row, load.resolver, prefixes);
      if (edge) collected.edges.push(edge);
    }
    for (const row of await load.all(batchedSql('SELECT type, name, prog, include FROM cross WHERE ', referenceTerms))) {
      const edge = crossEdge(row, load.resolver);
      if (edge) collected.edges.push(edge);
    }

    load.enter('texts');
    const langTail = (column: string) => ` AND ${column} ${langs}`;
    if (classes.length > 0) {
      collected.texts.push(...textRows(await load.all(batchedSql('SELECT clsname, langu, descript FROM seoclasstx WHERE ', nameTerms('clsname', classes), langTail('langu'))),
        { object: 'CLSNAME', lang: 'LANGU', text: 'DESCRIPT' }));
      const componentTexts = textRows(await load.all(batchedSql('SELECT clsname, cmpname, langu, descript FROM seocompotx WHERE ', nameTerms('clsname', classes), langTail('langu'))),
        { object: 'CLSNAME', member: 'CMPNAME', lang: 'LANGU', text: 'DESCRIPT' });
      const known = new Set(collected.members.map(member => `${member.object}|${member.member}`));
      collected.members.push(...componentMembers(componentTexts, known, objectTypes));
      collected.texts.push(...componentTexts);
    }
    const functions = [...groupOf.keys()];
    if (functions.length > 0) {
      collected.texts.push(...textRows(await load.all(batchedSql('SELECT funcname, spras, stext FROM tftit WHERE ', nameTerms('funcname', functions), langTail('spras'))),
        { object: 'FUNCNAME', lang: 'SPRAS', text: 'STEXT' }, functionText(groupOf)));
    }
    if (programs.length > 0) {
      collected.texts.push(...textRows(await load.all(batchedSql('SELECT name, sprsl, text FROM trdirt WHERE ', nameTerms('name', programs), langTail('sprsl'))),
        { object: 'NAME', lang: 'SPRSL', text: 'TEXT' }));
    }
    if (groups.length > 0) {
      collected.texts.push(...textRows(await load.all(batchedSql('SELECT area, spras, areat FROM tlibt WHERE ', nameTerms('area', groups), langTail('spras'))),
        { object: 'AREA', lang: 'SPRAS', text: 'AREAT' }));
    }
  }

  load.enter('writing');
  const writer = store.writer();
  try {
    writer.begin();
    for (const owner of owners) writer.deleteOwner(owner.objectType, owner.object);
    writer.deleteObjectRows(owners.map(owner => owner.object));
    await writeCollected(writer, collected);
    if (owners.length > 0) writer.rebuildSearch(owners.map(owner => owner.object));
    const newest = newestOf(collected.includes, newestKnown);
    writer.setMeta('lastSyncAt', stampNow(options.now?.() || new Date()));
    if (newest) writer.setMeta('newestChange', newest);
    writer.commit();
    load.enter('done');
    return {
      mode: 'delta',
      durationMs: Date.now() - started,
      rowsRead: load.rowsRead,
      queries: load.queries,
      counts: store.counts(),
      objectsReloaded: owners.map(owner => `${owner.objectType} ${owner.object}`),
      newestChange: newest
    };
  } finally {
    writer.close();
  }
}
