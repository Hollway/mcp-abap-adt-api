/**
 * Writing DDIC objects the way SE11 does: through the DDIF_* modules, run in a
 * throwaway class.
 *
 * ADT does not reach every dictionary object on every release. On the ERP
 * system these tools were written against there is no /ddic/domains and no
 * /ddic/tables at all, and a transparent table is served by the structure
 * collection as `define type` - without its table class, delivery class or
 * technical settings. Written back, that text turns the table into a structure
 * (see lib/tableGuard). The DDIF modules carry the whole definition instead,
 * so they are the way these objects are written when ADT cannot.
 *
 * Everything that is easy to get wrong about generating that ABAP lives here,
 * away from the handlers, so it can be tested without a system:
 *
 *  - every call is followed by `lv_subrc = sy-subrc` before anything else -
 *    out->write is a method call and resets sy-subrc, which once let a failed
 *    step through unnoticed;
 *  - a failed step stops the snippet, so the next call never runs on top of it;
 *  - the object goes into the transport with RS_CORR_INSERT first, given the
 *    REQUEST rather than a task: with a task the module answers TK 886, and the
 *    PUT and the activation that follow still succeed - leaving an active object
 *    with no directory entry and nothing in any request. And without
 *    use_korrnum_immediatedly: with it the entry lands on the request header,
 *    an object nobody owns in SE09; without it the module puts the entry and
 *    its TLOCK into the caller's own task of that request and returns the task
 *    as korrnum (measured on the ERP system, 2026-10-13);
 *  - sy-msg* after a successful call is often noise (an empty message ID with
 *    number 003), so a step is judged by its subrc and rc, never by a message.
 */
import { charLiteral, languageLines } from './textPool';
import { isNoiseMessage, transportNumber } from './transportRegistration';

export class DdifError extends Error {}

/** The separator the generated ABAP prints its lines with. */
export const DDIF_SEPARATOR = '~#~';

const NAME = /^[A-Z][A-Z0-9_]*$/;
const NAMESPACED = /^\/[A-Z0-9_]{1,10}\/[A-Z0-9_]+$/;

/**
 * A dictionary name, checked before it is pasted into a statement.
 *
 * A name that needs escaping at all is a name no statement should be built
 * from, so this refuses rather than escapes.
 */
export function ddicObjectName(value: unknown, what: string, maxLength = 30): string {
  const name = String(value ?? '').trim().toUpperCase();
  if (!name) throw new DdifError(`Which ${what}? Pass its name.`);
  if (name.length > maxLength) {
    throw new DdifError(`The ${what} name ${name} is ${name.length} characters; the dictionary allows ${maxLength}.`);
  }
  if (!NAME.test(name) && !NAMESPACED.test(name)) {
    throw new DdifError(`'${value}' is not a ${what} name: letters, digits and underscores, starting with a letter (or /NAMESPACE/NAME).`);
  }
  return name;
}

/** A package name: $TMP and friends, or a dictionary-style name. */
export function packageName(value: unknown): string {
  const name = String(value ?? '').trim().toUpperCase();
  if (!name) throw new DdifError('Which package? Pass packageName ($TMP for a local object).');
  if (name.startsWith('$')) {
    if (!/^\$[A-Z0-9_]{0,29}$/.test(name)) throw new DdifError(`'${value}' is not a package name.`);
    return name;
  }
  return ddicObjectName(name, 'package');
}

export const isLocalPackage = (name: string): boolean => String(name || '').startsWith('$');

/**
 * A text for a CHAR field of the given length, as a literal.
 *
 * Cut silently it would be a different text than the one asked for, so a text
 * that does not fit is refused with its length.
 */
export function textLiteral(value: unknown, what: string, maxLength: number): string {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new DdifError(`The ${what} cannot contain a line break.`);
  if (text.length > maxLength) {
    throw new DdifError(`The ${what} is ${text.length} characters; the field holds ${maxLength}.`);
  }
  return charLiteral(text);
}

/** A whole number within bounds, for a NUMC or INT field. */
export function wholeNumber(value: unknown, what: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DdifError(`${what} is a whole number from ${min} to ${max}, not '${value}'.`);
  }
  return number;
}

/** An ABAP flag field: 'X' or blank. */
export const flagLiteral = (value: unknown): string => (value === true ? `'X'` : `' '`);

/** The declarations every DDIF snippet starts with. */
export const DDIF_DECLARATIONS = [
  'DATA lv_subrc TYPE i.',
  'DATA lv_rc TYPE i.',
  'DATA lv_msg TYPE string.',
  'DATA lv_langu TYPE sy-langu.',
  'DATA lv_korrnum TYPE trkorr.',
  'DATA lv_ordernum TYPE trkorr.'
];

/** The language lines, with the language checked the way the text pool does it. */
export const ddifLanguageLines = (language?: string): string[] => languageLines(language);

export interface StepSpec {
  /** Short lowercase name the step is reported under. */
  step: string;
  /** The CALL FUNCTION, without its EXCEPTIONS clause. */
  call: string[];
  /** Classic exceptions in signature order; they get subrc 1, 2, ... and OTHERS gets 99. */
  exceptions?: string[];
  /** The call fills lv_rc (an activation); rc above 4 counts as failure. */
  rc?: boolean;
  /** Keep going after a failure - for a step whose failure is only reported. */
  continueOnFailure?: boolean;
}

/** The subrc OTHERS is mapped to. */
export const OTHERS_SUBRC = 99;

/**
 * The EXCEPTIONS clause, wrapped: a module with many exceptions
 * (TR_APPEND_TO_COMM_OBJS_KEYS has 67) would otherwise put some 1,700
 * characters on one line, and a class with a line past 255 is not written.
 */
export const exceptionClause = (exceptions: string[] = []): string[] => {
  const parts = [...exceptions.map((name, index) => `${name.toLowerCase()} = ${index + 1}`), `OTHERS = ${OTHERS_SUBRC}`];
  const lines: string[] = [];
  let line = '  EXCEPTIONS';
  for (const part of parts) {
    if (line.length + part.length + 1 > 200) {
      lines.push(line);
      line = '            ';
    }
    line += ` ${part}`;
  }
  lines.push(`${line}.`);
  return lines;
};

/**
 * One call with its bookkeeping: run it, keep sy-subrc and the message before
 * anything can reset them, print the outcome, and stop on a failure.
 */
export function stepLines(spec: StepSpec): string[] {
  const failed = spec.rc ? 'lv_subrc <> 0 OR lv_rc > 4' : 'lv_subrc <> 0';
  return [
    'CLEAR lv_rc.',
    ...spec.call,
    ...exceptionClause(spec.exceptions),
    'lv_subrc = sy-subrc.',
    'CLEAR lv_msg.',
    'IF sy-msgid IS NOT INITIAL.',
    '  MESSAGE ID sy-msgid TYPE \'S\' NUMBER sy-msgno WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.',
    'ENDIF.',
    `out->write( |STEP${DDIF_SEPARATOR}${spec.step}${DDIF_SEPARATOR}{ lv_subrc }${DDIF_SEPARATOR}{ lv_rc }` +
      `${DDIF_SEPARATOR}{ sy-msgid }${DDIF_SEPARATOR}{ sy-msgno }${DDIF_SEPARATOR}{ lv_msg }| ).`,
    ...(spec.continueOnFailure ? [] : [`IF ${failed}.`, '  RETURN.', 'ENDIF.'])
  ];
}

/**
 * A step of the snippet's own - a comparison, a count - reported the way a
 * module call is: subrc 0 for ok, 4 for a stop, and a message with no ID, so
 * the parser keeps the text and does not take it for a module's message.
 * `message` may hold string-template expressions ({ lv_x }).
 */
export const ownStepLine = (step: string, ok: boolean, message = ''): string =>
  `out->write( |STEP${DDIF_SEPARATOR}${step}${DDIF_SEPARATOR}${ok ? 0 : 4}${DDIF_SEPARATOR}0${DDIF_SEPARATOR}` +
  `${DDIF_SEPARATOR}${DDIF_SEPARATOR}${message}| ).`;

/** A value the snippet reports alongside its steps. */
export const infoLine = (key: string, expression: string): string =>
  `out->write( |INFO${DDIF_SEPARATOR}${key}${DDIF_SEPARATOR}{ ${expression} }| ).`;

export interface CorrectionSpec {
  /** Object type, four characters: DOMA, TABL, DTEL. */
  objectType: string;
  name: string;
  packageName: string;
  /** The request. Omitted for a local package. */
  request?: string;
  /** 'I' for a new object, ' ' for one that exists and only needs the lock. */
  mode: 'I' | ' ';
}

export const CORRECTION_EXCEPTIONS = ['CANCELLED', 'PERMISSION_FAILURE', 'UNKNOWN_OBJECTCLASS'];

/**
 * Put the object into the transport, and its directory entry into TADIR.
 *
 * This comes first. Run after the PUT, the object would be written without a
 * directory entry, and with nothing in any request - the change would stay on
 * this system. In a local package there is no request, and the call still
 * makes the TADIR entry. The task the module chose comes back as korrnum and
 * is printed, so the answer can say where the object went.
 */
export function correctionStep(spec: CorrectionSpec): StepSpec {
  if (!/^[A-Z]{4}$/.test(spec.objectType)) throw new DdifError(`'${spec.objectType}' is not an object type.`);
  const local = isLocalPackage(spec.packageName);
  if (!local && !spec.request) {
    throw new DdifError(`A change in ${spec.packageName} needs a transport request; only a $ package goes without one.`);
  }
  const request = local ? undefined : transportNumber(spec.request);
  return {
    step: 'transport',
    call: [
      "CALL FUNCTION 'RS_CORR_INSERT'",
      `  EXPORTING object = ${charLiteral(spec.objectType + spec.name)} object_class = 'DICT' mode = '${spec.mode}' global_lock = 'X'`,
      `            devclass = ${charLiteral(spec.packageName)}` +
        (request ? ` korrnum = ${charLiteral(request)}` : ''),
      "            author = sy-uname master_language = lv_langu suppress_dialog = 'X'",
      '  IMPORTING korrnum = lv_korrnum ordernum = lv_ordernum'
    ],
    exceptions: CORRECTION_EXCEPTIONS
  };
}

/** The task and request RS_CORR_INSERT chose, printed right after it. */
export const correctionInfoLines = (): string[] => [
  infoLine('task', 'lv_korrnum'),
  infoLine('request', 'lv_ordernum')
];

export interface DdifStep {
  step: string;
  subrc: number;
  rc: number;
  ok: boolean;
  /** The classic exception the subrc stands for, when there is one. */
  exception?: string;
  message?: string;
  messageId?: string;
  messageNumber?: string;
}

export interface DdifPrint {
  steps: DdifStep[];
  info: Record<string, string>;
}

const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What the snippet printed, back as steps.
 *
 * `exceptions` maps a step to its exception names, so a subrc becomes the name
 * the module raised rather than a number to look up.
 */
export function parseDdifPrint(output: string, exceptions: Record<string, string[]> = {}): DdifPrint {
  const separator = escapeForRegex(DDIF_SEPARATOR);
  const stepPattern = new RegExp(
    `^STEP${separator}([a-z_]+)${separator}(-?\\d+)${separator}(-?\\d+)${separator}(.*?)${separator}(.*?)${separator}(.*)$`
  );
  const infoPattern = new RegExp(`^INFO${separator}([A-Za-z_]+)${separator}(.*)$`);
  const steps: DdifStep[] = [];
  const info: Record<string, string> = {};

  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const match = stepPattern.exec(line);
    if (match) {
      const [, step, subrcText, rcText, messageId, messageNumber, message] = match;
      const subrc = Number(subrcText);
      const rc = Number(rcText);
      const names = exceptions[step] || [];
      const exception = subrc === OTHERS_SUBRC
        ? 'OTHERS'
        : subrc > 0 ? names[subrc - 1] : undefined;
      const ok = subrc === 0 && rc <= 4;
      // D0/322 is the activation's progress line ("closing phase 013 ****"),
      // left in sy-msg* whatever the outcome - it says nothing about why.
      const progress = messageId.trim() === 'D0' && messageNumber.trim() === '322';
      // A step that worked leaves its last progress line in sy-msg* ("closing
      // phase 004 ****"), which reads like a finding and is not one: the
      // message is kept only where it explains a failure.
      steps.push({
        step,
        subrc,
        rc,
        ok,
        ...(exception ? { exception } : {}),
        // A step of the snippet's own (compare, rows) explains itself with no
        // message ID at all; a module's message carries its ID and number.
        ...(!ok && !progress && message.trim() && !isNoiseMessage(`${messageId.trim()}/${messageNumber.trim()}`)
          ? {
            message: message.trim(),
            ...(messageId.trim() ? { messageId: messageId.trim(), messageNumber: messageNumber.trim() } : {})
          }
          : {})
      });
      continue;
    }
    const infoMatch = infoPattern.exec(line);
    if (infoMatch) info[infoMatch[1]] = infoMatch[2].trim();
  }
  return { steps, info };
}

/** The step that stopped the run, if one did. */
export const failedStep = (print: DdifPrint): DdifStep | undefined => print.steps.find(step => !step.ok);

/**
 * What an activation rc means.
 *
 * 4 is a warning and the object is active; 8 and above mean it is not, and
 * the inactive version is left behind with whatever made it fail.
 */
export function activationVerdict(rc: number): string {
  if (rc === 0) return 'Activated.';
  if (rc === 4) return 'Activated with warnings.';
  if (rc === 8) return 'Not activated: the definition has errors (rc 8). The inactive version is left behind.';
  return `Not activated (rc ${rc}). The inactive version is left behind.`;
}

/**
 * The request the object goes into, from whatever number the caller had.
 *
 * DDIC objects are recorded on the request itself, not in a task, and
 * RS_CORR_INSERT refuses a task number (TK 886) - so a task is resolved to the
 * request it belongs to. A request that is released, or not a workbench
 * request, is refused here rather than by the module halfway through.
 */
export interface RequestHeader {
  TRKORR?: string;
  STRKORR?: string;
  TRSTATUS?: string;
  TRFUNCTION?: string;
}

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

export function requestFrom(
  given: string,
  header: RequestHeader | undefined,
  parent?: RequestHeader
): { request: string; fromTask?: string } {
  const number = transportNumber(given);
  if (!header) throw new DdifError(`${number} does not exist on this system.`);
  const task = clean(header.STRKORR) ? number : undefined;
  const request = task ? parent : header;
  if (task && !request) {
    throw new DdifError(`${number} is a task of ${clean(header.STRKORR)}, which could not be read.`);
  }
  const requestNumber = task ? clean(header.STRKORR) : number;
  if (clean(request?.TRSTATUS) !== 'D') {
    throw new DdifError(`${requestNumber} is not modifiable (status ${clean(request?.TRSTATUS) || 'unknown'}). Use an open request.`);
  }
  if (clean(request?.TRFUNCTION) !== 'K') {
    throw new DdifError(
      `${requestNumber} is not a workbench request (type ${clean(request?.TRFUNCTION) || 'unknown'}); a dictionary object travels in one.`
    );
  }
  return { request: requestNumber, ...(task ? { fromTask: task } : {}) };
}

export const requestHeaderSql = (number: string): string =>
  `SELECT trkorr, strkorr, trstatus, trfunction FROM e070 WHERE trkorr = '${transportNumber(number)}'`;

/** Where a TADIR entry already points, which is how "this name is taken" is answered. */
export const directorySql = (objectType: string, name: string): string =>
  `SELECT devclass, author FROM tadir WHERE pgmid = 'R3TR' AND object = '${objectType}' AND obj_name = '${name}'`;

export const packageExistsSql = (name: string): string =>
  `SELECT devclass FROM tdevc WHERE devclass = '${name}'`;

/**
 * Every request entry of an object. Filtered against the request and its
 * tasks afterwards: a join doing both in one statement runs past the 255
 * characters the query endpoint accepts once the name is long.
 */
export const recordedSql = (objectType: string, name: string): string =>
  `SELECT trkorr FROM e071 WHERE pgmid = 'R3TR' AND object = '${objectType}' AND obj_name = '${name}'`;

export const tasksOfSql = (request: string): string =>
  `SELECT trkorr FROM e070 WHERE strkorr = '${transportNumber(request)}'`;
