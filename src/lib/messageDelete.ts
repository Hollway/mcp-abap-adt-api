/**
 * Deleting messages of a message class, the way SE91 does it.
 *
 * ADT cannot: the message class document is upserted by number, so a message
 * left out of it stays (see lib/messageClass), and no RPY_MESSAGE* module
 * deletes one. RS_DELETE_MESSAGE does, but it asks for confirmation in a
 * popup and for the request in a dialog, and nothing here has a GUI. What it
 * does after that is plain table work, and this module generates it, so it can
 * be tested without a system:
 *
 *  - T100 (the text, one row per language), T100U (who changed it last and
 *    whether it is self-explanatory) and T100X (the authority-check flag);
 *  - the long text: DOKHL, DOKTL and DOKIL under ID NA and the object name
 *    class and number run together ("ZFOO" + "007" = "ZFOO007"), every
 *    language. Not through DOCU_DEL: it calls DOCU_DELETE_EXTENSION over
 *    DESTINATION 'NONE', and a synchronous RFC commits the caller's work - a
 *    rollback after it would leave the texts deleted and the rest not;
 *  - in a transportable class, the deletion recorded in the caller's task as
 *    LIMU MESS <class><number> with OBJFUNC D - the entry SE91 writes for a
 *    deleted message (3,428 such entries on the ERP system, written by SE91
 *    itself). When the request already carries R3TR MSAG of the class, the
 *    module takes the LIMU entries with subrc 0 and writes none: the class
 *    travels whole (both measured 2026-10-13; what an import of R3TR MSAG does
 *    with numbers missing in the source was not).
 *
 * All of it under the SE91 lock (ENQUEUE_ES_MSGSI on the class), in one
 * database transaction: a failed step rolls back what came before it, so a
 * message is either gone with its long text and its transport entry, or all
 * of it is still there.
 */
import { createHash } from 'crypto';
import { charLiteral } from './textPool';
import { normaliseNumber } from './messageClass';
import {
  DDIF_DECLARATIONS,
  DDIF_SEPARATOR,
  DdifError,
  infoLine,
  ownStepLine,
  stepLines
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';
import { APPEND_EXCEPTIONS, E071_TABLE_DECLARATIONS, transportNumber } from './transportRegistration';

/** Numbers one call takes - a whole class is SE91 work, not a list of numbers. */
export const MAX_NUMBERS = 100;

/** Numbers whose where-used the preview asks for, one backend call each. */
export const MAX_USAGE_LOOKUPS = 20;

/**
 * A message class name: up to 20 characters, as T100A-ARBGB holds it.
 *
 * Not a dictionary name: a message class may start with a digit - class 00,
 * which every system has, and 38, V1 and hundreds more - so the check is the
 * alphabet and the length, and a namespace.
 */
export function messageClassName(value: unknown): string {
  const name = String(value ?? '').trim().toUpperCase();
  if (!name) throw new DdifError('Which message class? Pass className.');
  if (name.length > 20) throw new DdifError(`The message class name ${name} is ${name.length} characters; T100A holds 20.`);
  if (!/^[A-Z0-9_]+$/.test(name) && !/^\/[A-Z0-9_]{1,10}\/[A-Z0-9_]+$/.test(name)) {
    throw new DdifError(`'${value}' is not a message class name: letters, digits and underscores (or /NAMESPACE/NAME).`);
  }
  return name;
}

/** The numbers to delete: three digits each, no duplicates, in order. */
export function messageNumbers(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  if (!list.length) throw new DdifError('Which messages? Pass numbers, e.g. ["007"].');
  const numbers = new Set<string>();
  for (const item of list) {
    try {
      numbers.add(normaliseNumber(item as string));
    } catch (error: any) {
      throw new DdifError(error?.message || `'${item}' is not a message number.`);
    }
  }
  if (numbers.size > MAX_NUMBERS) {
    throw new DdifError(`${numbers.size} messages in one call; at most ${MAX_NUMBERS}. Split the list.`);
  }
  return [...numbers].sort();
}

/** The long-text object of a message: class and number run together. */
export const longTextObject = (className: string, number: string): string => `${className}${number}`;

/** What travels for a deleted message: the class and number run together. */
export const transportName = longTextObject;

// ---------------------------------------------------------------------------
// Reading the current state.
// ---------------------------------------------------------------------------

/**
 * One SELECT per slice of the list.
 *
 * The query endpoint refuses a statement past 255 characters, so an IN list
 * is cut where the next value would not fit.
 */
export function inListQueries(head: string, values: string[], tail = ''): string[] {
  const queries: string[] = [];
  let slice: string[] = [];
  const statement = (items: string[]) => `${head} IN (${items.map(item => `'${item}'`).join(',')})${tail}`;
  for (const value of values) {
    if (slice.length && statement([...slice, value]).length > 255) {
      queries.push(statement(slice));
      slice = [];
    }
    slice.push(value);
  }
  if (slice.length) queries.push(statement(slice));
  for (const query of queries) {
    if (query.length > 255) throw new DdifError(`A value is too long to query: ${query.slice(0, 80)}...`);
  }
  return queries;
}

export const classExistsSql = (className: string): string =>
  `SELECT arbgb FROM t100a WHERE arbgb = '${messageClassName(className)}'`;

export const classPackageSql = (className: string): string =>
  `SELECT devclass FROM tadir WHERE pgmid = 'R3TR' AND object = 'MSAG' AND obj_name = '${messageClassName(className)}'`;

export const textsSql = (className: string, numbers: string[]): string[] =>
  inListQueries(`SELECT msgnr, sprsl, text FROM t100 WHERE arbgb = '${messageClassName(className)}' AND msgnr`, numbers);

export const authorsSql = (className: string, numbers: string[]): string[] =>
  inListQueries(`SELECT msgnr, name, datum, selfdef FROM t100u WHERE arbgb = '${messageClassName(className)}' AND msgnr`, numbers);

export const supplementsSql = (className: string, numbers: string[]): string[] =>
  inListQueries(`SELECT msgnr FROM t100x WHERE arbgb = '${messageClassName(className)}' AND msgnr`, numbers);

export const longTextsSql = (className: string, numbers: string[]): string[] =>
  inListQueries(
    "SELECT object, langu, typ, dokversion, dokstate FROM dokhl WHERE id = 'NA' AND object",
    numbers.map(number => longTextObject(messageClassName(className), number))
  );

/** The entries of the deletion in the task, read back as proof. */
export const recordedSql = (task: string, className: string, numbers: string[]): string[] =>
  inListQueries(
    `SELECT obj_name, objfunc FROM e071 WHERE trkorr = '${transportNumber(task)}' AND pgmid = 'LIMU' AND object = 'MESS' AND obj_name`,
    numbers.map(number => transportName(messageClassName(className), number))
  );

/**
 * One DOKHL row of a message: a language and version of its documentation.
 *
 * Not every row is a long text somebody wrote. Measured on the ERP system: a
 * message created as self-explanatory gets T100U-SELFDEF '3' and a DOKHL row
 * of its own, in language D with DOKSTATE N, holding no text; a long text
 * actually written has DOKSTATE R. Both go with the message, as in SE91, and
 * the preview shows the state so the stub does not read as a German text.
 */
export interface DocumentRow {
  language: string;
  version: number;
  state: string;
}

/**
 * Where the whole class is recorded, R3TR MSAG.
 *
 * When the class itself is in the request - creating it puts it there - the
 * module accepts LIMU MESS entries with subrc 0 and writes none: the whole
 * object covers its parts (measured on the ERP system). The deletion then
 * travels with the class, which goes out whole.
 */
export const wholeClassSql = (className: string): string =>
  `SELECT trkorr FROM e071 WHERE pgmid = 'R3TR' AND object = 'MSAG' AND obj_name = '${messageClassName(className)}'`;

export interface MessageState {
  /** Per number: the text in every language it has. */
  texts: Record<string, Record<string, string>>;
  /** Per number: last changed by and on, and whether it is self-explanatory. */
  authors: Record<string, { changedBy: string; changedOn: string; selfExplanatory: boolean }>;
  /** Numbers with a T100X row. */
  supplements: string[];
  /** Per number: its DOKHL rows, every language and version. */
  longTexts: Record<string, DocumentRow[]>;
}

/** T100U-SELFDEF: '3' is "the short text explains the object"; blank, 1 and 2 are not. */
export const SELF_EXPLANATORY = '3';

const text = (value: unknown): string => String(value ?? '').trim();
const dateText = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : text(value);

/** The rows of the four reads, put together per message number. */
export function messageState(
  className: string,
  rows: {
    texts: Record<string, any>[];
    authors: Record<string, any>[];
    supplements: Record<string, any>[];
    longTexts: Record<string, any>[];
  }
): MessageState {
  const name = messageClassName(className);
  const state: MessageState = { texts: {}, authors: {}, supplements: [], longTexts: {} };
  for (const row of rows.texts) {
    const number = text(row.MSGNR);
    (state.texts[number] ||= {})[text(row.SPRSL)] = String(row.TEXT ?? '').replace(/\s+$/, '');
  }
  for (const row of rows.authors) {
    state.authors[text(row.MSGNR)] = {
      changedBy: text(row.NAME),
      changedOn: dateText(row.DATUM),
      selfExplanatory: text(row.SELFDEF) === SELF_EXPLANATORY
    };
  }
  state.supplements = [...new Set(rows.supplements.map(row => text(row.MSGNR)))].sort();
  for (const row of rows.longTexts) {
    const object = text(row.OBJECT);
    if (!object.startsWith(name)) continue;
    (state.longTexts[object.slice(name.length)] ||= []).push({
      language: text(row.LANGU),
      version: Number(row.DOKVERSION ?? 0),
      state: text(row.DOKSTATE)
    });
  }
  for (const documents of Object.values(state.longTexts)) {
    documents.sort((a, b) => a.language.localeCompare(b.language) || a.version - b.version);
  }
  return state;
}

/**
 * How many rows the deletion will remove - what the snippet checks before it
 * starts. Rows, not languages: DOKHL keeps a row per version, and the snippet
 * counts rows.
 */
export function expectedCounts(state: MessageState): { texts: number; longTexts: number } {
  return {
    texts: Object.values(state.texts).reduce((sum, languages) => sum + Object.keys(languages).length, 0),
    longTexts: Object.values(state.longTexts).reduce((sum, documents) => sum + documents.length, 0)
  };
}

/**
 * The token a deletion has to bring back from its preview.
 *
 * It covers the numbers, every text in every language, who changed each one
 * last and when, and which have long texts - so a deletion goes through only
 * for the messages the preview showed, as the preview showed them.
 */
export function deletionToken(className: string, numbers: string[], state: MessageState): string {
  const normal = {
    className: messageClassName(className),
    numbers: [...numbers].sort(),
    texts: Object.keys(state.texts).sort().map(number =>
      [number, Object.entries(state.texts[number]).sort(([a], [b]) => a.localeCompare(b))]),
    authors: Object.keys(state.authors).sort().map(number => [number, state.authors[number]]),
    supplements: state.supplements,
    longTexts: Object.keys(state.longTexts).sort().map(number => [number, state.longTexts[number]])
  };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The deletion.
// ---------------------------------------------------------------------------

export const ENQUEUE_EXCEPTIONS = ['FOREIGN_LOCK', 'SYSTEM_FAILURE'];

export interface DeleteSpec {
  className: string;
  numbers: string[];
  /** The caller's own task, for a transportable class; none for a local one. */
  task?: string;
  /** Rows the preview counted; the snippet stops when the tables hold others. */
  expected: { texts: number; longTexts: number };
}

export interface DeleteSnippet {
  code: string[];
  exceptions: Record<string, string[]>;
}

/**
 * The ABAP that deletes the messages.
 *
 * Lock the class as SE91 does; stop if the rows are not the ones the preview
 * counted; record the deletion in the task; delete the texts, the change
 * records, the supplements and the long texts; check nothing is left; commit.
 * Any stop after the lock rolls back and releases it.
 */
export function deleteMessagesSnippet(spec: DeleteSpec): DeleteSnippet {
  const name = messageClassName(spec.className);
  const numbers = messageNumbers(spec.numbers);
  const task = spec.task ? transportNumber(spec.task) : undefined;
  const literal = charLiteral(name);
  const dequeue = `CALL FUNCTION 'DEQUEUE_ES_MSGSI' EXPORTING arbgb = ${literal}.`;
  const abort = (step: string, message: string): string[] => [
    '  ROLLBACK WORK.',
    `  ${ownStepLine(step, false, message)}`,
    `  ${dequeue}`,
    '  RETURN.'
  ];

  const enqueue: StepSpec = {
    step: 'enqueue',
    call: ["CALL FUNCTION 'ENQUEUE_ES_MSGSI'", `  EXPORTING arbgb = ${literal}`],
    exceptions: ENQUEUE_EXCEPTIONS
  };
  const transport: StepSpec | undefined = task
    ? {
      step: 'transport',
      call: [
        "CALL FUNCTION 'TR_APPEND_TO_COMM_OBJS_KEYS'",
        `  EXPORTING wi_trkorr = ${charLiteral(task)}`,
        '  TABLES wt_e071 = lt_e071 wt_e071k = lt_e071k'
      ],
      exceptions: [...APPEND_EXCEPTIONS],
      continueOnFailure: true
    }
    : undefined;

  const deleteLines = (table: string, where: string, key: string): string[] => [
    `DELETE FROM ${table} WHERE ${where}.`,
    'lv_count = sy-dbcnt.',
    infoLine(key, 'lv_count')
  ];
  const byNumber = `arbgb = ${literal} AND msgnr IN lr_nr`;
  const byDocument = "id = 'NA' AND object IN lr_doc";

  const code = [
    ...DDIF_DECLARATIONS,
    'DATA lv_count TYPE i.',
    'DATA lr_nr TYPE RANGE OF msgnr.',
    'DATA lr_doc TYPE RANGE OF dokhl-object.',
    ...E071_TABLE_DECLARATIONS,
    ...numbers.map(number => `APPEND VALUE #( sign = 'I' option = 'EQ' low = '${number}' ) TO lr_nr.`),
    ...numbers.map(number =>
      `APPEND VALUE #( sign = 'I' option = 'EQ' low = ${charLiteral(longTextObject(name, number))} ) TO lr_doc.`),
    ...(task
      ? numbers.map(number =>
        `APPEND VALUE #( pgmid = 'LIMU' object = 'MESS' obj_name = ${charLiteral(transportName(name, number))} objfunc = 'D' ) TO lt_e071.`)
      : []),
    ...stepLines(enqueue),
    // The rows have to be the ones the preview counted, now that the lock is held.
    `SELECT COUNT(*) FROM t100 INTO lv_count WHERE ${byNumber}.`,
    `IF lv_count <> ${spec.expected.texts}.`,
    ...abort('compare', `T100 holds { lv_count } texts of these messages; the preview counted ${spec.expected.texts}`),
    'ENDIF.',
    `SELECT COUNT(*) FROM dokhl INTO lv_count WHERE ${byDocument}.`,
    `IF lv_count <> ${spec.expected.longTexts}.`,
    ...abort('compare', `DOKHL holds { lv_count } long texts of these messages; the preview counted ${spec.expected.longTexts}`),
    'ENDIF.',
    ownStepLine('compare', true),
    ...(transport
      ? [
        ...stepLines(transport),
        'IF lv_subrc <> 0.',
        '  ROLLBACK WORK.',
        `  ${dequeue}`,
        '  RETURN.',
        'ENDIF.'
      ]
      : []),
    ...deleteLines('t100', byNumber, 'texts'),
    ...deleteLines('t100u', byNumber, 'authors'),
    ...deleteLines('t100x', byNumber, 'supplements'),
    ...deleteLines('dokhl', byDocument, 'docHeaders'),
    ...deleteLines('doktl', byDocument, 'docLines'),
    ...deleteLines('dokil', byDocument, 'docIndex'),
    `SELECT COUNT(*) FROM t100 INTO lv_count WHERE ${byNumber}.`,
    'IF lv_count <> 0.',
    ...abort('verify', '{ lv_count } texts are still in T100 after the delete'),
    'ENDIF.',
    `SELECT COUNT(*) FROM dokhl INTO lv_count WHERE ${byDocument}.`,
    'IF lv_count <> 0.',
    ...abort('verify', '{ lv_count } long texts are still in DOKHL after the delete'),
    'ENDIF.',
    ownStepLine('verify', true),
    'COMMIT WORK AND WAIT.',
    'lv_subrc = sy-subrc.',
    `out->write( |STEP${DDIF_SEPARATOR}commit${DDIF_SEPARATOR}{ lv_subrc }${DDIF_SEPARATOR}0` +
      `${DDIF_SEPARATOR}${DDIF_SEPARATOR}${DDIF_SEPARATOR}| ).`,
    dequeue
  ];
  return {
    code,
    exceptions: { enqueue: ENQUEUE_EXCEPTIONS, ...(transport ? { transport: [...APPEND_EXCEPTIONS] } : {}) }
  };
}
