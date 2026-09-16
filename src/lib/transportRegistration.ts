/**
 * Putting an object into a transport request by hand.
 *
 * Most writes register themselves: ADT asks for a request, the backend adds the
 * object key, and the change travels. A few do not - `INSERT TEXTPOOL` writes
 * the text pool straight into the database and tells no one - and the change
 * then stays in the system it was made on. That is the quiet kind of failure:
 * everything works here and the next system never sees it.
 *
 * `RS_CORR_INSERT`, the obvious candidate, does not work from an ADT class: it
 * answers `subrc = 1` (CANCELLED) even with `korrnum` and `suppress_dialog`,
 * with a request number and with a task number alike. `TR_APPEND_TO_COMM_OBJS_KEYS`
 * does work, with two conditions this module exists to hold:
 *
 *  - `WI_TRKORR` wants the **task**, not the request. A request number is
 *    accepted by the parameter and does nothing useful;
 *  - the message `SCTS_CTO_CUST_SYNC/003` sits in `sy-msg*` after a successful
 *    call. It is noise, not a failure.
 *
 * The module has 67 exceptions with names that say what went wrong, which is
 * worth turning into a sentence rather than a number.
 */

export class TransportRegistrationError extends Error {}

/** A row of E071: what is registered, and as what. */
export interface E071Row {
  PGMID: string;
  OBJECT: string;
  OBJ_NAME: string;
}

/**
 * `R3TR` is a whole object, `LIMU` a part of one.
 *
 * The two that matter for texts: `R3TR PROG <program>` moves the program with
 * its text pool, `LIMU REPT <program>` moves the text pool alone.
 */
export const PGMIDS = ['R3TR', 'LIMU'] as const;
export type Pgmid = typeof PGMIDS[number];

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

export function buildE071Row(spec: { pgmid?: string; object: string; objName: string }): E071Row {
  const pgmid = clean(spec.pgmid) || 'R3TR';
  if (!(PGMIDS as readonly string[]).includes(pgmid)) {
    throw new TransportRegistrationError(
      `pgmid is ${PGMIDS.join(' or ')}, not '${spec.pgmid}'. R3TR is a whole object, LIMU a part of one.`
    );
  }
  const object = clean(spec.object);
  if (!/^[A-Z0-9]{1,4}$/.test(object)) {
    throw new TransportRegistrationError(
      `'${spec.object}' is not an object type: it is up to four characters, e.g. PROG, CLAS, REPT.`
    );
  }
  const objName = clean(spec.objName);
  if (!objName) throw new TransportRegistrationError('Which object? Pass objName.');
  if (objName.length > 120) {
    throw new TransportRegistrationError(`The object name is ${objName.length} characters; E071-OBJ_NAME holds 120.`);
  }
  if (!/^[A-Z0-9_/$<>.\-+#]+$/.test(objName)) {
    throw new TransportRegistrationError(`'${spec.objName}' does not look like an object name.`);
  }
  return { PGMID: pgmid, OBJECT: object, OBJ_NAME: objName };
}

/**
 * Every exception the module raises, and what each one means.
 *
 * The ones spelled out here are the ones a caller actually hits. The rest keep
 * their name and get the sentence their prefix earns - saying "OB_WRONG_TABLETYP
 * means the object was refused" is honest; inventing a detailed diagnosis for an
 * exception nobody here has seen would not be.
 */
export const EXCEPTION_DIAGNOSIS: Readonly<Record<string, string>> = {
  TR_ORDER_NOT_EXIST: 'There is no such request or task on this system.',
  TR_ORDER_RELEASED: 'The request is already released, so nothing can be added to it. Use an open one.',
  TR_NOT_OWNER: 'The task belongs to somebody else. Register through your own task in that request.',
  TR_ILL_KORRNUM: 'The number is not a request or task number the system accepts.',
  TR_WRONG_ORDER_TYPE: 'That kind of request does not take this object - a workbench object needs a workbench request.',
  TR_NO_AUTHORIZATION: 'Your user may not change this request.',
  TR_ENQUEUE_FAILED: 'The request is locked by another process right now. Try again in a moment.',
  TR_LOCK_ENQUEUE_FAILED: 'The object could not be locked for the request; somebody is working on it.',
  TR_WRONG_CLIENT: 'The request belongs to another client.',
  OB_LOCKED_BY_OTHER: 'The object is already locked in somebody else\'s request, and it can only live in one.',
  OB_LOCAL_OBJECT: 'The object is local ($TMP): local objects are never transported. Move it to a package first.',
  OB_NO_TADIR: 'The object has no directory entry (TADIR), so the system does not know it exists to transport it.',
  OB_NO_TADIR_NOT_LOCKABLE: 'The object has no directory entry and cannot be locked into a request.',
  OB_NO_ORIGINAL: 'This system is not the original system of the object - changing it here is a repair, not a change.',
  OB_MODIF_ONLY_IN_MODIF_ORDER: 'A modification of SAP code goes into a modification request, not this one.',
  OB_REPAIR_ONLY_IN_REPAIR_ORDER: 'A repair goes into a repair request, not this one.',
  OB_RESERVED_NAME: 'The name is in a reserved namespace.',
  OB_NAME_TOO_LONG: 'The object name is longer than the key allows.',
  OB_DEVCLASS_NO_EXIST: 'The package of the object does not exist.',
  OB_PRIVAT_OBJECT: 'The object is private to its owner and cannot be transported this way.',
  OB_ILL_TARGET: 'The target system of the request does not suit this object.',
  OB_SYSTEM_ERROR: 'The transport system itself failed on this object; the details are in its own log.',
  TR_ERRORS_IN_ERROR_TABLE: 'The module refused the entry and put the reason in its error table.'
};

/** The 67 exceptions of TR_APPEND_TO_COMM_OBJS_KEYS, as the signature lists them. */
export const EXCEPTIONS: ReadonlySet<string> = new Set([
  'KEY_CHAR_IN_NON_CHAR_FIELD', 'KEY_CHECK_KEYSYNTAX_ERROR', 'KEY_INTTAB_TABLE',
  'KEY_LONGER_FIELD_BUT_NO_GENERC', 'KEY_MISSING_KEY_MASTER_FIELDS', 'KEY_MISSING_KEY_TABLEKEY',
  'KEY_NON_CHAR_BUT_NO_GENERIC', 'KEY_NO_KEY_FIELDS', 'KEY_STRING_LONGER_CHAR_KEY',
  'KEY_TABLE_HAS_NO_FIELDS', 'KEY_TABLE_NOT_ACTIV', 'KEY_UNALLOWED_KEY_FUNCTION',
  'KEY_UNALLOWED_KEY_OBJECT', 'KEY_UNALLOWED_KEY_OBJNAME', 'KEY_UNALLOWED_KEY_PGMID',
  'KEY_WITHOUT_HEADER', 'KEY_WRONG_CLIENT',
  'OB_CHECK_OBJ_ERROR', 'OB_DEVCLASS_NO_EXIST', 'OB_EMPTY_KEY', 'OB_GENERIC_OBJECTNAME',
  'OB_ILL_DELIVERY_TRANSPORT', 'OB_ILL_LOCK', 'OB_ILL_PARTS_TRANSPORT', 'OB_ILL_SOURCE_SYSTEM',
  'OB_ILL_SYSTEM_OBJECT', 'OB_ILL_TARGET', 'OB_INTTAB_TABLE', 'OB_INVALID_TARGET_SYSTEM',
  'OB_LOCAL_OBJECT', 'OB_LOCKED_BY_OTHER', 'OB_MODIF_ONLY_IN_MODIF_ORDER', 'OB_NAME_TOO_LONG',
  'OB_NO_APPEND_OF_CORR_ENTRY', 'OB_NO_APPEND_OF_C_MEMBER', 'OB_NO_CONSOLIDATION_TRANSPORT',
  'OB_NO_ORIGINAL', 'OB_NO_SHARED_REPAIRS', 'OB_NO_SYSTEMNAME', 'OB_NO_SYSTEMTYPE', 'OB_NO_TADIR',
  'OB_NO_TADIR_NOT_LOCKABLE', 'OB_PRIVAT_OBJECT', 'OB_REPAIR_ONLY_IN_REPAIR_ORDER',
  'OB_RESERVED_NAME', 'OB_SYNTAX_ERROR', 'OB_SYSTEM_ERROR', 'OB_TABLE_HAS_NO_FIELDS',
  'OB_TABLE_NOT_ACTIV', 'OB_UNLOCAL_OBJEKT_IN_LOCAL_ORD', 'OB_WRONG_CATEGORY', 'OB_WRONG_CLIENT',
  'OB_WRONG_TABLETYP',
  'TR_ENQUEUE_FAILED', 'TR_ERRORS_IN_ERROR_TABLE', 'TR_ILL_KORRNUM', 'TR_LOCKMOD_FAILED',
  'TR_LOCK_ENQUEUE_FAILED', 'TR_NOT_OWNER', 'TR_NO_AUTHORIZATION', 'TR_NO_SYSTEMNAME',
  'TR_NO_SYSTEMTYPE', 'TR_ORDER_NOT_EXIST', 'TR_ORDER_RELEASED', 'TR_ORDER_UPDATE_ERROR',
  'TR_WRONG_CLIENT', 'TR_WRONG_ORDER_TYPE'
]);

/** What an exception name means, in a sentence. */
export function diagnose(exception: string): string {
  const name = clean(exception);
  if (!name) return '';
  const known = EXCEPTION_DIAGNOSIS[name];
  if (known) return known;
  if (name.startsWith('TR_')) return `The request was refused (${name}).`;
  if (name.startsWith('OB_')) return `The object was refused (${name}).`;
  if (name.startsWith('KEY_')) return `The key entry was refused (${name}).`;
  return `The module raised ${name}.`;
}

/**
 * Messages that mean nothing.
 *
 * `SCTS_CTO_CUST_SYNC/003` is left in `sy-msg*` by a call that worked. Reading
 * it as a failure is the mistake this list prevents.
 */
export const NOISE_MESSAGES: readonly string[] = ['SCTS_CTO_CUST_SYNC/003'];

export const isNoiseMessage = (message: unknown): boolean => {
  const text = String(message ?? '').toUpperCase().replace(/\s+/g, '');
  return NOISE_MESSAGES.some(noise => text.includes(noise.toUpperCase().replace(/\s+/g, '')));
};

const TRANSPORT_NUMBER = /^[A-Z][A-Z0-9]{2}K[A-Z0-9]{5,16}$/;
const USER_NAME = /^[A-Z0-9_.\-]{1,12}$/;

/** A request or task number, checked before it goes into a statement. */
export function transportNumber(value: unknown): string {
  const number = clean(value);
  if (!TRANSPORT_NUMBER.test(number)) {
    throw new TransportRegistrationError(
      `'${value}' is not a transport number - they read like DEVK900123.`
    );
  }
  return number;
}

export function userName(value: unknown): string {
  const user = clean(value);
  if (!USER_NAME.test(user)) {
    throw new TransportRegistrationError(`'${value}' is not a user name.`);
  }
  return user;
}

/**
 * A row of E070, as the queries below read it.
 *
 * Every column is optional because the row arrives as untyped JSON from the
 * query tool: a column the backend did not fill is simply absent, and reading
 * it as a missing string is exactly right.
 */
export interface TransportHeaderRow {
  TRKORR?: string;
  /** The parent request of a task; empty on a request itself. */
  STRKORR?: string;
  /** D modifiable, R released. */
  TRSTATUS?: string;
  AS4USER?: string;
  TRFUNCTION?: string;
}

export const headerSql = (number: string): string =>
  'SELECT trkorr, strkorr, trstatus, trfunction, as4user FROM e070 ' +
  `WHERE trkorr = '${transportNumber(number)}'`;

export const tasksSql = (request: string): string =>
  'SELECT trkorr, strkorr, trstatus, trfunction, as4user FROM e070 ' +
  `WHERE strkorr = '${transportNumber(request)}' ORDER BY trkorr`;

export const registeredSql = (task: string, row: E071Row): string =>
  'SELECT trkorr, pgmid, object, obj_name FROM e071 ' +
  `WHERE trkorr = '${transportNumber(task)}' AND pgmid = '${row.PGMID}' ` +
  `AND object = '${row.OBJECT}' AND obj_name = '${row.OBJ_NAME}'`;

/**
 * The package of an object.
 *
 * A local object ($TMP, or any package starting with $) is never transported,
 * and warning that it is in no request would be noise on every throwaway
 * program.
 */
export const packageSql = (row: E071Row): string =>
  'SELECT devclass FROM tadir ' +
  `WHERE pgmid = '${row.PGMID}' AND object = '${row.OBJECT}' AND obj_name = '${row.OBJ_NAME}'`;

export const isLocalPackage = (devclass: unknown): boolean => {
  const name = clean(devclass);
  return name.startsWith('$');
};

/** Where an object already sits, which is the answer to OB_LOCKED_BY_OTHER. */
export const holdersSql = (row: E071Row): string =>
  'SELECT e071~trkorr, e070~trstatus, e070~as4user, e070~strkorr FROM e071 ' +
  'INNER JOIN e070 ON e070~trkorr = e071~trkorr ' +
  `WHERE e071~pgmid = '${row.PGMID}' AND e071~object = '${row.OBJECT}' ` +
  `AND e071~obj_name = '${row.OBJ_NAME}' AND e070~trstatus = 'D'`;

export interface TaskChoice {
  /** The task the registration is written to. */
  task: string;
  /** The request it belongs to, when one is known. */
  request?: string;
  resolvedFrom: 'task' | 'request';
}

const isRequest = (row: TransportHeaderRow): boolean => !clean(row.STRKORR);
const isOpen = (row: TransportHeaderRow): boolean => clean(row.TRSTATUS) === 'D';

/**
 * The task to write to, from whatever number the caller had to hand.
 *
 * A task is used as it stands. A request is resolved to the caller's own open
 * task in it, because that is the one they may write to - somebody else's task
 * is refused by the module anyway, and guessing which of several is "theirs"
 * would be worse than saying what is there.
 */
export function chooseTask(
  given: string,
  header: TransportHeaderRow | undefined,
  tasks: TransportHeaderRow[],
  user: string
): TaskChoice {
  const number = transportNumber(given);
  const owner = userName(user);

  if (!header) {
    throw new TransportRegistrationError(`${number} does not exist on this system.`);
  }
  if (!isOpen(header)) {
    throw new TransportRegistrationError(
      `${number} is released (status ${clean(header.TRSTATUS) || 'unknown'}); nothing can be added to it.`
    );
  }

  if (!isRequest(header)) {
    const holder = clean(header.AS4USER);
    if (holder && holder !== owner) {
      throw new TransportRegistrationError(
        `${number} is a task of ${holder}, and only its owner may write to it. ` +
        `Pass the request ${clean(header.STRKORR)} instead and your own task in it will be used.`
      );
    }
    return { task: number, request: clean(header.STRKORR) || undefined, resolvedFrom: 'task' };
  }

  const open = tasks.filter(isOpen);
  const mine = open.filter(task => clean(task.AS4USER) === owner);
  if (mine.length === 1) return { task: clean(mine[0].TRKORR), request: number, resolvedFrom: 'request' };
  if (mine.length > 1) {
    // Two open tasks of one user in one request is unusual and ambiguous: a
    // guess here puts the object in a task the caller is not looking at.
    throw new TransportRegistrationError(
      `${number} holds ${mine.length} open tasks of ${owner} (${mine.map(t => clean(t.TRKORR)).join(', ')}). ` +
      'Pass the one to write to.'
    );
  }

  const others = open.map(task => `${clean(task.TRKORR)} (${clean(task.AS4USER) || 'no owner'})`);
  throw new TransportRegistrationError(
    `${number} has no open task of ${owner}` +
    (others.length ? `; the open tasks in it are ${others.join(', ')}.` : ', and no open tasks at all.') +
    ' Create a task for yourself in that request, or pass a task number.'
  );
}
