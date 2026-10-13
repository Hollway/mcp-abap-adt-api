/**
 * Moving objects from a request's header into a task.
 *
 * An object recorded on the request itself rather than in a task belongs to
 * nobody in SE09: it is not in anyone's task list, a task release does not
 * cover it, and it is easy to miss until the request goes out. It gets there
 * when RS_CORR_INSERT is given a request with use_korrnum_immediatedly (the
 * way the DDIF writers here used to call it), or when a task is released -
 * its objects are merged into the request, which is normal and nothing to fix.
 *
 * The move is three calls, measured on the ERP system on 2026-10-13 with three
 * domains and a table:
 *
 *  - TR_READ_REQUEST reads the request with its objects and keys;
 *  - TR_DELETE_COMM_OBJECT_KEYS takes the entry off the request, and its
 *    TLOCK with it;
 *  - TR_APPEND_TO_COMM_OBJS_KEYS puts it into the task with its E071K keys,
 *    and sets the TLOCK on the task.
 *
 * All in one database transaction: if the append fails, the delete is rolled
 * back, so an object is never left in neither.
 */
import { createHash } from 'crypto';
import { charLiteral } from './textPool';
import { DDIF_DECLARATIONS, DdifError, ownStepLine, stepLines } from './ddifWrite';
import type { StepSpec } from './ddifWrite';
import { APPEND_EXCEPTIONS, E071_TABLE_DECLARATIONS, buildE071Row, transportNumber } from './transportRegistration';
import type { E071Row } from './transportRegistration';

/** Objects one call moves. */
export const MAX_OBJECTS = 50;

export interface HeaderEntry extends E071Row {
  /** E071-OBJFUNC: blank, D for a deletion, K for an entry with keys. */
  OBJFUNC: string;
  /** E071K rows that hang off this entry. */
  keys: number;
}

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

export const headerEntriesSql = (request: string): string =>
  `SELECT pgmid, object, obj_name, objfunc FROM e071 WHERE trkorr = '${transportNumber(request)}'`;

export const headerKeysSql = (request: string): string =>
  `SELECT mastertype, mastername, COUNT(*) AS cnt FROM e071k WHERE trkorr = '${transportNumber(request)}' ` +
  'GROUP BY mastertype, mastername';

export const locksSql = (request: string, task: string): string =>
  `SELECT object, hikey, trkorr FROM tlock WHERE trkorr IN ('${transportNumber(request)}','${transportNumber(task)}')`;

export const entriesOfSql = (request: string, task: string): string =>
  `SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN ('${transportNumber(request)}','${transportNumber(task)}')`;

/** The header's entries with their key counts, as two reads give them. */
export function headerEntries(rows: Record<string, any>[], keyRows: Record<string, any>[]): HeaderEntry[] {
  const keys = new Map<string, number>();
  for (const row of keyRows) {
    keys.set(`${clean(row.MASTERTYPE)} ${clean(row.MASTERNAME)}`, Number(row.CNT ?? 0));
  }
  return rows.map(row => ({
    PGMID: clean(row.PGMID),
    OBJECT: clean(row.OBJECT),
    OBJ_NAME: clean(row.OBJ_NAME),
    OBJFUNC: clean(row.OBJFUNC),
    keys: keys.get(`${clean(row.OBJECT)} ${clean(row.OBJ_NAME)}`) || 0
  }));
}

const entryLabel = (row: E071Row): string => `${row.PGMID} ${row.OBJECT} ${row.OBJ_NAME}`;

/**
 * The entries to move: the ones asked for, each of which has to be on the
 * header, or every entry the header has.
 */
export function selectEntries(header: HeaderEntry[], wanted: unknown): HeaderEntry[] {
  if (!header.length) throw new DdifError('Nothing is recorded on the request itself: every object is in a task already.');
  if (wanted === undefined || wanted === null || (Array.isArray(wanted) && !wanted.length)) {
    if (header.length > MAX_OBJECTS) {
      throw new DdifError(`The request header holds ${header.length} entries; at most ${MAX_OBJECTS} move in one call. Pass objects.`);
    }
    return header;
  }
  if (!Array.isArray(wanted)) throw new DdifError('objects is a list: [{pgmid, object, objName}].');
  if (wanted.length > MAX_OBJECTS) throw new DdifError(`${wanted.length} objects in one call; at most ${MAX_OBJECTS}.`);
  const chosen: HeaderEntry[] = [];
  const absent: string[] = [];
  for (const item of wanted) {
    let row: E071Row;
    try {
      row = buildE071Row({ pgmid: item?.pgmid, object: item?.object, objName: item?.objName ?? item?.name });
    } catch (error: any) {
      throw new DdifError(error?.message || 'An object could not be read.');
    }
    const found = header.find(entry => entry.PGMID === row.PGMID && entry.OBJECT === row.OBJECT && entry.OBJ_NAME === row.OBJ_NAME);
    if (!found) absent.push(entryLabel(row));
    else if (!chosen.includes(found)) chosen.push(found);
  }
  if (absent.length) {
    throw new DdifError(`Not on the request header: ${absent.join(', ')}. Only an entry recorded on the request itself can be moved.`);
  }
  return chosen;
}

/**
 * The token a move has to bring back from its preview: the request, the task,
 * and the entries with their keys - so the move goes through only for the
 * entries the preview showed, as the preview showed them.
 */
export function moveToken(request: string, task: string, entries: HeaderEntry[]): string {
  const normal = {
    request: transportNumber(request),
    task: transportNumber(task),
    entries: entries
      .map(entry => [entry.PGMID, entry.OBJECT, entry.OBJ_NAME, entry.OBJFUNC, entry.keys])
      .sort((a, b) => String(a).localeCompare(String(b)))
  };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 16);
}

export const READ_EXCEPTIONS = ['ERROR_OCCURED', 'NO_AUTHORIZATION'];

/** TR_DELETE_COMM_OBJECT_KEYS, in the order of its signature. */
export const DELETE_EXCEPTIONS = [
  'E_DATABASE_ACCESS_ERROR', 'E_EMPTY_LOCKKEY', 'E_BAD_TARGET_REQUEST', 'E_WRONG_SOURCE_CLIENT',
  'N_NO_DELETION_OF_C_OBJECTS', 'N_NO_DELETION_OF_CORR_ENTRY', 'N_OBJECT_ENTRY_DOESNT_EXIST',
  'N_REQUEST_ALREADY_RELEASED', 'N_REQUEST_FROM_OTHER_SYSTEM', 'R_ACTION_ABORTED_BY_USER',
  'R_FOREIGN_LOCK', 'W_BIGGER_LOCK_IN_SAME_ORDER', 'W_DUPLICATE_ENTRY', 'W_NO_AUTHORIZATION',
  'W_USER_NOT_OWNER'
];

export interface MoveSpec {
  request: string;
  task: string;
  entries: E071Row[];
}

export interface MoveSnippet {
  code: string[];
  exceptions: Record<string, string[]>;
}

/**
 * The ABAP that moves the entries.
 *
 * Read the request; for each entry, find it on the header (stop if it is not
 * there any more), collect its keys, and take it off; then append all of them
 * to the task with their keys, and commit. A stop after the first delete
 * rolls back, so nothing is taken off without being put back.
 */
export function moveToTaskSnippet(spec: MoveSpec): MoveSnippet {
  const request = transportNumber(spec.request);
  const task = transportNumber(spec.task);
  if (request === task) throw new DdifError('The task and the request are the same number.');
  if (!spec.entries.length) throw new DdifError('Nothing to move.');
  const entries = spec.entries.map(entry =>
    buildE071Row({ pgmid: entry.PGMID, object: entry.OBJECT, objName: entry.OBJ_NAME }));

  const read: StepSpec = {
    step: 'read',
    call: [
      "CALL FUNCTION 'TR_READ_REQUEST'",
      "  EXPORTING iv_read_e070 = 'X' iv_read_objs_keys = 'X'",
      `            iv_trkorr = ${charLiteral(request)}`,
      '  CHANGING cs_request = ls_request'
    ],
    exceptions: READ_EXCEPTIONS
  };
  const takeOff: StepSpec = {
    step: 'take_off',
    call: [
      "CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'",
      "  EXPORTING is_e071_delete = ls_obj iv_dialog_flag = ' '",
      '  CHANGING cs_request = ls_request'
    ],
    exceptions: DELETE_EXCEPTIONS,
    continueOnFailure: true
  };
  const append: StepSpec = {
    step: 'append',
    call: [
      "CALL FUNCTION 'TR_APPEND_TO_COMM_OBJS_KEYS'",
      `  EXPORTING wi_trkorr = ${charLiteral(task)}`,
      '  TABLES wt_e071 = lt_e071 wt_e071k = lt_e071k'
    ],
    exceptions: [...APPEND_EXCEPTIONS],
    continueOnFailure: true
  };
  const stopIfFailed = ['IF lv_subrc <> 0.', '  ROLLBACK WORK.', '  RETURN.', 'ENDIF.'];

  const perEntry = entries.flatMap(entry => [
    'CLEAR ls_obj.',
    `READ TABLE ls_request-objects INTO ls_obj WITH KEY pgmid = ${charLiteral(entry.PGMID)} ` +
      `object = ${charLiteral(entry.OBJECT)} obj_name = ${charLiteral(entry.OBJ_NAME)}.`,
    'IF sy-subrc <> 0.',
    '  ROLLBACK WORK.',
    `  ${ownStepLine('find', false, `${entry.PGMID} ${entry.OBJECT} ${entry.OBJ_NAME} is not on the request header any more`)}`,
    '  RETURN.',
    'ENDIF.',
    'LOOP AT ls_request-keys INTO ls_key WHERE mastertype = ls_obj-object AND mastername = ls_obj-obj_name.',
    `  ls_key-trkorr = ${charLiteral(task)}.`,
    '  APPEND ls_key TO lt_e071k.',
    'ENDLOOP.',
    'ls_new = ls_obj.',
    `ls_new-trkorr = ${charLiteral(task)}.`,
    'CLEAR ls_new-as4pos.',
    'APPEND ls_new TO lt_e071.',
    ...stepLines(takeOff),
    ...stopIfFailed
  ]);

  const code = [
    ...DDIF_DECLARATIONS,
    'DATA ls_request TYPE trwbo_request.',
    'DATA ls_obj TYPE e071.',
    'DATA ls_new TYPE e071.',
    'DATA ls_key TYPE e071k.',
    ...E071_TABLE_DECLARATIONS,
    ...stepLines(read),
    ...perEntry,
    ...stepLines(append),
    ...stopIfFailed,
    'COMMIT WORK AND WAIT.',
    ownStepLine('commit', true)
  ];
  return {
    code,
    exceptions: { read: READ_EXCEPTIONS, take_off: DELETE_EXCEPTIONS, append: [...APPEND_EXCEPTIONS] }
  };
}
