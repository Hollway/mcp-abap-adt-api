/**
 * Transactions (SE93): creating a report or a dialog transaction and deleting
 * one, through the modules SE93 itself is built on, run in a throwaway class.
 * ADT has no transaction editor on the ERP system these tools were written
 * against.
 *
 * Read in RPY_TRANSACTION_INSERT and RPY_TRANSACTION_DELETE, and held here:
 *
 *  - the insert checks nothing about what it points at: a missing program,
 *    screen or variant goes into TSTC as given and the transaction fails only
 *    when somebody starts it. So the program (PROGDIR, active), its type, the
 *    screen (D020S) and the variant (VARID) are checked before the call;
 *  - neither module commits, so the snippet does - after it has proven the
 *    TSTC row is there (or gone);
 *  - the insert records the transaction with RS_CORR_INSERT given the request,
 *    which puts it into the caller's task (measured on a report transaction, 2026-10-14:
 *    TADIR and E071 in the task, not on the request header);
 *  - the delete records with RS_CORR_INSERT in modify mode, so the request
 *    carries R3TR TRAN and the export finds it gone - the way SE93 leaves it.
 *    In $TMP the module removes the directory entry itself (measured
 *    2026-10-14); the snippet removes one only if it is still there.
 */
import { createHash } from 'crypto';
import { charLiteral } from './textPool';
import {
  DDIF_DECLARATIONS,
  DDIF_SEPARATOR,
  DdifError,
  ddifLanguageLines,
  isLocalPackage,
  ownStepLine,
  stepLines,
  textLiteral
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';
import { transportNumber } from './transportRegistration';

export type TransactionKind = 'report' | 'dialog';

/** TSTC-TCODE holds 20 characters. */
export const TCODE_LENGTH = 20;
/** TSTCT-TTEXT holds 36. */
export const SHORT_TEXT_LENGTH = 36;

/**
 * A transaction code. Not a dictionary name: codes like SE93 start with a
 * letter and carry digits, and a customer code starts with Y or Z or a
 * namespace - a code outside them is SAP's, and creating one is refused.
 */
export function transactionCode(value: unknown, creating = false): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!code) throw new DdifError('Which transaction? Pass transaction, e.g. ZAPP_REPORT.');
  if (code.length > TCODE_LENGTH) throw new DdifError(`The transaction code ${code} is ${code.length} characters; TSTC holds ${TCODE_LENGTH}.`);
  if (!/^[A-Z0-9_]+$/.test(code) && !/^\/[A-Z0-9_]{1,10}\/[A-Z0-9_]+$/.test(code)) {
    throw new DdifError(`'${value}' is not a transaction code: letters, digits and underscores (or /NAMESPACE/CODE).`);
  }
  if (creating && !/^[YZ]/.test(code) && !code.startsWith('/')) {
    throw new DdifError(`${code} is not in the customer namespace: a new transaction starts with Y or Z, or a namespace of yours.`);
  }
  return code;
}

export function transactionKind(value: unknown): TransactionKind {
  const kind = String(value ?? 'report').trim().toLowerCase();
  if (kind === 'report' || kind === 'r') return 'report';
  if (kind === 'dialog' || kind === 'd') return 'dialog';
  throw new DdifError(`'${value}' is not a transaction type this creates: report (a program with its selection screen) or dialog (a program and a screen).`);
}

const programName = (value: unknown): string => {
  const name = String(value ?? '').trim().toUpperCase();
  if (!name) throw new DdifError('Which program does the transaction start? Pass program.');
  if (name.length > 40 || !/^[A-Z0-9_/]+$/.test(name)) throw new DdifError(`'${value}' is not a program name.`);
  return name;
};

const screenNumber = (value: unknown): string => {
  const text = String(value ?? '').trim();
  if (!/^\d{1,4}$/.test(text)) throw new DdifError(`The screen is a number of up to four digits, not '${value}'.`);
  return text.padStart(4, '0');
};

const variantName = (value: unknown): string => {
  const name = String(value ?? '').trim().toUpperCase();
  if (name.length > 14 || !/^[A-Z0-9_&%$]+$/.test(name)) throw new DdifError(`'${value}' is not a variant name.`);
  return name;
};

export interface TransactionSpec {
  code: string;
  kind: TransactionKind;
  program: string;
  /** The screen a dialog transaction starts on; a report transaction always starts on 1000. */
  screen: string;
  variant?: string;
  shortText: string;
  packageName: string;
  /** The request, for a transportable package. */
  request?: string;
  /** SAP key (R) or ISO code (RU); empty for the logon language. */
  language: string;
  /** SAP GUI for Windows, HTML. Both on by default, as SE93 proposes. */
  wingui: boolean;
  html: boolean;
}

/** The arguments of createTransaction, checked and filled in. */
export function transactionSpec(args: any): TransactionSpec {
  const language = String(args?.language ?? '').trim().toUpperCase();
  if (language.length > 2 || !/^[A-Z0-9]*$/.test(language)) {
    throw new DdifError(`'${args?.language}' is not a language: the SAP key (R) or the ISO code (RU).`);
  }
  const kind = transactionKind(args?.type ?? args?.kind);
  const variant = args?.variant ? variantName(args.variant) : undefined;
  if (variant && kind !== 'report') throw new DdifError('A variant belongs to a report transaction; a dialog transaction starts on its screen.');
  const shortText = String(args?.shortText ?? args?.description ?? '').trim();
  if (!shortText) throw new DdifError('Pass shortText - the title SE93 and the menu show.');
  textLiteral(shortText, 'short text', SHORT_TEXT_LENGTH);
  return {
    code: transactionCode(args?.transaction ?? args?.name, true),
    kind,
    program: programName(args?.program),
    screen: kind === 'report' ? '1000' : screenNumber(args?.screen ?? args?.dynpro),
    ...(variant ? { variant } : {}),
    shortText,
    packageName: String(args?.packageName ?? '').trim().toUpperCase(),
    language,
    wingui: args?.winGui !== false,
    html: args?.html !== false
  };
}

// ---------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------

export const tstcSql = (code: string): string =>
  `SELECT tcode, pgmna, dypno, cinfo FROM tstc WHERE tcode = '${transactionCode(code)}'`;

export const textsSql = (code: string): string =>
  `SELECT sprsl, ttext FROM tstct WHERE tcode = '${transactionCode(code)}'`;

export const guiSql = (code: string): string =>
  `SELECT s_webgui, s_win32, s_platin FROM tstcc WHERE tcode = '${transactionCode(code)}'`;

export const parametersSql = (code: string): string =>
  `SELECT param FROM tstcp WHERE tcode = '${transactionCode(code)}'`;

export const directorySql = (code: string): string =>
  `SELECT devclass, author, delflag FROM tadir WHERE pgmid = 'R3TR' AND object = 'TRAN' AND obj_name = '${transactionCode(code)}'`;

export const recordedSql = (code: string): string =>
  `SELECT trkorr, objfunc FROM e071 WHERE pgmid = 'R3TR' AND object = 'TRAN' AND obj_name = '${transactionCode(code)}'`;

/** Roles that hand the transaction out - deleting it leaves them pointing at nothing. */
export const rolesSql = (code: string): string =>
  `SELECT agr_name FROM agr_tcodes WHERE type = 'TR' AND tcode = '${transactionCode(code)}'`;

export const programSql = (program: string): string =>
  `SELECT name, subc, state FROM progdir WHERE name = '${programName(program)}' AND state = 'A'`;

export const screenSql = (program: string, screen: string): string =>
  `SELECT prog, dnum FROM d020s WHERE prog = '${programName(program)}' AND dnum = '${screenNumber(screen)}'`;

export const variantSql = (program: string, variant: string): string =>
  `SELECT variant FROM varid WHERE report = '${programName(program)}' AND variant = '${variantName(variant)}'`;

export const packageSql = (name: string): string =>
  `SELECT devclass FROM tdevc WHERE devclass = '${String(name).trim().toUpperCase().replace(/'/g, '')}'`;

/**
 * Program types a transaction may start: 1 executable for a report
 * transaction, and for a dialog one also M (module pool) and F (function
 * group screens).
 */
export function programFits(kind: TransactionKind, subc: string): boolean {
  return kind === 'report' ? subc === '1' : ['1', 'M', 'F'].includes(subc);
}

// ---------------------------------------------------------------------------
// The writes.
// ---------------------------------------------------------------------------

/** RPY_TRANSACTION_INSERT, in the order of its signature. */
export const INSERT_EXCEPTIONS = [
  'CANCELLED', 'ALREADY_EXIST', 'PERMISSION_ERROR', 'NAME_NOT_ALLOWED', 'NAME_CONFLICT',
  'ILLEGAL_TYPE', 'OBJECT_INCONSISTENT', 'DB_ACCESS_ERROR'
];

/** RPY_TRANSACTION_DELETE: the misspelling is SAP's. */
export const DELETE_EXCEPTIONS = ['NOT_EXCECUTED', 'OBJECT_NOT_FOUND'];

export interface TransactionSnippet {
  code: string[];
  exceptions: Record<string, string[]>;
}

const commitLines = (): string[] => [
  'COMMIT WORK AND WAIT.',
  'lv_subrc = sy-subrc.',
  `out->write( |STEP${DDIF_SEPARATOR}commit${DDIF_SEPARATOR}{ lv_subrc }${DDIF_SEPARATOR}0` +
    `${DDIF_SEPARATOR}${DDIF_SEPARATOR}${DDIF_SEPARATOR}| ).`
];

const tstcCount = (literal: string, expected: number, message: string): string[] => [
  `SELECT COUNT(*) FROM tstc INTO lv_count WHERE tcode = ${literal}.`,
  `IF lv_count <> ${expected}.`,
  '  ROLLBACK WORK.',
  `  ${ownStepLine('verify', false, message)}`,
  '  RETURN.',
  'ENDIF.',
  ownStepLine('verify', true)
];

/** The ABAP that creates the transaction: insert, prove the TSTC row, commit. */
export function createTransactionSnippet(spec: TransactionSpec): TransactionSnippet {
  const local = isLocalPackage(spec.packageName);
  if (!spec.packageName) throw new DdifError('Pass packageName: $TMP for a local transaction.');
  if (!local && !spec.request) throw new DdifError(`A transaction in ${spec.packageName} needs a transport request.`);
  const request = local ? undefined : transportNumber(spec.request!);
  const literal = charLiteral(spec.code);
  const insert: StepSpec = {
    step: 'insert',
    call: [
      "CALL FUNCTION 'RPY_TRANSACTION_INSERT'",
      `  EXPORTING transaction = ${literal} program = ${charLiteral(spec.program)} dynpro = '${spec.screen}'`,
      `            language = lv_langu development_class = ${charLiteral(spec.packageName)}`,
      ...(request ? [`            transport_number = ${charLiteral(request)}`] : []),
      `            transaction_type = '${spec.kind === 'report' ? 'R' : 'D'}'`,
      `            shorttext = ${textLiteral(spec.shortText, 'short text', SHORT_TEXT_LENGTH)}`,
      ...(spec.variant ? [`            variant = ${charLiteral(spec.variant)}`] : []),
      `            wingui_enabled = '${spec.wingui ? 'X' : ' '}' html_enabled = '${spec.html ? 'X' : ' '}'`
    ],
    exceptions: INSERT_EXCEPTIONS
  };
  return {
    code: [
      ...DDIF_DECLARATIONS,
      'DATA lv_count TYPE i.',
      ...ddifLanguageLines(spec.language),
      ...stepLines(insert),
      ...tstcCount(literal, 1, `TSTC has no row for ${spec.code} after the insert`),
      ...commitLines()
    ],
    exceptions: { insert: INSERT_EXCEPTIONS }
  };
}

export interface DeleteTransactionSpec {
  code: string;
  packageName: string;
  request?: string;
}

/**
 * The ABAP that deletes the transaction: delete, prove TSTC is empty, in a
 * local package remove the directory entry, commit.
 */
export function deleteTransactionSnippet(spec: DeleteTransactionSpec): TransactionSnippet {
  const code = transactionCode(spec.code);
  const local = isLocalPackage(spec.packageName);
  if (!local && !spec.request) throw new DdifError(`${code} is in package ${spec.packageName}; deleting it needs a transport request.`);
  const request = local ? undefined : transportNumber(spec.request!);
  const literal = charLiteral(code);
  const remove: StepSpec = {
    step: 'delete',
    call: [
      "CALL FUNCTION 'RPY_TRANSACTION_DELETE'",
      `  EXPORTING transaction = ${literal}` + (request ? ` transport_number = ${charLiteral(request)}` : '')
    ],
    exceptions: DELETE_EXCEPTIONS
  };
  const directory: StepSpec = {
    step: 'directory',
    call: [
      "  CALL FUNCTION 'TR_TADIR_INTERFACE'",
      "    EXPORTING wi_delete_tadir_entry = 'X' wi_test_modus = ' ' wi_tadir_pgmid = 'R3TR'",
      `              wi_tadir_object = 'TRAN' wi_tadir_obj_name = ${literal}`
    ],
    continueOnFailure: true
  };
  return {
    code: [
      ...DDIF_DECLARATIONS,
      'DATA lv_count TYPE i.',
      ...stepLines(remove),
      ...tstcCount(literal, 0, `TSTC still holds ${code} after the delete`),
      ...(local
        ? [
          "SELECT COUNT(*) FROM tadir INTO lv_count WHERE pgmid = 'R3TR' AND object = 'TRAN'",
          `  AND obj_name = ${literal}.`,
          'IF lv_count > 0.',
          ...stepLines(directory).map(line => `  ${line}`),
          'ENDIF.'
        ]
        : []),
      ...commitLines()
    ],
    exceptions: { delete: DELETE_EXCEPTIONS, directory: [] }
  };
}

/** The token deleting has to bring back from its preview. */
export function transactionToken(rows: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}
