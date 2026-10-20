/**
 * The graph on disk: one SQLite file per system.
 *
 * node:sqlite ships with Node from 22.13 on, so this needs no dependency. It
 * is loaded through process.getBuiltinModule rather than imported, because
 * the module exists only under its node: name and jest's resolver does not
 * know such modules - an import would break every test that touches the
 * server, sqlite or not.
 *
 * Two connections per file. Readers use one; a load writes on its own, in one
 * transaction from the first row to the last. With the database in WAL mode
 * that is what keeps a question answerable during a load: every reader, in
 * this process or another one, sees the graph as it was until the load
 * commits, and never half of it.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { normalizeText } from './names';

type SqliteModule = typeof import('node:sqlite');

let sqlite: SqliteModule | undefined;

/** The built-in sqlite module, or a refusal that says which Node it takes. */
export function sqliteModule(): SqliteModule {
  if (sqlite) return sqlite;
  const loaded = typeof (process as any).getBuiltinModule === 'function'
    ? (process as any).getBuiltinModule('node:sqlite') as SqliteModule | undefined
    : undefined;
  if (!loaded?.DatabaseSync) {
    throw new Error(`The SAP graph needs Node 22.13 or newer (built-in node:sqlite); this is Node ${process.versions.node}.`);
  }
  sqlite = loaded;
  return loaded;
}

/** Bumped whenever the tables change shape; an older file is rebuilt, not migrated. */
export const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges(
  src_obj TEXT NOT NULL, src_type TEXT NOT NULL, src_member TEXT, src_part TEXT NOT NULL,
  include TEXT NOT NULL, kind TEXT NOT NULL, dst_obj TEXT NOT NULL, dst_member TEXT, origin TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_obj, dst_member);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_obj, src_member);
CREATE TABLE IF NOT EXISTS includes(
  include TEXT PRIMARY KEY, object TEXT NOT NULL, object_type TEXT NOT NULL, member TEXT,
  part TEXT NOT NULL, subc TEXT, stamp TEXT);
CREATE INDEX IF NOT EXISTS includes_owner ON includes(object_type, object);
CREATE TABLE IF NOT EXISTS program_includes(master TEXT NOT NULL, include TEXT NOT NULL, PRIMARY KEY(master, include));
CREATE INDEX IF NOT EXISTS program_includes_include ON program_includes(include);
CREATE TABLE IF NOT EXISTS objects(type TEXT NOT NULL, name TEXT NOT NULL, package TEXT, PRIMARY KEY(type, name));
CREATE INDEX IF NOT EXISTS objects_name ON objects(name);
CREATE TABLE IF NOT EXISTS members(
  object TEXT NOT NULL, object_type TEXT NOT NULL, member TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY(object, member, kind));
CREATE INDEX IF NOT EXISTS members_member ON members(member);
CREATE TABLE IF NOT EXISTS texts(
  object TEXT NOT NULL, member TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY(object, member, lang));
CREATE TABLE IF NOT EXISTS scanned_includes(include TEXT PRIMARY KEY, stamp TEXT NOT NULL, scanned_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS table_sites(
  include TEXT NOT NULL, tab TEXT NOT NULL, access TEXT NOT NULL, line INTEGER NOT NULL, statement TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS table_sites_tab ON table_sites(tab);
CREATE INDEX IF NOT EXISTS table_sites_include ON table_sites(include);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  object UNINDEXED, object_type UNINDEXED, member UNINDEXED, words,
  tokenize = 'unicode61 remove_diacritics 2');
`;

const TABLES = ['edges', 'includes', 'program_includes', 'objects', 'members', 'texts', 'search'];

export interface EdgeRow {
  srcObj: string;
  srcType: string;
  srcMember: string | null;
  srcPart: string;
  include: string;
  kind: string;
  dstObj: string;
  dstMember: string | null;
  /** WBCROSSGT OTYPE or CROSS TYPE, as the index wrote it. */
  origin: string;
}

export interface IncludeRow {
  include: string;
  object: string;
  objectType: string;
  member: string | null;
  part: string;
  /** TRDIR/REPOSRC SUBC: 1 report, I include, ... */
  subc: string | null;
  /** REPOSRC UDAT and UTIME as YYYYMMDDHHMMSS. */
  stamp: string | null;
}

export interface ObjectRow {
  type: string;
  name: string;
  package: string | null;
}

export interface MemberRow {
  object: string;
  objectType: string;
  member: string;
  /** method, function, attribute, event, type. */
  kind: string;
}

export interface TextRow {
  object: string;
  /** Empty for the object's own text. */
  member: string;
  lang: string;
  text: string;
}

/** One statement that touches a database table, found by scanning the include. */
export interface TableSiteRow {
  include: string;
  table: string;
  /** read, insert, update, modify, delete, declare. */
  access: string;
  /** Line in the scanned source. */
  line: number;
  statement: string;
}

export interface SearchHit {
  object: string;
  objectType: string;
  member: string | null;
  rank: number;
  /** The indexed words: the name split up and every text. */
  words: string;
}

const openDatabase = (file: string): DatabaseSync => {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file);
  // Another process may be loading: wait for its lock instead of failing.
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return db;
};

const edgeOf = (row: any): EdgeRow => ({
  srcObj: row.src_obj,
  srcType: row.src_type,
  srcMember: row.src_member ?? null,
  srcPart: row.src_part,
  include: row.include,
  kind: row.kind,
  dstObj: row.dst_obj,
  dstMember: row.dst_member ?? null,
  origin: row.origin
});

const placeholders = (count: number): string => new Array(count).fill('?').join(', ');

/** Read side of one graph file. */
export class GraphStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(file: string) {
    this.file = file;
    this.db = openDatabase(file);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(SCHEMA);
    const version = this.meta('schemaVersion');
    if (version === undefined) {
      this.setMetaDirect('schemaVersion', SCHEMA_VERSION);
    } else if (version !== SCHEMA_VERSION) {
      // A file written by another layout is worth nothing but a reload, and
      // a reload is what its absence would cost anyway.
      for (const table of TABLES) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec('DELETE FROM meta');
      this.setMetaDirect('schemaVersion', SCHEMA_VERSION);
    }
  }

  private setMetaDirect(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, value);
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  meta(key: string): string | undefined {
    const row: any = this.statement('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value;
  }

  /** Rows per table - what a load produced, and whether there is a graph at all. */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of ['edges', 'includes', 'objects', 'members', 'texts']) {
      counts[table] = Number((this.statement(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
    }
    return counts;
  }

  isEmpty(): boolean {
    return !this.statement('SELECT 1 FROM edges LIMIT 1').get();
  }

  objectsNamed(names: string[]): ObjectRow[] {
    if (names.length === 0) return [];
    return (this.statement(`SELECT type, name, package FROM objects WHERE name IN (${placeholders(names.length)})`)
      .all(...names) as any[]).map(row => ({ type: row.type, name: row.name, package: row.package ?? null }));
  }

  /** Members by name, across objects - how a bare method or function module name is resolved. */
  membersNamed(member: string, object?: string): MemberRow[] {
    const rows = object
      ? this.statement('SELECT object, object_type, member, kind FROM members WHERE object = ? AND member = ?').all(object, member)
      : this.statement('SELECT object, object_type, member, kind FROM members WHERE member = ? LIMIT 50').all(member);
    return (rows as any[]).map(row => ({ object: row.object, objectType: row.object_type, member: row.member, kind: row.kind }));
  }

  membersOf(object: string): MemberRow[] {
    return (this.statement('SELECT object, object_type, member, kind FROM members WHERE object = ?').all(object) as any[])
      .map(row => ({ object: row.object, objectType: row.object_type, member: row.member, kind: row.kind }));
  }

  /** References to an object, or to one member of it. */
  edgesTo(object: string, member?: string | null): EdgeRow[] {
    const rows = member
      ? this.statement('SELECT * FROM edges WHERE dst_obj = ? AND dst_member = ?').all(object, member)
      : this.statement('SELECT * FROM edges WHERE dst_obj = ?').all(object);
    return (rows as any[]).map(edgeOf);
  }

  /** References made by an object, or by one member of it. */
  edgesFrom(object: string, member?: string | null): EdgeRow[] {
    const rows = member
      ? this.statement('SELECT * FROM edges WHERE src_obj = ? AND src_member = ?').all(object, member)
      : this.statement('SELECT * FROM edges WHERE src_obj = ?').all(object);
    return (rows as any[]).map(edgeOf);
  }

  includeRow(include: string): IncludeRow | undefined {
    const row: any = this.statement('SELECT * FROM includes WHERE include = ?').get(include);
    return row ? {
      include: row.include, object: row.object, objectType: row.object_type, member: row.member ?? null,
      part: row.part, subc: row.subc ?? null, stamp: row.stamp ?? null
    } : undefined;
  }

  /** The newest REPOSRC stamp among an object's includes - when it last changed, as far as the graph knows. */
  stampOf(objectType: string, object: string): string | undefined {
    const row: any = this.statement('SELECT MAX(stamp) AS stamp FROM includes WHERE object_type = ? AND object = ?').get(objectType, object);
    return row?.stamp ?? undefined;
  }

  /** The text of an object (member omitted) or of a member, in the first of the languages that has one. */
  textOf(object: string, member: string | null | undefined, languages: string[]): string | undefined {
    const rows = this.statement('SELECT lang, text FROM texts WHERE object = ? AND member = ?').all(object, member || '') as any[];
    for (const lang of languages) {
      const hit = rows.find(row => row.lang === lang);
      if (hit) return hit.text;
    }
    return rows[0]?.text;
  }

  /** The includes of a program (D010INC), its own customer includes only. */
  includesOf(master: string): string[] {
    return (this.statement('SELECT include FROM program_includes WHERE master = ?').all(master) as any[]).map(row => row.include);
  }

  /** The programs an include is part of. */
  mastersOf(include: string): string[] {
    return (this.statement('SELECT master FROM program_includes WHERE include = ?').all(include) as any[]).map(row => row.master);
  }

  packageOf(object: string): string | undefined {
    const row: any = this.statement('SELECT package FROM objects WHERE name = ? AND package IS NOT NULL LIMIT 1').get(object);
    return row?.package ?? undefined;
  }

  /** Full-text search over names and short texts. query is FTS5 syntax - build it with ftsQuery. */
  search(query: string, limit: number): SearchHit[] {
    return (this.statement(
      'SELECT object, object_type, member, words, bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?'
    ).all(query, limit) as any[]).map(row => ({
      object: row.object, objectType: row.object_type, member: row.member || null, rank: row.rank, words: row.words
    }));
  }

  /** How many references point at an object or member - the weight of a search hit. */
  usageCount(object: string, member?: string | null): number {
    const row: any = member
      ? this.statement('SELECT COUNT(*) AS n FROM edges WHERE dst_obj = ? AND dst_member = ?').get(object, member)
      : this.statement('SELECT COUNT(*) AS n FROM edges WHERE dst_obj = ?').get(object);
    return Number(row?.n || 0);
  }

  /**
   * The stamp an include was last scanned for table access at - compared with
   * its current stamp, that says whether the cached sites still hold. The
   * scans are kept apart from the load tables: a load does not clear them,
   * since a scan stays true for as long as the include does not change.
   */
  scannedStamp(include: string): string | undefined {
    const row: any = this.statement('SELECT stamp FROM scanned_includes WHERE include = ?').get(include);
    return row?.stamp ?? undefined;
  }

  /** The table access sites found in the given includes, for one table. */
  tableSites(table: string, includes: string[]): TableSiteRow[] {
    if (includes.length === 0) return [];
    const rows: TableSiteRow[] = [];
    // A long IN list in slices: SQLite allows some thousands of parameters, not unlimited.
    for (let start = 0; start < includes.length; start += 500) {
      const slice = includes.slice(start, start + 500);
      rows.push(...(this.statement(`SELECT include, tab, access, line, statement FROM table_sites WHERE tab = ? AND include IN (${placeholders(slice.length)})`)
        .all(table, ...slice) as any[]).map(row => ({ include: row.include, table: row.tab, access: row.access, line: Number(row.line), statement: row.statement })));
    }
    return rows;
  }

  /**
   * One include's scan, replacing the previous one. Written on the read
   * connection: it is a few rows, and waiting for a load to commit (which
   * holds the write lock for minutes) is what busy_timeout is not for - a
   * scan that cannot be cached is still an answer, so a busy file is reported
   * to the caller rather than waited on.
   */
  saveScan(include: string, stamp: string, sites: TableSiteRow[]): boolean {
    try {
      this.db.exec('PRAGMA busy_timeout = 200');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.statement('DELETE FROM table_sites WHERE include = ?').run(include);
        const insert = this.statement('INSERT INTO table_sites(include, tab, access, line, statement) VALUES (?, ?, ?, ?, ?)');
        for (const site of sites) insert.run(include, site.table, site.access, site.line, site.statement);
        this.statement('INSERT OR REPLACE INTO scanned_includes(include, stamp, scanned_at) VALUES (?, ?, ?)').run(include, stamp, new Date().toISOString());
        this.db.exec('COMMIT');
        return true;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* nothing open */ }
        throw error;
      }
    } catch {
      return false;
    } finally {
      this.db.exec('PRAGMA busy_timeout = 10000');
    }
  }

  /** A connection of its own for a load. */
  writer(): GraphWriter {
    return new GraphWriter(openDatabase(this.file));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Write side: one transaction per load, so that a load that fails half way
 * leaves the graph as it was.
 */
export class GraphWriter {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private open = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  begin(): void {
    // IMMEDIATE takes the write lock now, so a second writer is turned away
    // at the start rather than after minutes of loading.
    this.db.exec('BEGIN IMMEDIATE');
    this.open = true;
  }

  commit(): void {
    if (!this.open) return;
    this.db.exec('COMMIT');
    this.open = false;
    // A full load passes some 270 MB through the WAL, and the file keeps that
    // size until it is truncated - checkpointing alone only reuses it.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a reader holds it; the next commit tries again */ }
  }

  rollback(): void {
    if (!this.open) return;
    try { this.db.exec('ROLLBACK'); } catch { /* already gone with the connection */ }
    this.open = false;
  }

  close(): void {
    this.rollback();
    this.db.close();
  }

  clearAll(): void {
    for (const table of TABLES) this.db.exec(`DELETE FROM ${table}`);
  }

  /** Everything an object contributed, before it is loaded again. */
  deleteOwner(objectType: string, object: string): void {
    this.statement('DELETE FROM edges WHERE src_type = ? AND src_obj = ?').run(objectType, object);
    this.statement('DELETE FROM includes WHERE object_type = ? AND object = ?').run(objectType, object);
    this.statement('DELETE FROM members WHERE object_type = ? AND object = ?').run(objectType, object);
    if (objectType === 'PROG') this.statement('DELETE FROM program_includes WHERE master = ?').run(object);
    this.statement('DELETE FROM search WHERE object = ?').run(object);
    this.statement('DELETE FROM texts WHERE object = ?').run(object);
  }

  /** The TADIR rows of reloaded owners - only the owner types, so a table of the same name stays. */
  deleteObjectRows(names: string[]): void {
    const remove = this.statement("DELETE FROM objects WHERE name = ? AND type IN ('CLAS', 'INTF', 'PROG', 'FUGR')");
    for (const name of names) remove.run(name);
  }

  insertEdges(rows: EdgeRow[]): void {
    const insert = this.statement(
      'INSERT INTO edges(src_obj, src_type, src_member, src_part, include, kind, dst_obj, dst_member, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) {
      insert.run(row.srcObj, row.srcType, row.srcMember, row.srcPart, row.include, row.kind, row.dstObj, row.dstMember, row.origin);
    }
  }

  insertIncludes(rows: IncludeRow[]): void {
    const insert = this.statement(
      'INSERT OR REPLACE INTO includes(include, object, object_type, member, part, subc, stamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) insert.run(row.include, row.object, row.objectType, row.member, row.part, row.subc, row.stamp);
  }

  insertProgramIncludes(rows: { master: string; include: string }[]): void {
    const insert = this.statement('INSERT OR IGNORE INTO program_includes(master, include) VALUES (?, ?)');
    for (const row of rows) insert.run(row.master, row.include);
  }

  insertObjects(rows: ObjectRow[]): void {
    const insert = this.statement('INSERT OR REPLACE INTO objects(type, name, package) VALUES (?, ?, ?)');
    for (const row of rows) insert.run(row.type, row.name, row.package);
  }

  insertMembers(rows: MemberRow[]): void {
    const insert = this.statement('INSERT OR IGNORE INTO members(object, object_type, member, kind) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(row.object, row.objectType, row.member, row.kind);
  }

  insertTexts(rows: TextRow[]): void {
    const insert = this.statement('INSERT OR REPLACE INTO texts(object, member, lang, text) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(row.object, row.member, row.lang, row.text);
  }

  /**
   * The search rows of the given objects (or of every object), from what the
   * other tables now hold: one row per object and one per member, the name
   * split into words plus every text it has.
   */
  rebuildSearch(objects?: string[]): void {
    const textRows = (object: string, member: string) =>
      (this.statement('SELECT text FROM texts WHERE object = ? AND member = ?').all(object, member) as any[]).map(row => row.text);
    const insert = this.statement('INSERT INTO search(object, object_type, member, words) VALUES (?, ?, ?, ?)');
    const index = (object: string, objectType: string, member: string | null) => {
      const words = [object, member || '', ...textRows(object, member || '')].join(' ');
      insert.run(object, objectType, member, normalizeText(words));
    };

    if (!objects) {
      this.db.exec('DELETE FROM search');
      for (const row of this.statement('SELECT DISTINCT name, type FROM objects').all() as any[]) index(row.name, row.type, null);
      for (const row of this.statement('SELECT object, object_type, member FROM members').all() as any[]) index(row.object, row.object_type, row.member);
      return;
    }
    for (const object of objects) {
      this.statement('DELETE FROM search WHERE object = ?').run(object);
      for (const row of this.statement('SELECT DISTINCT name, type FROM objects WHERE name = ?').all(object) as any[]) index(row.name, row.type, null);
      for (const row of this.statement('SELECT object, object_type, member FROM members WHERE object = ?').all(object) as any[]) index(row.object, row.object_type, row.member);
    }
  }

  setMeta(key: string, value: string): void {
    this.statement('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, value);
  }
}
