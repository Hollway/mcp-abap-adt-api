/**
 * Deleting a dictionary object - domain, data element, table or structure -
 * the way SE11 does it: RS_DD_DELETE_OBJ, run in a throwaway class.
 *
 * ADT does not reach these on every release (no /ddic/domains and no
 * /ddic/tables on the ERP system these tools were written against), and the
 * module is what SE11 itself calls. What it does, read in its source:
 *
 *  - with no_ask it refuses rather than asks: an object that is still used
 *    (the where-used list, DD references included) or a table that holds data
 *    in any client ends with DIALOG_NEEDED, E2/071. So a used object cannot be
 *    deleted here at all, and the preview says so up front;
 *  - a few of its refusals are a MESSAGE and an EXIT with no exception - a
 *    table locked for conversion, a generated DDL view - and then it returns
 *    with subrc 0 having deleted nothing. The deletion is therefore proven
 *    from DD01L/DD04L/DD02L afterwards, never taken from the subrc;
 *  - it records the deletion itself (RS_CORR_INSERT, object class DICT) in
 *    the caller's task of the request it is given, and in a local package it
 *    removes the directory entry;
 *  - the snippet must not name the object statically: the module counts the
 *    snippet as a user and refuses with E2/071 (measured 2026-10-13). The name
 *    only ever appears here as a literal.
 *
 * Withdrawing is the other way to delete: for an object that was created in a
 * request still open and never left this system, a deletion recorded for
 * transport is a deletion of something no other system has. Withdrawing takes
 * every entry of the object off its open requests (TR_DELETE_COMM_OBJECT_KEYS,
 * which drops the TLOCK with it) and removes the directory entry - otherwise
 * the task cannot be deleted in SE09 and TADIR keeps a deleted object
 * (measured 2026-10-13).
 */
import { createHash } from 'crypto';
import { charLiteral } from './textPool';
import {
  DDIF_DECLARATIONS,
  DDIF_SEPARATOR,
  DdifError,
  ddicObjectName,
  infoLine,
  isLocalPackage,
  ownStepLine,
  stepLines
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';
import { rowCountLines } from './tableDdif';
import { DELETE_EXCEPTIONS, READ_EXCEPTIONS } from './transportMove';
import { transportNumber } from './transportRegistration';

export type DdicKind = 'DOMA' | 'DTEL' | 'TABL';

interface KindInfo {
  what: string;
  /** RS_DD_DELETE_OBJ's object type: D, E, T (it tells table from structure itself). */
  euType: string;
  /** The header table and its key column. */
  header: string;
  key: string;
  /** Where ADT keeps the object, for the code where-used. */
  adtCollection: string;
}

const KINDS: Record<DdicKind, KindInfo> = {
  DOMA: { what: 'domain', euType: 'D', header: 'dd01l', key: 'domname', adtCollection: 'ddic/domains' },
  DTEL: { what: 'data element', euType: 'E', header: 'dd04l', key: 'rollname', adtCollection: 'ddic/dataelements' },
  TABL: { what: 'table or structure', euType: 'T', header: 'dd02l', key: 'tabname', adtCollection: 'ddic/structures' }
};

const ALIASES: Record<string, DdicKind> = {
  DOMA: 'DOMA', 'DOMA/DD': 'DOMA', DOMAIN: 'DOMA',
  DTEL: 'DTEL', 'DTEL/DE': 'DTEL', DATAELEMENT: 'DTEL', DATA_ELEMENT: 'DTEL',
  TABL: 'TABL', 'TABL/DT': 'TABL', 'TABL/DS': 'TABL', TABLE: 'TABL', STRUCTURE: 'TABL'
};

/** The object type, from TADIR's name or ADT's, or a word. */
export function ddicKind(value: unknown): DdicKind {
  const kind = ALIASES[String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')];
  if (!kind) {
    throw new DdifError(`'${value}' is not a dictionary type this deletes: DOMA (domain), DTEL (data element) or TABL (table or structure).`);
  }
  return kind;
}

export const ddicName = (kind: DdicKind, value: unknown): string => ddicObjectName(value, KINDS[kind].what, 30);

export const kindInfo = (kind: DdicKind): KindInfo => KINDS[kind];

/** Table classes this deletes. A view, an append or a pool is not a table to drop by name here. */
export const DELETABLE_TABLE_CLASSES = ['TRANSP', 'INTTAB'];

// ---------------------------------------------------------------------------
// Reading the current state.
// ---------------------------------------------------------------------------

export function headerSql(kind: DdicKind, name: string): string {
  const info = KINDS[kind];
  const columns = kind === 'TABL' ? 'as4local, tabclass, contflag' : 'as4local';
  return `SELECT ${columns} FROM ${info.header} WHERE ${info.key} = '${ddicName(kind, name)}'`;
}

export const directorySql = (kind: DdicKind, name: string): string =>
  `SELECT devclass, author, srcsystem, delflag FROM tadir WHERE pgmid = 'R3TR' AND object = '${kind}' AND obj_name = '${ddicName(kind, name)}'`;

/** Every request entry of the object, with the status of the request or task that holds it. */
export const entriesSql = (kind: DdicKind, name: string): string =>
  'SELECT e~trkorr, e~objfunc, h~trstatus, h~strkorr FROM e071 AS e INNER JOIN e070 AS h ON h~trkorr = e~trkorr ' +
  `WHERE e~pgmid = 'R3TR' AND e~object = '${kind}' AND e~obj_name = '${ddicName(kind, name)}'`;

/** Who uses the object, in the dictionary. Each query is one kind of user. */
export function usageSqls(kind: DdicKind, name: string): Record<string, string> {
  const n = ddicName(kind, name);
  switch (kind) {
    case 'DOMA':
      return { dataElements: `SELECT rollname FROM dd04l WHERE domname = '${n}' AND as4local = 'A'` };
    case 'DTEL':
      return {
        fields: `SELECT tabname, fieldname FROM dd03l WHERE rollname = '${n}' AND as4local = 'A'`,
        tableTypes: `SELECT typename FROM dd40l WHERE rowtype = '${n}' AND as4local = 'A'`
      };
    case 'TABL':
      return {
        fields: `SELECT tabname, fieldname FROM dd03l WHERE rollname = '${n}' AND as4local = 'A'`,
        tableTypes: `SELECT typename FROM dd40l WHERE rowtype = '${n}' AND as4local = 'A'`,
        appends: `SELECT tabname FROM dd02l WHERE sqltab = '${n}' AND tabclass = 'APPEND' AND as4local = 'A'`,
        views: `SELECT viewname FROM dd26s WHERE tabname = '${n}' AND as4local = 'A'`,
        checkTableOf: `SELECT tabname, fieldname FROM dd08l WHERE checktable = '${n}' AND as4local = 'A'`
      };
  }
}

/** Rows in this client only - the snippet counts every client before it deletes. */
export const rowsSql = (name: string): string => `SELECT COUNT(*) AS cnt FROM ${ddicName('TABL', name)}`;

export interface RequestEntry {
  trkorr: string;
  objfunc: string;
  status: string;
  /** The request a task belongs to; blank for a request. */
  parent: string;
}

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

export const requestEntries = (rows: Record<string, any>[]): RequestEntry[] =>
  rows
    .map(row => ({
      trkorr: clean(row.TRKORR),
      objfunc: clean(row.OBJFUNC),
      status: clean(row.TRSTATUS),
      parent: clean(row.STRKORR)
    }))
    .sort((a, b) => a.trkorr.localeCompare(b.trkorr));

/** E070-TRSTATUS of a request or task that can still be changed. */
export const MODIFIABLE = ['D', 'L'];

/**
 * Whether the object can be withdrawn instead of deleted, and if not why.
 *
 * It can when it lives only in this system: created here (TADIR-SRCSYSTEM is
 * this system, read off the number of a request) and recorded only in
 * requests that are still open. One released entry means another system may
 * have it, and then only a deletion that travels removes it there.
 */
export function withdrawal(
  entries: RequestEntry[],
  sourceSystem: string,
  packageName: string
): { possible: boolean; reason?: string; requests: string[] } {
  const requests = [...new Set(entries.map(entry => entry.parent || entry.trkorr))].sort();
  if (isLocalPackage(packageName)) {
    return { possible: false, reason: `It is in ${packageName}, a local package: there is nothing to withdraw.`, requests };
  }
  if (!entries.length) {
    return { possible: false, reason: 'It is recorded in no request: there is nothing to withdraw, and its deletion has to be recorded.', requests };
  }
  const released = entries.filter(entry => !MODIFIABLE.includes(entry.status));
  if (released.length) {
    return {
      possible: false,
      reason: `It went out with ${released.map(entry => entry.trkorr).join(', ')} (released), so the next system has it; only a recorded deletion removes it there.`,
      requests
    };
  }
  const own = entries[0].trkorr.slice(0, 3);
  if (sourceSystem && clean(sourceSystem) !== own) {
    return { possible: false, reason: `It was created in ${clean(sourceSystem)}, not here; its deletion has to travel.`, requests };
  }
  return { possible: true, requests };
}

export interface DdicState {
  kind: DdicKind;
  name: string;
  /** DD header rows, one per version (A active, N new). */
  versions: Record<string, any>[];
  directory?: Record<string, any>;
  entries: RequestEntry[];
  usages: Record<string, number>;
  rows?: number;
}

/** The token the deletion has to bring back from its preview. */
export function ddicDeletionToken(state: DdicState, withdraw: boolean): string {
  const normal = {
    kind: state.kind,
    name: state.name,
    versions: state.versions.map(row => Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
    directory: state.directory ? Object.entries(state.directory).sort(([a], [b]) => a.localeCompare(b)) : null,
    entries: state.entries,
    usages: Object.entries(state.usages).sort(([a], [b]) => a.localeCompare(b)),
    rows: state.rows ?? null,
    withdraw
  };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The deletion.
// ---------------------------------------------------------------------------

/** RS_DD_DELETE_OBJ, in the order of its signature. */
export const DELETE_OBJ_EXCEPTIONS = ['NOT_EXECUTED', 'OBJECT_NOT_FOUND', 'OBJECT_NOT_SPECIFIED', 'PERMISSION_FAILURE', 'DIALOG_NEEDED'];

export interface DdicDeleteSpec {
  kind: DdicKind;
  name: string;
  packageName: string;
  /** The request, for a transportable object. RS_CORR_INSERT refuses a task. */
  request?: string;
  /** A transparent table: count its rows in every client and stop on any. */
  countRows: boolean;
  /** Take the object's entries off its open requests and remove TADIR, instead of recording a deletion. */
  withdraw: boolean;
}

export interface DdicDeleteSnippet {
  code: string[];
  exceptions: Record<string, string[]>;
}

/**
 * The ABAP that deletes the object.
 *
 * Count the rows of a transparent table in every client and stop on any;
 * RS_DD_DELETE_OBJ with no_ask; prove from the header table that it is gone;
 * then, to withdraw, take every request entry of the object off and remove
 * its directory entry, and commit. The module commits on its own (dropping a
 * table is DDL), so nothing before it can be rolled back - which is why the
 * row count comes first and the withdrawal comes after the proof.
 */
export function deleteDdicSnippet(spec: DdicDeleteSpec): DdicDeleteSnippet {
  const kind = ddicKind(spec.kind);
  const info = KINDS[kind];
  const name = ddicName(kind, spec.name);
  const local = isLocalPackage(spec.packageName);
  if (!local && !spec.request) {
    throw new DdifError(`${name} is in package ${spec.packageName}; deleting it needs a transport request.`);
  }
  if (spec.withdraw && local) throw new DdifError(`${name} is in a local package: there is nothing to withdraw.`);
  const request = local ? undefined : transportNumber(spec.request!);
  const literal = charLiteral(name);

  const remove: StepSpec = {
    step: 'delete',
    call: [
      "CALL FUNCTION 'RS_DD_DELETE_OBJ'",
      `  EXPORTING no_ask = 'X' objname = ${literal} objtype = '${info.euType}'`,
      '  CHANGING corrnum = lv_korrnum'
    ],
    exceptions: DELETE_OBJ_EXCEPTIONS
  };
  const read: StepSpec = {
    step: 'read',
    call: [
      "  CALL FUNCTION 'TR_READ_REQUEST'",
      "    EXPORTING iv_read_e070 = 'X' iv_read_objs_keys = 'X' iv_trkorr = lv_tr",
      '    CHANGING cs_request = ls_request'
    ],
    exceptions: READ_EXCEPTIONS,
    continueOnFailure: true
  };
  const takeOff: StepSpec = {
    step: 'take_off',
    call: [
      "  CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'",
      "    EXPORTING is_e071_delete = ls_obj iv_dialog_flag = ' '",
      '    CHANGING cs_request = ls_request'
    ],
    exceptions: DELETE_EXCEPTIONS,
    continueOnFailure: true
  };
  const directory: StepSpec = {
    step: 'directory',
    call: [
      "CALL FUNCTION 'TR_TADIR_INTERFACE'",
      "  EXPORTING wi_delete_tadir_entry = 'X' wi_test_modus = ' ' wi_tadir_pgmid = 'R3TR'",
      `            wi_tadir_object = '${kind}' wi_tadir_obj_name = ${literal}`
    ]
  };
  const indent = (lines: string[]) => lines.map(line => `  ${line}`);

  const code = [
    ...DDIF_DECLARATIONS,
    'DATA lv_count TYPE i.',
    ...(spec.countRows
      ? ['DATA lv_rows TYPE i.', 'DATA lo_probe TYPE REF TO cl_sql_result_set.', 'DATA lx_sql TYPE REF TO cx_sql_exception.']
      : []),
    ...(spec.withdraw
      ? [
        'DATA lt_tr TYPE STANDARD TABLE OF trkorr WITH DEFAULT KEY.',
        'DATA lv_tr TYPE trkorr.',
        'DATA ls_request TYPE trwbo_request.',
        'DATA ls_obj TYPE e071.'
      ]
      : []),
    ...(request ? [`lv_korrnum = ${charLiteral(request)}.`] : []),
    ...(spec.countRows
      ? [
        ...rowCountLines(name),
        'IF lv_rows <> 0.',
        `  ${ownStepLine('rows', false, `${name} holds { lv_rows } rows across all clients (-1: could not count); nothing was deleted`)}`,
        '  RETURN.',
        'ENDIF.'
      ]
      : []),
    ...stepLines(remove),
    infoLine('task', 'lv_korrnum'),
    `SELECT COUNT(*) FROM ${info.header} INTO lv_count WHERE ${info.key} = ${literal}.`,
    'IF lv_count <> 0.',
    `  ${ownStepLine('verify', false, `${info.header.toUpperCase()} still holds { lv_count } versions: RS_DD_DELETE_OBJ returned without deleting`)}`,
    '  RETURN.',
    'ENDIF.',
    ownStepLine('verify', true),
    // Whatever the module left for the update task runs here, not in the
    // implicit commit at the end of the run that nobody checks.
    'COMMIT WORK AND WAIT.',
    'lv_subrc = sy-subrc.',
    `out->write( |STEP${DDIF_SEPARATOR}commit${DDIF_SEPARATOR}{ lv_subrc }${DDIF_SEPARATOR}0` +
      `${DDIF_SEPARATOR}${DDIF_SEPARATOR}${DDIF_SEPARATOR}| ).`,
    // A transparent table has to be gone from the database too, not only from
    // DD02L. DB_EXISTS_TABLE, not a SELECT: on Oracle execute_query parses
    // lazily and a missing table raises ORA-00942 only at the first fetch, so
    // a probe without next( ) reports a dropped table as still there.
    ...(spec.countRows
      ? [
        `CALL FUNCTION 'DB_EXISTS_TABLE' EXPORTING tabname = ${literal} IMPORTING subrc = lv_subrc.`,
        'IF lv_subrc = 0.',
        `  ${ownStepLine('database', false, `${name} is still in the database without a definition; drop it in SE14`)}`,
        'ELSE.',
        `  ${ownStepLine('database', true)}`,
        'ENDIF.'
      ]
      : []),
    ...(spec.withdraw
      ? [
        `SELECT trkorr FROM e071 INTO TABLE lt_tr WHERE pgmid = 'R3TR' AND object = '${kind}' AND obj_name = ${literal}.`,
        'SORT lt_tr.',
        'DELETE ADJACENT DUPLICATES FROM lt_tr.',
        'LOOP AT lt_tr INTO lv_tr.',
        '  CLEAR ls_request.',
        ...indent(stepLines(read)),
        '  IF lv_subrc <> 0.',
        '    RETURN.',
        '  ENDIF.',
        '  CLEAR ls_obj.',
        `  READ TABLE ls_request-objects INTO ls_obj WITH KEY pgmid = 'R3TR' object = '${kind}' obj_name = ${literal}.`,
        '  IF sy-subrc = 0.',
        ...indent(indent(stepLines(takeOff))),
        '    IF lv_subrc <> 0.',
        '      RETURN.',
        '    ENDIF.',
        '  ENDIF.',
        'ENDLOOP.',
        `SELECT COUNT(*) FROM tadir INTO lv_count WHERE pgmid = 'R3TR' AND object = '${kind}'`,
        `  AND obj_name = ${literal}.`,
        'IF lv_count > 0.',
        ...indent(stepLines(directory)),
        'ENDIF.',
        'COMMIT WORK AND WAIT.',
        ownStepLine('withdrawn', true)
      ]
      : [])
  ];
  return {
    code,
    exceptions: {
      delete: DELETE_OBJ_EXCEPTIONS,
      ...(spec.withdraw ? { read: READ_EXCEPTIONS, take_off: DELETE_EXCEPTIONS, directory: [] } : {})
    }
  };
}
