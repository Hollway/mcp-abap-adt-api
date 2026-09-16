/**
 * Reading what an operator reads: background jobs, spool requests, the
 * application log.
 *
 * All three are transactions in SAPGUI - SM37, SP01, SLG1 - and none of them
 * has an ADT endpoint. What they do have is tables, and the data preview reads
 * tables without executing anything: TBTCO and TBTCP for the jobs, TSP01 for
 * the spool, BALHDR for the log headers. That matters twice over. It works on
 * a system where nothing may run, and it needs no developer key.
 *
 * Two constraints shape everything here. The data preview refuses a SELECT
 * longer than 255 characters (see queryLimits), which is why the field lists
 * are the fields worth having rather than every field; and a date column comes
 * back as a Date object, which is why nothing is put into an answer with
 * String() - see isoDate.
 *
 * What is NOT here, deliberately: the message text of an application log. It
 * lives in BALDAT as a compressed cluster, not as rows, so a SELECT cannot
 * read it - the counts per severity are in the header and the text is not.
 */

import { quoteSql as quote, MAX_QUERY_CHARS } from './queryLimits';
import { isoDate } from './transportHygiene';

export class OperationsQueryError extends Error {}

/* ------------------------------------------------------------ small parts */

/** A date the caller wrote, as the eight digits ABAP stores. */
export function abapDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length !== 8) {
    throw new OperationsQueryError(
      `"${value}" is not a date: write it as YYYYMMDD or YYYY-MM-DD.`
    );
  }
  return digits;
}

/** ABAP time as HH:MM:SS, from the six digits or the Date the preview sends. */
export function abapTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return value.toISOString().slice(11, 19);
  const digits = String(value).replace(/[^0-9]/g, '');
  if (digits.length < 6) return String(value);
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
}

/** Date and time of one row as one readable stamp. */
export const stamp = (date: unknown, time: unknown): string | undefined => {
  const day = isoDate(date);
  if (!day || day === '0000-00-00') return undefined;
  const clock = abapTime(time);
  return clock ? `${day} ${clock}` : day;
};

/**
 * A name a caller typed, for a WHERE clause.
 *
 * Only what a SAP name can hold, so nothing a user writes can reach the
 * statement as syntax. A trailing * becomes the LIKE it looks like.
 */
export function namePattern(value: unknown, what: string): { sql: string; like: boolean } {
  const text = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_/$*.\-]{1,40}$/.test(text)) {
    throw new OperationsQueryError(
      `"${value}" is not a ${what}: letters, digits and _ / $ . - only, with * at the end for a prefix.`
    );
  }
  if (text.includes('*')) return { sql: text.replace(/\*/g, '%'), like: true };
  return { sql: text, like: false };
}

/** WHERE fragment for a name that may be a prefix. */
export const nameCondition = (field: string, value: unknown, what: string): string => {
  const { sql, like } = namePattern(value, what);
  return like ? `${field} LIKE ${quote(sql)}` : `${field} = ${quote(sql)}`;
};

/** Join the conditions, and refuse a statement the endpoint would refuse. */
export function statement(select: string, conditions: string[], order?: string): string {
  const where = conditions.filter(Boolean);
  const sql = [select, where.length ? `WHERE ${where.join(' AND ')}` : '', order ? `ORDER BY ${order}` : '']
    .filter(Boolean)
    .join(' ');
  if (sql.length > MAX_QUERY_CHARS) {
    throw new OperationsQueryError(
      `That is ${sql.length} characters of SELECT and the data preview refuses anything over ${MAX_QUERY_CHARS}. ` +
      'Drop a filter, or shorten the names in it.'
    );
  }
  return sql;
}

/* -------------------------------------------------------------------- jobs */

/** What TBTCO-STATUS means. The letters are the same on every system. */
export const JOB_STATUS: Record<string, string> = {
  P: 'scheduled',
  S: 'released',
  Y: 'ready',
  R: 'running',
  F: 'finished',
  A: 'cancelled',
  X: 'unknown'
};

/** The letter for a status a caller named in words, or the letter itself. */
export function jobStatusLetter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toUpperCase();
  if (JOB_STATUS[text]) return text;
  const found = Object.entries(JOB_STATUS).find(([, word]) => word.toUpperCase() === text);
  if (found) return found[0];
  throw new OperationsQueryError(
    `"${value}" is not a job status. Use one of: ${Object.values(JOB_STATUS).join(', ')}, or its letter.`
  );
}

const JOB_FIELDS = 'jobname, jobcount, status, sdluname, authcknam, strtdate, strttime, enddate, endtime';

export interface JobFilter {
  jobName?: unknown;
  /** The user the job runs as (AUTHCKNAM). */
  user?: unknown;
  /** Who scheduled it (SDLUNAME). */
  scheduledBy?: unknown;
  status?: unknown;
  /** Only jobs whose start date is this or later. */
  since?: unknown;
}

export function jobQuery(filter: JobFilter): string {
  const conditions: string[] = [];
  if (filter.jobName) conditions.push(nameCondition('jobname', filter.jobName, 'job name'));
  if (filter.user) conditions.push(nameCondition('authcknam', filter.user, 'user name'));
  if (filter.scheduledBy) conditions.push(nameCondition('sdluname', filter.scheduledBy, 'user name'));
  const status = jobStatusLetter(filter.status);
  if (status) conditions.push(`status = ${quote(status)}`);
  const since = abapDate(filter.since);
  if (since) conditions.push(`strtdate >= ${quote(since)}`);
  return statement(`SELECT ${JOB_FIELDS} FROM tbtco`, conditions, 'strtdate DESCENDING, strttime DESCENDING');
}

export interface JobRow {
  name: string;
  count: string;
  status: string;
  statusMeaning: string;
  scheduledBy?: string;
  runsAs?: string;
  started?: string;
  ended?: string;
  steps?: StepRow[];
}

export const describeJob = (row: Record<string, any>): JobRow => {
  const status = String(row.STATUS ?? '').toUpperCase();
  return {
    name: String(row.JOBNAME ?? ''),
    count: String(row.JOBCOUNT ?? ''),
    status,
    statusMeaning: JOB_STATUS[status] || 'unknown',
    ...(row.SDLUNAME ? { scheduledBy: String(row.SDLUNAME) } : {}),
    ...(row.AUTHCKNAM ? { runsAs: String(row.AUTHCKNAM) } : {}),
    ...(stamp(row.STRTDATE, row.STRTTIME) ? { started: stamp(row.STRTDATE, row.STRTTIME) } : {}),
    ...(stamp(row.ENDDATE, row.ENDTIME) ? { ended: stamp(row.ENDDATE, row.ENDTIME) } : {})
  };
};

/** The steps of one job: which program ran, under which variant, to which spool. */
export const stepQuery = (jobName: string, jobCount: string): string =>
  statement(
    'SELECT jobname, jobcount, stepcount, progname, variant, authcknam, listident FROM tbtcp',
    [`jobname = ${quote(jobName)}`, `jobcount = ${quote(jobCount)}`],
    'stepcount'
  );

export interface StepRow {
  step: number;
  program?: string;
  variant?: string;
  runsAs?: string;
  /** Spool request the step produced, where it produced one. */
  spoolRequest?: string;
}

export const describeStep = (row: Record<string, any>): StepRow => ({
  step: Number(row.STEPCOUNT ?? 0),
  ...(row.PROGNAME ? { program: String(row.PROGNAME).trim() } : {}),
  ...(String(row.VARIANT ?? '').trim() ? { variant: String(row.VARIANT).trim() } : {}),
  ...(row.AUTHCKNAM ? { runsAs: String(row.AUTHCKNAM) } : {}),
  ...(String(row.LISTIDENT ?? '0') !== '0' ? { spoolRequest: String(row.LISTIDENT) } : {})
});

/* ------------------------------------------------------------------- spool */

const SPOOL_FIELDS = 'rqident, rqowner, rqclient, rqcretime, rqdest, rqtitle, rqfinal, rqdoctype';

export interface SpoolFilter {
  owner?: unknown;
  /** Only requests created on this day or later. */
  since?: unknown;
  /** The printer or output device. */
  destination?: unknown;
}

export function spoolQuery(filter: SpoolFilter): string {
  const conditions: string[] = [];
  if (filter.owner) conditions.push(nameCondition('rqowner', filter.owner, 'user name'));
  if (filter.destination) conditions.push(nameCondition('rqdest', filter.destination, 'device name'));
  const since = abapDate(filter.since);
  // RQCRETIME is a 16-character stamp, not a date: YYYYMMDDHHMMSSnn, so a
  // comparison against the day plus zeros is the whole day and after it.
  if (since) conditions.push(`rqcretime >= ${quote(`${since}00000000`)}`);
  return statement(`SELECT ${SPOOL_FIELDS} FROM tsp01`, conditions, 'rqcretime DESCENDING');
}

/** The 16-character spool stamp, as a readable one. */
export function spoolTime(value: unknown): string | undefined {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 14) return undefined;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)} ` +
    `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
}

export interface SpoolRow {
  id: string;
  owner: string;
  client?: string;
  title?: string;
  /**
   * TSP01 records the creation stamp in UTC, while a job's start time in TBTCO
   * is the system's local time - measured on a system three hours ahead of
   * UTC, where the spool a job had just produced read three hours older than
   * the job. Named for what it is rather than converted with a guess at the
   * system time zone.
   */
  createdUtc?: string;
  destination?: string;
  /** X once the request is complete and may be printed. */
  complete: boolean;
  documentType?: string;
}

export const describeSpool = (row: Record<string, any>): SpoolRow => ({
  id: String(row.RQIDENT ?? ''),
  owner: String(row.RQOWNER ?? ''),
  ...(row.RQCLIENT ? { client: String(row.RQCLIENT) } : {}),
  ...(String(row.RQTITLE ?? '').trim() ? { title: String(row.RQTITLE).trim() } : {}),
  ...(spoolTime(row.RQCRETIME) ? { createdUtc: spoolTime(row.RQCRETIME) } : {}),
  ...(String(row.RQDEST ?? '').trim() ? { destination: String(row.RQDEST).trim() } : {}),
  complete: String(row.RQFINAL ?? '').toUpperCase() === 'X',
  ...(String(row.RQDOCTYPE ?? '').trim() ? { documentType: String(row.RQDOCTYPE).trim() } : {})
});

/* --------------------------------------------------------- application log */

const LOG_FIELDS = 'lognumber, object, subobject, extnumber, aldate, altime, aluser, alprog';
const COUNT_FIELDS = 'lognumber, msg_cnt_a, msg_cnt_e, msg_cnt_w, msg_cnt_i, msg_cnt_s';

export interface LogFilter {
  object?: unknown;
  subObject?: unknown;
  user?: unknown;
  since?: unknown;
}

export function logQuery(filter: LogFilter): string {
  const conditions: string[] = [];
  if (filter.object) conditions.push(nameCondition('object', filter.object, 'log object'));
  if (filter.subObject) conditions.push(nameCondition('subobject', filter.subObject, 'log subobject'));
  if (filter.user) conditions.push(nameCondition('aluser', filter.user, 'user name'));
  const since = abapDate(filter.since);
  if (since) conditions.push(`aldate >= ${quote(since)}`);
  return statement(`SELECT ${LOG_FIELDS} FROM balhdr`, conditions, 'aldate DESCENDING, altime DESCENDING');
}

/** The message counts of logs already read, in as many statements as the limit forces. */
export function logCountQueries(logNumbers: string[]): string[] {
  const queries: string[] = [];
  let batch: string[] = [];
  const build = (numbers: string[]) =>
    `SELECT ${COUNT_FIELDS} FROM balhdr WHERE lognumber IN (${numbers.map(quote).join(', ')})`;
  for (const number of logNumbers) {
    const next = [...batch, number];
    if (build(next).length > MAX_QUERY_CHARS) {
      if (batch.length) queries.push(build(batch));
      batch = [number];
    } else {
      batch = next;
    }
  }
  if (batch.length) queries.push(build(batch));
  return queries;
}

export interface LogRow {
  logNumber: string;
  object: string;
  subObject?: string;
  externalId?: string;
  written?: string;
  user?: string;
  program?: string;
  messages?: { abort: number; error: number; warning: number; info: number; success: number; total: number };
}

export const describeLog = (row: Record<string, any>): LogRow => ({
  logNumber: String(row.LOGNUMBER ?? ''),
  object: String(row.OBJECT ?? '').trim(),
  ...(String(row.SUBOBJECT ?? '').trim() ? { subObject: String(row.SUBOBJECT).trim() } : {}),
  ...(String(row.EXTNUMBER ?? '').trim() ? { externalId: String(row.EXTNUMBER).trim() } : {}),
  ...(stamp(row.ALDATE, row.ALTIME) ? { written: stamp(row.ALDATE, row.ALTIME) } : {}),
  ...(String(row.ALUSER ?? '').trim() ? { user: String(row.ALUSER).trim() } : {}),
  ...(String(row.ALPROG ?? '').trim() ? { program: String(row.ALPROG).trim() } : {})
});

/** The per-severity counts of one header row. */
export const messageCounts = (row: Record<string, any>) => {
  const n = (value: unknown) => Number(value ?? 0) || 0;
  const counts = {
    abort: n(row.MSG_CNT_A),
    error: n(row.MSG_CNT_E),
    warning: n(row.MSG_CNT_W),
    info: n(row.MSG_CNT_I),
    success: n(row.MSG_CNT_S),
    total: 0
  };
  counts.total = counts.abort + counts.error + counts.warning + counts.info + counts.success;
  return counts;
};
