/**
 * Transport hygiene, read from the tables the organizer keeps.
 *
 * Three questions come up before a request is released, and none of them had
 * an answer here:
 *
 *  - where else does this object travel? SE03 answers it by object, one
 *    search mask at a time, and the parts of an object - REPS, REPT, METH,
 *    CLSD - are recorded under their own entries, so an object can sit in a
 *    request under a name the caller never asked about;
 *  - is anything in my request also sitting in somebody else's open request?
 *    That is the case that overwrites work: measured on a classic ERP system,
 *    one report was recorded in eleven requests, three of them still
 *    modifiable and owned by three different people;
 *  - is the request releasable at all - its tasks closed, its objects active,
 *    nothing of mine still locked?
 *
 * Everything here is a read: E070 for the headers, E071 for the objects, E07T
 * for the descriptions, REPOSRC and the DDIC tables for what is still
 * inactive. Nothing in the transport is touched.
 *
 * On the activation check specifically: reading an object through ADT cannot
 * answer it. objectStructure reports version "active" for an object that has
 * an inactive version saved, and asking for version "inactive" explicitly
 * answers with the active one rather than with nothing - measured on an
 * include whose inactive version is four years old. What does answer it is
 * REPOSRC.R3STATE = 'I' for anything with source, and AS4LOCAL = 'N' for the
 * dictionary, both in one read for the whole request.
 */

/** Request and task numbers are ten characters of the transport layer alphabet. */
export function normalizeRequest(input: unknown): string {
  const value = String(input ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{2}K[A-Z0-9]{6}$/.test(value)) {
    throw new Error(
      `"${input}" is not a transport request number: they are ten characters, e.g. DEVK900123. ` +
      'userTransports lists the ones you own.'
    );
  }
  return value;
}

/** Repository object names, as E071 records them. */
export function isObjectNameSafe(name: unknown): boolean {
  return /^[A-Z0-9_/$=<>+.\-]{1,40}$/.test(String(name ?? '').toUpperCase());
}

import { MAX_QUERY_CHARS, chunkedQueries, quoteSql as quote } from './queryLimits';

export { MAX_QUERY_CHARS, chunkedQueries };

export const STATUS_TEXT: Record<string, string> = {
  D: 'modifiable',
  L: 'modifiable, protected',
  O: 'release started',
  R: 'released',
  N: 'released, import protected'
};

export const FUNCTION_TEXT: Record<string, string> = {
  K: 'workbench request',
  W: 'customizing request',
  S: 'development/correction task',
  R: 'repair task',
  Q: 'customizing task',
  T: 'transport of copies',
  C: 'relocation of objects',
  X: 'unclassified task'
};

export const isOpen = (status: string) => status === 'D' || status === 'L';

/**
 * A date column of the data preview arrives as a Date, and String(Date) reads
 * "Tue Sep 15 2026 ..." - which is how the first live run of this reported
 * every transport date.
 */
export function isoDate(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text.slice(0, 10);
}

/* ------------------------------------------------------------------ reads */

/** The request and every task under it. Two statements: neither fits with the other. */
export const headerQuery = (trkorr: string) =>
  `SELECT trkorr, trfunction, trstatus, as4user, as4date, strkorr FROM e070 WHERE trkorr = ${quote(trkorr)} OR strkorr = ${quote(trkorr)}`;

export const headerQueries = (trkorrs: string[]) =>
  chunkedQueries('SELECT trkorr, trfunction, trstatus, as4user, as4date, strkorr FROM e070 WHERE trkorr IN (', trkorrs);

export const textQueries = (trkorrs: string[]) =>
  chunkedQueries('SELECT trkorr, langu, as4text FROM e07t WHERE trkorr IN (', trkorrs);

export const objectQueries = (trkorrs: string[]) =>
  chunkedQueries('SELECT trkorr, as4pos, pgmid, object, obj_name FROM e071 WHERE trkorr IN (', trkorrs);

/** Every entry of these objects, in any request. The header comes separately. */
export const entriesByObjectQueries = (names: string[]) =>
  chunkedQueries('SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE obj_name IN (', names);

/** Sources with an inactive version saved and never activated. */
export const inactiveSourceQueries = (names: string[], prefixes: string[]) => {
  const queries = chunkedQueries(
    "SELECT progname, r3state, unam, udat FROM reposrc WHERE r3state = 'I' AND progname IN (",
    names
  );
  // Class and interface parts are matched by prefix, and each pattern is long,
  // so only a few of them fit into one statement.
  const head = "SELECT progname, r3state, unam, udat FROM reposrc WHERE r3state = 'I' AND ( ";
  let current: string[] = [];
  const flush = () => {
    if (current.length) queries.push(head + current.join(' OR ') + ' )');
    current = [];
  };
  for (const prefix of prefixes) {
    const term = `progname LIKE ${quote(`${prefix}%`)}`;
    if (current.length && head.length + [...current, term].join(' OR ').length + 2 > MAX_QUERY_CHARS) flush();
    current.push(term);
  }
  flush();
  return queries;
};

/** Dictionary entries whose active version is not the current one. */
export const inactiveDdicQueries = (table: 'dd02l' | 'dd04l' | 'dd01l', field: string, names: string[]) =>
  chunkedQueries(`SELECT ${field}, as4local, as4user FROM ${table} WHERE as4local = 'N' AND ${field} IN (`, names);

/** The rows of a data-preview answer, whatever wrapper it arrived in. */
export function rowsOf(result: any): Record<string, any>[] {
  const values = result?.values ?? result?.result?.values ?? [];
  return Array.isArray(values) ? values : [];
}

/* ---------------------------------------------------------------- shaping */

export interface TransportRow {
  number: string;
  type: string;
  typeText: string;
  status: string;
  statusText: string;
  owner: string;
  date?: string;
  parent?: string;
  description?: string;
  open: boolean;
}

export function describeRequest(row: Record<string, any>, texts: Map<string, string>): TransportRow {
  const status = String(row.TRSTATUS ?? '');
  const type = String(row.TRFUNCTION ?? '');
  const number = String(row.TRKORR ?? '');
  return {
    number,
    type,
    typeText: FUNCTION_TEXT[type] || 'unknown type',
    status,
    statusText: STATUS_TEXT[status] || 'unknown status',
    owner: String(row.AS4USER ?? ''),
    date: isoDate(row.AS4DATE),
    parent: String(row.STRKORR ?? '') || undefined,
    description: texts.get(number),
    open: isOpen(status)
  };
}

export function textMap(rows: Record<string, any>[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const row of rows) {
    const number = String(row.TRKORR ?? '');
    const text = String(row.AS4TEXT ?? '');
    if (number && text && !texts.has(number)) texts.set(number, text);
  }
  return texts;
}

export interface ObjectPart {
  pgmid: string;
  object: string;
  name: string;
}

export function objectParts(rows: Record<string, any>[]): ObjectPart[] {
  return rows.map(row => ({
    pgmid: String(row.PGMID ?? ''),
    object: String(row.OBJECT ?? ''),
    name: String(row.OBJ_NAME ?? '')
  }));
}

/** One line per request an object has travelled in, newest first. */
export function historyOf(objectName: string, rows: Record<string, any>[], texts: Map<string, string>) {
  const byRequest = new Map<string, { row: Record<string, any>; parts: Set<string> }>();
  for (const row of rows) {
    const number = String(row.TRKORR ?? '');
    if (!number) continue;
    const entry = byRequest.get(number) || { row, parts: new Set<string>() };
    entry.parts.add(`${row.PGMID} ${row.OBJECT}`);
    byRequest.set(number, entry);
  }
  const requests = [...byRequest.values()]
    .map(entry => ({ ...describeRequest(entry.row, texts), parts: [...entry.parts].sort() }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.number.localeCompare(a.number));
  return {
    object: objectName,
    summary: {
      requests: requests.length,
      open: requests.filter(r => r.open).length,
      released: requests.filter(r => !r.open).length,
      owners: [...new Set(requests.map(r => r.owner))].filter(Boolean)
    },
    requests
  };
}

export interface ConflictRow {
  object: string;
  pgmid: string;
  type: string;
  otherRequest: string;
  owner: string;
  status: string;
  statusText: string;
  description?: string;
}

/**
 * The objects of one request that are also recorded in somebody else's open
 * request. Tasks of the same request are not conflicts with it.
 */
export function conflictsOf(
  mine: ObjectPart[],
  others: Record<string, any>[],
  ownNumbers: Set<string>,
  texts: Map<string, string>
) {
  const wanted = new Set(mine.map(part => `${part.pgmid}|${part.object}|${part.name}`));
  const rows: ConflictRow[] = [];
  for (const row of others) {
    const number = String(row.TRKORR ?? '');
    if (ownNumbers.has(number)) continue;
    if (!isOpen(String(row.TRSTATUS ?? ''))) continue;
    const key = `${row.PGMID}|${row.OBJECT}|${row.OBJ_NAME}`;
    if (!wanted.has(key)) continue;
    rows.push({
      object: String(row.OBJ_NAME ?? ''),
      pgmid: String(row.PGMID ?? ''),
      type: String(row.OBJECT ?? ''),
      otherRequest: number,
      owner: String(row.AS4USER ?? ''),
      status: String(row.TRSTATUS ?? ''),
      statusText: STATUS_TEXT[String(row.TRSTATUS ?? '')] || 'unknown status',
      description: texts.get(number)
    });
  }
  const conflicting = new Set(rows.map(row => `${row.pgmid}|${row.type}|${row.object}`));
  return {
    summary: {
      objects: mine.length,
      conflicting: conflicting.size,
      otherRequests: new Set(rows.map(row => row.otherRequest)).size,
      owners: [...new Set(rows.map(row => row.owner))].filter(Boolean)
    },
    conflicts: rows.sort((a, b) => a.object.localeCompare(b.object) || a.otherRequest.localeCompare(b.otherRequest))
  };
}

/* -------------------------------------------------------- what is inactive */

/** Program names in REPOSRC for the source-bearing objects of a request. */
export function sourceNames(parts: ObjectPart[]): { names: string[]; prefixes: string[] } {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const part of parts) {
    const name = part.name.toUpperCase();
    if (!isObjectNameSafe(name)) continue;
    switch (part.object) {
      case 'PROG':
      case 'REPS':
      case 'REPT':
      case 'FUNC':
      case 'FUGR':
        names.add(name);
        break;
      case 'CLAS':
      case 'INTF':
      case 'METH':
      case 'CPUB':
      case 'CPRO':
      case 'CPRI':
      case 'CINC':
      case 'CLSD':
        // Class and interface sources live under the name padded with '=' to
        // thirty characters plus a part suffix: CL_X=====...=====CCIMP.
        prefixes.add(name.length >= 30 ? name : name.padEnd(30, '='));
        break;
      default:
        break;
    }
  }
  return { names: [...names], prefixes: [...prefixes] };
}

/** Dictionary names of a request, by the table that records their state. */
export function ddicNames(parts: ObjectPart[]) {
  const pick = (types: string[]) => [
    ...new Set(
      parts
        .filter(part => types.includes(part.object) && isObjectNameSafe(part.name))
        .map(part => part.name.toUpperCase())
    )
  ];
  return {
    tables: pick(['TABL', 'TABD', 'VIEW']),
    dataElements: pick(['DTEL', 'DTED']),
    domains: pick(['DOMA', 'DOMD'])
  };
}

export interface InactiveRow {
  name: string;
  where: string;
  changedBy?: string;
  changedAt?: string;
}

export function inactiveSources(rows: Record<string, any>[]): InactiveRow[] {
  return rows.map(row => ({
    name: String(row.PROGNAME ?? '').replace(/=+(?=[A-Z0-9]+$)/, ' '),
    where: 'REPOSRC',
    changedBy: String(row.UNAM ?? '') || undefined,
    changedAt: isoDate(row.UDAT)
  }));
}

export function inactiveDdic(rows: Record<string, any>[], field: string, where: string): InactiveRow[] {
  return rows.map(row => ({
    name: String(row[field] ?? ''),
    where,
    changedBy: String(row.AS4USER ?? '') || undefined
  }));
}

/* ------------------------------------------------------------- readiness */

export interface ReadinessCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export function readinessVerdict(input: {
  request?: TransportRow;
  tasks: TransportRow[];
  objects: ObjectPart[];
  conflicts: ConflictRow[];
  inactive: InactiveRow[];
  locks: string[];
  activationChecked: boolean;
}): { ready: boolean; checks: ReadinessCheck[] } {
  const checks: ReadinessCheck[] = [];
  const openTasks = input.tasks.filter(task => task.open);

  checks.push({
    check: 'status',
    ok: !!input.request && isOpen(input.request.status),
    detail: input.request
      ? `${input.request.number} is ${input.request.statusText}, owned by ${input.request.owner}`
      : 'the request was not found in E070'
  });

  checks.push({
    check: 'tasks',
    ok: openTasks.length === 0,
    detail: openTasks.length === 0
      ? `${input.tasks.length} task(s), all released`
      : `${openTasks.length} of ${input.tasks.length} task(s) still open: ${openTasks.map(t => `${t.number} (${t.owner})`).join(', ')} - a request cannot be released while a task under it is`
  });

  checks.push({
    check: 'objects',
    ok: input.objects.length > 0,
    detail: input.objects.length > 0
      ? `${input.objects.length} object entries`
      : 'the request is empty - releasing it transports nothing'
  });

  checks.push({
    check: 'conflicts',
    ok: input.conflicts.length === 0,
    detail: input.conflicts.length === 0
      ? 'no object of this request sits in somebody else open request'
      : `${new Set(input.conflicts.map(c => c.object)).size} object(s) also sit in ${new Set(input.conflicts.map(c => c.otherRequest)).size} other open request(s), owned by ${[...new Set(input.conflicts.map(c => c.owner))].join(', ')}`
  });

  checks.push({
    check: 'activation',
    ok: input.activationChecked ? input.inactive.length === 0 : true,
    detail: !input.activationChecked
      ? 'not checked'
      : input.inactive.length === 0
        ? 'nothing in the request has an inactive version saved'
        : `${input.inactive.length} object(s) have an inactive version saved and never activated: ${input.inactive.slice(0, 10).map(row => row.name).join(', ')}`
  });

  checks.push({
    check: 'locks',
    ok: input.locks.length === 0,
    detail: input.locks.length === 0
      ? 'this server holds no lock on the objects of the request'
      : `this server still holds a lock on ${input.locks.join(', ')} - unLock them before releasing`
  });

  return { ready: checks.every(check => check.ok), checks };
}
