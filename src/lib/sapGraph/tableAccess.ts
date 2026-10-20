/**
 * Who reads a database table and who writes it.
 *
 * The where-used index records a table used in SQL the way it records a type:
 * SELECT ... JOIN zprices and INCLUDE TYPE zprices both come out as
 * TY ZPRICES in the include. So the index names every place that touches
 * a table - but not what the place does with it. That takes reading the
 * code, and only these places are read: the method a CMnnn include is, the
 * function module, the program include. What the scan finds is kept per
 * include with the include's change stamp, so a question asked again costs
 * nothing, and a delta that changes the include makes it scanned again.
 *
 * A widely used standard table has well over a thousand such places, so a
 * call scans at most maxScan of them and says how many are left; the next
 * call goes on where it stopped, because what was scanned is cached.
 */
import { extractCallsAcross, isTableWrite, TableAccess } from '../abapCalls';
import { ownerOfInclude, sourcePartOf } from './names';
import { sourceUrlOf, methodLines } from './source';
import type { GraphStore, IncludeRow, TableSiteRow } from './store';
import type { GraphExplorer } from './explore';

export interface TablePlace {
  line: number;
  access: string;
  statement: string;
}

/** A method, function module or include that touches the table. */
export interface TableUser {
  name: string;
  kind: string;
  object?: string;
  package?: string;
  text?: string;
  include: string;
  /** Every kind of access, writes first. */
  access: string[];
  places: TablePlace[];
  /** Places beyond the listed ones. */
  morePlaces?: number;
  url?: string;
}

export interface TableAccessResult {
  table: string;
  /** Includes the where-used index names for the table. */
  candidates: number;
  scannedNow: number;
  fromCache: number;
  /** Candidates left for a later call. */
  notScanned: number;
  writers: TableUser[];
  readers: TableUser[];
  /** Places that use the table as a type only - a declaration, a definition section. */
  typeOnly: TableUser[];
  failed: { include: string; error: string }[];
  /** Scans that could not be cached: the graph file was busy with a load. */
  notCached?: number;
}

export interface TableAccessDeps {
  store: GraphStore;
  explorer: GraphExplorer;
  /** Read a source by its ADT address. */
  read(url: string): Promise<string>;
  prefixes: string[];
}

const MAX_PLACES = 5;
const MAX_STATEMENT = 200;

const accessOrder = (a: string, b: string): number =>
  Number(isTableWrite(b as TableAccess)) - Number(isTableWrite(a as TableAccess)) || a.localeCompare(b);

/** The include as the graph knows it, or as far as its name tells. */
function includeOf(store: GraphStore, include: string, prefixes: string[]): IncludeRow {
  const known = store.includeRow(include);
  if (known) return known;
  const owner = ownerOfInclude(include, prefixes);
  return { include, object: owner.object, objectType: owner.objectType, member: null, part: owner.part, subc: null, stamp: null };
}

/**
 * Every table statement of one include. A method include is the method's
 * lines of the class source; anything else is its own source. Lines are the
 * lines of the source at the returned address, so they can be opened there.
 */
async function scanInclude(row: IncludeRow, read: (url: string) => Promise<string>): Promise<{ url: string; sites: TableSiteRow[] }> {
  const url = sourceUrlOf({ objectType: row.objectType, object: row.object, member: row.member, part: row.part, include: row.include, subc: row.subc });
  if (!url) throw new Error('no source address for this include');
  const source = await read(url);
  const lines = source.split(/\r?\n/);
  let offset = 0;
  let region = lines;
  if (row.objectType === 'CLAS' && row.part.startsWith('CM')) {
    if (!row.member) throw new Error('the graph does not know which method this include is - load or refresh the graph');
    const range = methodLines(lines, row.member);
    if (!range) throw new Error(`METHOD ${row.member.toLowerCase()} is not in the class source`);
    offset = range.from;
    region = lines.slice(range.from, range.to + 1);
  }
  const found = extractCallsAcross([{ name: row.include, source: region.join('\n') }], { onlyCustom: false, kinds: ['table'] });
  const sites = found.calls
    .filter(call => call.kind === 'table' && call.access)
    .map(call => ({ include: row.include, table: call.target, access: call.access!, line: call.line + offset, statement: call.statement }));
  return { url, sites };
}

/** Who reads and who writes a table, from the includes the index names for it. */
export async function tableAccess(table: string, candidates: string[], deps: TableAccessDeps, maxScan: number): Promise<TableAccessResult> {
  const { store, explorer, read, prefixes } = deps;
  const name = table.trim().toUpperCase();
  const includes = [...new Set(candidates.map(include => include.trim().toUpperCase()).filter(Boolean))].sort();
  const result: TableAccessResult = {
    table: name, candidates: includes.length, scannedNow: 0, fromCache: 0, notScanned: 0,
    writers: [], readers: [], typeOnly: [], failed: []
  };

  const users = new Map<string, TableUser>();
  const userOf = (row: IncludeRow, url?: string): TableUser => {
    const node = explorer.nodeOf(row.objectType, row.object, row.member);
    const key = `${node.label}|${row.include}`;
    let user = users.get(key);
    if (!user) {
      user = {
        name: node.label, kind: node.kind,
        ...(node.member || node.kind === 'function' ? { object: node.object } : {}),
        ...(node.package ? { package: node.package } : {}),
        ...(node.text ? { text: node.text } : {}),
        include: row.include, access: [], places: [], ...(url ? { url } : {})
      };
      users.set(key, user);
    }
    return user;
  };
  const record = (row: IncludeRow, sites: TableSiteRow[], url?: string) => {
    const user = userOf(row, url);
    for (const site of sites.filter(item => item.table === name)) {
      if (!user.access.includes(site.access)) user.access.push(site.access);
      // A join over four tables with FOR ALL ENTRIES runs past 400 characters;
      // the head of it is what tells the place, the line is where the rest is.
      const statement = site.statement.length > MAX_STATEMENT ? `${site.statement.slice(0, MAX_STATEMENT)}…` : site.statement;
      user.places.push({ line: site.line, access: site.access, statement });
    }
  };

  for (const include of includes) {
    const row = includeOf(store, include, prefixes);
    if (sourcePartOf(row) === 'definition') {
      // A definition section declares; it does not run SQL.
      userOf(row);
      continue;
    }
    const stamp = row.stamp || '';
    if (store.scannedStamp(include) === stamp) {
      result.fromCache += 1;
      record(row, store.tableSites(name, [include]));
      continue;
    }
    if (result.scannedNow >= maxScan) {
      result.notScanned += 1;
      continue;
    }
    result.scannedNow += 1;
    try {
      const { url, sites } = await scanInclude(row, read);
      if (!store.saveScan(include, stamp, sites)) result.notCached = (result.notCached || 0) + 1;
      record(row, sites, url);
    } catch (error: any) {
      result.failed.push({ include, error: String(error?.message || error) });
    }
  }

  for (const user of users.values()) {
    user.access.sort(accessOrder);
    user.places.sort((a, b) => accessOrder(a.access, b.access) || a.line - b.line);
    if (user.places.length > MAX_PLACES) {
      user.morePlaces = user.places.length - MAX_PLACES;
      user.places = user.places.slice(0, MAX_PLACES);
    }
    if (user.access.some(access => isTableWrite(access as TableAccess))) result.writers.push(user);
    else if (user.access.includes('read')) result.readers.push(user);
    else result.typeOnly.push(user);
  }
  const byName = (a: TableUser, b: TableUser) => a.name.localeCompare(b.name);
  result.writers.sort(byName);
  result.readers.sort(byName);
  result.typeOnly.sort(byName);
  return result;
}
