/**
 * Transparent tables written through DDIF_TABL_PUT - created, or their field
 * list changed.
 *
 * Why not ADT: on the ERP system these tools were written against there is no
 * /ddic/tables, and a table is served by the structure collection as
 * `define type` - without its table class, delivery class or technical
 * settings. Written back, that text turns the table into a structure, and the
 * activation fails (see lib/tableGuard). DDIF_TABL_GET hands over the whole
 * definition - header, technical settings, fields, foreign keys, search help
 * assignments - and DDIF_TABL_PUT takes all of it back, so a change of the
 * field list touches nothing else.
 *
 * What was measured live and is held here:
 *
 *  - the foreign keys (DD05M/DD08V) and the search help assignments
 *    (DD35V/DD36M) have to go back into the PUT: left out, they are deleted;
 *  - an activation that fails (rc 8) leaves an inactive version next to the
 *    active one; a PUT of the definition read before the change, activated
 *    again, removes it and leaves the table as it was;
 *  - a column is proven to exist in the database with ADBC - execute_query,
 *    set_param, next - because the dictionary saying so is not proof; without
 *    next( ) a missing column does not raise at all, and without set_param
 *    an existing one does;
 *  - a row count through ADBC counts every client, which the data preview
 *    (current client only) does not;
 *  - no line of ABAP source may exceed 255 characters.
 */
import { createHash } from 'crypto';
import { charLiteral } from './textPool';
import {
  DDIF_DECLARATIONS,
  DDIF_SEPARATOR,
  DdifError,
  correctionInfoLines,
  correctionStep,
  ddicObjectName,
  ddifLanguageLines,
  stepLines,
  textLiteral,
  wholeNumber
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';

/** A transparent table name, and a field name in one, are at most 16 characters. */
export const TABLE_NAME_LENGTH = 16;
export const FIELD_NAME_LENGTH = 16;
const DESCRIPTION_LENGTH = 60;

export const TABLE_PUT_EXCEPTIONS = ['TABL_NOT_FOUND', 'NAME_INCONSISTENT', 'TABL_INCONSISTENT', 'PUT_FAILURE', 'PUT_REFUSED'];
export const TABLE_ACTIVATE_EXCEPTIONS = ['NOT_FOUND', 'PUT_FAILURE'];
export const TABLE_GET_EXCEPTIONS = ['ILLEGAL_INPUT'];

export const DELIVERY_CLASSES = ['A', 'C', 'L', 'G', 'E', 'S', 'W'];
/** DD02V-MAINFLAG: 'X' allowed, ' ' allowed with restrictions, 'N' not allowed. */
export const MAINTENANCE: Record<string, string> = { allowed: 'X', restricted: ' ', none: 'N' };
/** DD09V-BUFALLOW: 'N' not allowed, 'A' allowed but switched off. */
export const BUFFERING: Record<string, string> = { none: 'N', allowedOff: 'A' };
/** DD02V-EXCLASS. */
export const ENHANCEMENT: Record<string, string> = {
  notClassified: '0',
  notExtensible: '1',
  characterLike: '2',
  characterOrNumeric: '3',
  any: '4'
};

export const tableName = (value: unknown): string => ddicObjectName(value, 'table', TABLE_NAME_LENGTH);
export const fieldName = (value: unknown): string => ddicObjectName(value, 'field', FIELD_NAME_LENGTH);
export const dataElementName = (value: unknown): string => ddicObjectName(value, 'data element');

export interface TableFieldSpec {
  name: string;
  dataElement: string;
  key?: boolean;
}

export interface CreateTableSpec {
  name: string;
  description: string;
  packageName: string;
  request?: string;
  language?: string;
  fields: TableFieldSpec[];
  /** Client-dependent, with MANDT as the first key field. Default true. */
  clientDependent?: boolean;
  deliveryClass?: string;
  dataMaintenance?: string;
  dataClass?: string;
  sizeCategory?: number;
  buffering?: string;
  enhancementCategory?: string;
  activate?: boolean;
}

/** The settings a table gets when the caller names none: a plain client-dependent application table. */
export const TABLE_DEFAULTS = {
  clientDependent: true,
  deliveryClass: 'A',
  dataMaintenance: 'allowed',
  dataClass: 'APPL2',
  sizeCategory: 0,
  buffering: 'none',
  enhancementCategory: 'notExtensible'
};

const choice = (value: unknown, allowed: Record<string, string>, what: string): string => {
  const key = String(value);
  if (!(key in allowed)) {
    throw new DdifError(`${what} is one of ${Object.keys(allowed).join(', ')}, not '${value}'.`);
  }
  return allowed[key];
};

/**
 * The field list as it will be written: names checked, keys first and
 * contiguous, MANDT in front of a client-dependent table.
 */
export function tableFields(fields: unknown, clientDependent: boolean): TableFieldSpec[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new DdifError('Pass fields: [{name, dataElement, key}] - a table needs at least one.');
  }
  const list: TableFieldSpec[] = fields.map((field: any, index) => {
    if (!field || typeof field !== 'object') throw new DdifError(`Field ${index + 1} is not {name, dataElement, key}.`);
    return { name: fieldName(field.name), dataElement: dataElementName(field.dataElement), key: field.key === true };
  });
  const hasClient = list[0]?.name === 'MANDT';
  if (clientDependent && !hasClient) {
    if (list.some(field => field.name === 'MANDT')) {
      throw new DdifError('MANDT has to be the first field of a client-dependent table.');
    }
    list.unshift({ name: 'MANDT', dataElement: 'MANDT', key: true });
  }
  if (!clientDependent && list.some(field => field.name === 'MANDT')) {
    throw new DdifError('A client-independent table has no MANDT field; drop it or leave clientDependent on.');
  }
  if (clientDependent && !list[0].key) throw new DdifError('MANDT has to be a key field.');
  checkFieldList(list);
  return list;
}

/** Unique names, at least one key besides the client, keys first and contiguous. */
export function checkFieldList(list: { name: string; key?: boolean }[]): void {
  const seen = new Set<string>();
  for (const field of list) {
    if (seen.has(field.name)) throw new DdifError(`Field ${field.name} appears twice.`);
    seen.add(field.name);
  }
  const firstNonKey = list.findIndex(field => !field.key);
  if (firstNonKey === 0) throw new DdifError('A table needs at least one key field, and the key fields come first.');
  if (firstNonKey > 0 && list.slice(firstNonKey).some(field => field.key)) {
    const stray = list.slice(firstNonKey).find(field => field.key)!;
    throw new DdifError(`Key field ${stray.name} comes after a non-key field; the key fields come first, together.`);
  }
  if (list.length > 0 && list.every(field => field.name === 'MANDT' || !field.key)) {
    throw new DdifError('The key needs a field besides MANDT.');
  }
}

/** One dd03p row of a new field, split so no line passes 255 characters. */
const newFieldLines = (table: string, field: TableFieldSpec, target: string): string[] => [
  `APPEND VALUE #( tabname = ${charLiteral(table)} fieldname = ${charLiteral(field.name)}`,
  `  ddlanguage = lv_langu comptype = 'E' rollname = ${charLiteral(field.dataElement)}` +
    (field.key ? ` keyflag = 'X' notnull = 'X'` : '') + ` ) TO ${target}.`
];

const renumberLines = (target: string): string[] => [
  `LOOP AT ${target} ASSIGNING FIELD-SYMBOL(<ls_position>).`,
  "  <ls_position>-position = |{ sy-tabix WIDTH = 4 ALIGN = RIGHT PAD = '0' }|.",
  'ENDLOOP.'
];

/** The declarations the table snippets add to the common ones. */
const TABLE_DECLARATIONS = [
  'DATA ls_dd02v TYPE dd02v.',
  'DATA ls_dd09v TYPE dd09v.',
  'DATA lt_dd03p TYPE STANDARD TABLE OF dd03p WITH EMPTY KEY.',
  'DATA lv_probe TYPE string.',
  'DATA lv_rows TYPE i.',
  'DATA lo_probe TYPE REF TO cl_sql_result_set.',
  'DATA lx_sql TYPE REF TO cx_sql_exception.'
];

/** A table or column name as a quoted identifier inside a native SQL backtick literal. */
const sqlIdentifier = (name: string): string => `"${name}"`;

/**
 * Whether each column exists in the database itself, printed as
 * COLUMN~#~<name>~#~1 or 0 with the database message.
 */
export function columnProbeLines(table: string, columns: string[]): string[] {
  return columns.flatMap(column => [
    'TRY.',
    `    lo_probe = NEW cl_sql_statement( )->execute_query(`,
    `      \`SELECT ${sqlIdentifier(column)} FROM ${sqlIdentifier(table)} WHERE 1 = 0\` ).`,
    '    lo_probe->set_param( REF #( lv_probe ) ).',
    '    lo_probe->next( ).',
    '    lo_probe->close( ).',
    `    out->write( |COLUMN${DDIF_SEPARATOR}${column}${DDIF_SEPARATOR}1${DDIF_SEPARATOR}| ).`,
    '  CATCH cx_sql_exception INTO lx_sql.',
    `    out->write( |COLUMN${DDIF_SEPARATOR}${column}${DDIF_SEPARATOR}0${DDIF_SEPARATOR}{ lx_sql->sql_message }| ).`,
    'ENDTRY.'
  ]);
}

/** The rows of the table across every client, into lv_rows; -1 when it cannot be counted. */
export function rowCountLines(table: string): string[] {
  return [
    'TRY.',
    `    lo_probe = NEW cl_sql_statement( )->execute_query( \`SELECT COUNT(*) FROM ${sqlIdentifier(table)}\` ).`,
    '    lo_probe->set_param( REF #( lv_rows ) ).',
    '    lo_probe->next( ).',
    '    lo_probe->close( ).',
    '  CATCH cx_sql_exception INTO lx_sql.',
    '    lv_rows = -1.',
    'ENDTRY.',
    `out->write( |INFO${DDIF_SEPARATOR}rows${DDIF_SEPARATOR}{ lv_rows }| ).`
  ];
}

const putStep = (table: string, fieldsTable: string, withRelations: boolean, step = 'put'): StepSpec => ({
  step,
  call: [
    "CALL FUNCTION 'DDIF_TABL_PUT'",
    `  EXPORTING name = ${charLiteral(table)} dd02v_wa = ls_dd02v dd09l_wa = ls_dd09v`,
    `  TABLES dd03p_tab = ${fieldsTable}`,
    ...(withRelations
      ? ['         dd05m_tab = lt_dd05m dd08v_tab = lt_dd08v', '         dd35v_tab = lt_dd35v dd36m_tab = lt_dd36m']
      : [])
  ],
  exceptions: TABLE_PUT_EXCEPTIONS
});

const activateStep = (table: string, step = 'activate', continueOnFailure = false): StepSpec => ({
  step,
  call: [
    "CALL FUNCTION 'DDIF_TABL_ACTIVATE'",
    `  EXPORTING name = ${charLiteral(table)} auth_chk = ' '`,
    '  IMPORTING rc = lv_rc'
  ],
  exceptions: TABLE_ACTIVATE_EXCEPTIONS,
  rc: true,
  continueOnFailure
});

export interface TableSnippet {
  code: string[];
  exceptions: Record<string, string[]>;
}

const exceptionMap = (): Record<string, string[]> => ({
  transport: ['CANCELLED', 'PERMISSION_FAILURE', 'UNKNOWN_OBJECTCLASS'],
  get: TABLE_GET_EXCEPTIONS,
  put: TABLE_PUT_EXCEPTIONS,
  activate: TABLE_ACTIVATE_EXCEPTIONS,
  rollback_put: TABLE_PUT_EXCEPTIONS,
  rollback_activate: TABLE_ACTIVATE_EXCEPTIONS
});

/** The ABAP that registers, writes and activates a new table, then proves its columns. */
export function createTableSnippet(spec: CreateTableSpec): TableSnippet & { fields: TableFieldSpec[] } {
  const name = tableName(spec.name);
  const clientDependent = spec.clientDependent ?? TABLE_DEFAULTS.clientDependent;
  const fields = tableFields(spec.fields, clientDependent);
  const deliveryClass = String(spec.deliveryClass ?? TABLE_DEFAULTS.deliveryClass).toUpperCase();
  if (!DELIVERY_CLASSES.includes(deliveryClass)) {
    throw new DdifError(`deliveryClass is one of ${DELIVERY_CLASSES.join(', ')}, not '${spec.deliveryClass}'.`);
  }
  const mainflag = choice(spec.dataMaintenance ?? TABLE_DEFAULTS.dataMaintenance, MAINTENANCE, 'dataMaintenance');
  const bufallow = choice(spec.buffering ?? TABLE_DEFAULTS.buffering, BUFFERING, 'buffering');
  const exclass = choice(spec.enhancementCategory ?? TABLE_DEFAULTS.enhancementCategory, ENHANCEMENT, 'enhancementCategory');
  const dataClass = String(spec.dataClass ?? TABLE_DEFAULTS.dataClass).toUpperCase();
  if (!/^(APPL[0-2]|USER\d?)$/.test(dataClass)) {
    throw new DdifError(`dataClass is APPL0, APPL1, APPL2 or a USER class, not '${spec.dataClass}'.`);
  }
  const sizeCategory = wholeNumber(spec.sizeCategory ?? TABLE_DEFAULTS.sizeCategory, 'sizeCategory', 0, 9);
  const literal = charLiteral(name);

  const correction = correctionStep({
    objectType: 'TABL',
    name,
    packageName: spec.packageName,
    request: spec.request,
    mode: 'I'
  });

  const code = [
    ...DDIF_DECLARATIONS,
    ...TABLE_DECLARATIONS,
    ...ddifLanguageLines(spec.language),
    ...stepLines(correction),
    ...correctionInfoLines(),
    `ls_dd02v-tabname = ${literal}.`,
    'ls_dd02v-ddlanguage = lv_langu.',
    "ls_dd02v-tabclass = 'TRANSP'.",
    `ls_dd02v-ddtext = ${textLiteral(spec.description, 'description', DESCRIPTION_LENGTH)}.`,
    `ls_dd02v-contflag = ${charLiteral(deliveryClass)}.`,
    `ls_dd02v-mainflag = ${charLiteral(mainflag)}.`,
    `ls_dd02v-clidep = ${clientDependent ? "'X'" : "' '"}.`,
    `ls_dd02v-exclass = ${charLiteral(exclass)}.`,
    `ls_dd09v-tabname = ${literal}.`,
    `ls_dd09v-tabkat = '${sizeCategory}'.`,
    `ls_dd09v-tabart = ${charLiteral(dataClass)}.`,
    `ls_dd09v-bufallow = ${charLiteral(bufallow)}.`,
    ...fields.flatMap(field => newFieldLines(name, field, 'lt_dd03p')),
    ...renumberLines('lt_dd03p'),
    ...stepLines(putStep(name, 'lt_dd03p', false)),
    ...(spec.activate === false
      ? []
      : [...stepLines(activateStep(name)), ...columnProbeLines(name, fields.map(field => field.name))])
  ];
  return { code, exceptions: exceptionMap(), fields };
}

// ---------------------------------------------------------------------------
// Changing the field list of an existing table.
// ---------------------------------------------------------------------------

/** A field of the active version, as DD03L holds it. */
export interface CurrentField {
  name: string;
  key: boolean;
  dataElement: string;
}

export interface FieldAddition {
  name: string;
  dataElement: string;
  key?: boolean;
  /** Put it right after this field. */
  after?: string;
  /** Put it right after the last key field. */
  afterKey?: boolean;
}

export interface FieldChange {
  add?: FieldAddition[];
  remove?: string[];
}

export interface PlannedField {
  name: string;
  key: boolean;
  dataElement: string;
  origin: 'kept' | 'added';
}

export interface TableContext {
  /** Fields a foreign key of this table is defined on. */
  foreignKeyFields: Set<string>;
  /** Fields that are part of a secondary index. */
  indexFields: Set<string>;
  /** Fields with a search help assigned. */
  searchHelpFields: Set<string>;
  /** Tables that use this one as a check table. */
  checkTableOf: string[];
}

export interface FieldPlan {
  fields: PlannedField[];
  added: string[];
  removed: string[];
  /** The change can only be made while the table holds no rows at all. */
  requiresEmpty: boolean;
  /** Why it requires that, one line per reason. */
  emptyBecause: string[];
}

/**
 * The new field list, or a refusal that says why.
 *
 * Refused outright: tables with includes or appends (their fields are not the
 * table's own to reorder), removing the client field or a field something
 * else depends on (a foreign key, an index, a search help). Allowed only on an
 * empty table, which the write checks again across all clients: removing a
 * field, and adding a key field.
 */
export function planFieldChange(current: CurrentField[], change: FieldChange, context: TableContext): FieldPlan {
  if (!current.length) throw new DdifError('The table has no active fields to change.');
  const structural = current.find(field => field.name.startsWith('.'));
  if (structural) {
    throw new DdifError(
      `The table has an ${structural.name} - its fields belong to the included structure. Change it in SE11.`
    );
  }
  const additions = Array.isArray(change.add) ? change.add : [];
  const removals = Array.isArray(change.remove) ? change.remove : [];
  if (!additions.length && !removals.length) throw new DdifError('Pass add or remove - there is nothing to change.');

  const emptyBecause: string[] = [];
  let fields: PlannedField[] = current.map(field => ({ ...field, origin: 'kept' as const }));
  const clientField = current[0]?.name === 'MANDT' && current[0].key ? 'MANDT' : undefined;

  const removed = removals.map(value => fieldName(value));
  for (const name of removed) {
    const field = fields.find(candidate => candidate.name === name);
    if (!field) throw new DdifError(`The table has no field ${name} to remove.`);
    if (name === clientField) throw new DdifError('The client field MANDT cannot be removed.');
    const uses = [
      context.foreignKeyFields.has(name) ? 'a foreign key' : '',
      context.indexFields.has(name) ? 'a secondary index' : '',
      context.searchHelpFields.has(name) ? 'a search help assignment' : ''
    ].filter(Boolean);
    if (uses.length) {
      throw new DdifError(`${name} is used by ${uses.join(' and ')}. Remove that first in SE11; this tool does not cut it silently.`);
    }
    if (field.key && context.checkTableOf.length) {
      throw new DdifError(
        `${name} is a key field, and ${context.checkTableOf.join(', ')} use this table as a check table - their foreign keys would break.`
      );
    }
    emptyBecause.push(`removing ${name}`);
    fields = fields.filter(candidate => candidate.name !== name);
  }

  const added: string[] = [];
  for (const addition of additions) {
    if (!addition || typeof addition !== 'object') throw new DdifError('Each entry of add is {name, dataElement, key, after, afterKey}.');
    const name = fieldName(addition.name);
    if (fields.some(field => field.name === name) || removed.includes(name)) {
      throw new DdifError(`The table already has a field ${name}.`);
    }
    const planned: PlannedField = {
      name,
      dataElement: dataElementName(addition.dataElement),
      key: addition.key === true,
      origin: 'added'
    };
    const lastKey = fields.reduce((last, field, index) => (field.key ? index : last), -1);
    let at: number;
    if (addition.after) {
      const anchor = fieldName(addition.after);
      const index = fields.findIndex(field => field.name === anchor);
      if (index < 0) throw new DdifError(`after names ${anchor}, which is not a field of the table.`);
      at = index + 1;
    } else if (addition.afterKey === true) {
      at = lastKey + 1;
    } else {
      at = planned.key ? lastKey + 1 : fields.length;
    }
    if (planned.key && at > lastKey + 1) {
      throw new DdifError(`${name} is a key field, so it goes within the key - after a key field or with afterKey.`);
    }
    if (!planned.key && at <= lastKey) {
      throw new DdifError(`${name} is not a key field, so it cannot go between key fields.`);
    }
    if (planned.key) emptyBecause.push(`adding the key field ${name}`);
    fields.splice(at, 0, planned);
    added.push(name);
  }

  checkFieldList(fields);
  return { fields, added, removed, requiresEmpty: emptyBecause.length > 0, emptyBecause };
}

/**
 * The token a write has to bring back from its preview.
 *
 * It covers the active field list, the moment the active version was written
 * and the change itself - so a write goes through only if it is the change
 * that was previewed, on the table as it was previewed.
 */
export function previewToken(table: string, stamp: string, current: CurrentField[], change: FieldChange): string {
  const normal = {
    table,
    stamp,
    current: current.map(field => [field.name, field.key, field.dataElement]),
    add: (change.add || []).map(addition => [
      String(addition.name).toUpperCase(),
      String(addition.dataElement).toUpperCase(),
      addition.key === true,
      addition.after ? String(addition.after).toUpperCase() : '',
      addition.afterKey === true
    ]),
    remove: (change.remove || []).map(name => String(name).toUpperCase())
  };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 16);
}

/**
 * The expected field names as a string literal built over several lines -
 * a long table would otherwise pass the 255-character line limit.
 */
const expectedNamesLines = (names: string[]): string[] => {
  const pieces: string[] = [];
  let piece = '';
  for (const name of names) {
    if (piece.length + name.length + 1 > 150) {
      pieces.push(piece);
      piece = '';
    }
    piece += `${name},`;
  }
  if (piece) pieces.push(piece);
  return pieces.map((text, index) =>
    (index === 0 ? 'lv_expected = ' : '  && ') + '`' + text + '`' + (index === pieces.length - 1 ? '.' : ''));
};

export interface ChangeTableSpec {
  name: string;
  packageName: string;
  request?: string;
  language?: string;
  /** The active field names in order, as the preview saw them. */
  expected: string[];
  plan: FieldPlan;
}

/**
 * The ABAP that changes the field list.
 *
 * Lock and register; read the whole definition; stop if it is not what the
 * preview saw; stop if the change needs an empty table and any client has a
 * row; write the new field list with everything else as read; activate; and if
 * the activation fails, write back what was read and activate that, so the
 * table is left as it was. Then prove the columns in the database.
 */
export function changeTableSnippet(spec: ChangeTableSpec): TableSnippet {
  const name = tableName(spec.name);
  const literal = charLiteral(name);
  const correction = correctionStep({
    objectType: 'TABL',
    name,
    packageName: spec.packageName,
    request: spec.request,
    mode: ' '
  });
  const get: StepSpec = {
    step: 'get',
    call: [
      "CALL FUNCTION 'DDIF_TABL_GET'",
      `  EXPORTING name = ${literal} state = 'A' langu = lv_langu`,
      '  IMPORTING dd02v_wa = ls_dd02v dd09l_wa = ls_dd09v',
      '  TABLES dd03p_tab = lt_old',
      '         dd05m_tab = lt_dd05m dd08v_tab = lt_dd08v',
      '         dd35v_tab = lt_dd35v dd36m_tab = lt_dd36m'
    ],
    exceptions: TABLE_GET_EXCEPTIONS
  };

  const failLine = (step: string, message: string): string =>
    `out->write( |STEP${DDIF_SEPARATOR}${step}${DDIF_SEPARATOR}4${DDIF_SEPARATOR}0${DDIF_SEPARATOR}` +
    `${DDIF_SEPARATOR}${DDIF_SEPARATOR}${message}| ).`;
  const okLine = (step: string): string =>
    `out->write( |STEP${DDIF_SEPARATOR}${step}${DDIF_SEPARATOR}0${DDIF_SEPARATOR}0${DDIF_SEPARATOR}` +
    `${DDIF_SEPARATOR}${DDIF_SEPARATOR}| ).`;

  const build = spec.plan.fields.flatMap(field =>
    field.origin === 'kept'
      ? [`APPEND lt_old[ fieldname = ${charLiteral(field.name)} ] TO lt_new.`]
      : newFieldLines(name, field, 'lt_new'));

  const code = [
    ...DDIF_DECLARATIONS,
    ...TABLE_DECLARATIONS,
    'DATA lt_old TYPE STANDARD TABLE OF dd03p WITH EMPTY KEY.',
    'DATA lt_new TYPE STANDARD TABLE OF dd03p WITH EMPTY KEY.',
    'DATA lt_dd05m TYPE STANDARD TABLE OF dd05m WITH EMPTY KEY.',
    'DATA lt_dd08v TYPE STANDARD TABLE OF dd08v WITH EMPTY KEY.',
    'DATA lt_dd35v TYPE STANDARD TABLE OF dd35v WITH EMPTY KEY.',
    'DATA lt_dd36m TYPE STANDARD TABLE OF dd36m WITH EMPTY KEY.',
    'DATA lv_expected TYPE string.',
    'DATA lv_names TYPE string.',
    ...ddifLanguageLines(spec.language),
    ...stepLines(correction),
    ...correctionInfoLines(),
    ...stepLines(get),
    // The definition the change is made on has to be the one the preview saw.
    'SORT lt_old BY position.',
    'LOOP AT lt_old INTO DATA(ls_old).',
    '  lv_names = |{ lv_names }{ ls_old-fieldname },|.',
    'ENDLOOP.',
    ...expectedNamesLines(spec.expected),
    "IF lv_names <> lv_expected OR ls_dd02v-tabclass <> 'TRANSP'.",
    `  ${failLine('compare', '{ ls_dd02v-tabclass }: { lv_names }')}`,
    '  RETURN.',
    'ENDIF.',
    okLine('compare'),
    ...rowCountLines(name),
    ...(spec.plan.requiresEmpty
      ? [
        'IF lv_rows <> 0.',
        `  ${failLine('rows', 'the table holds { lv_rows } rows across all clients')}`,
        '  RETURN.',
        'ENDIF.',
        okLine('rows')
      ]
      : []),
    ...build,
    ...renumberLines('lt_new'),
    ...stepLines(putStep(name, 'lt_new', true)),
    ...stepLines(activateStep(name, 'activate', true)),
    'IF lv_subrc <> 0 OR lv_rc > 4.',
    ...stepLines({ ...putStep(name, 'lt_old', true, 'rollback_put'), continueOnFailure: true }),
    ...stepLines(activateStep(name, 'rollback_activate', true)),
    '  RETURN.',
    'ENDIF.',
    ...columnProbeLines(name, [...spec.plan.added, ...spec.plan.removed])
  ];
  return { code, exceptions: exceptionMap() };
}

/** The COLUMN lines of a run: which columns the database has. */
export function parseColumns(output: string): Record<string, { present: boolean; message?: string }> {
  const columns: Record<string, { present: boolean; message?: string }> = {};
  const separator = DDIF_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^COLUMN${separator}([A-Z0-9_/]+)${separator}([01])${separator}(.*)$`);
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = pattern.exec(raw.replace(/\s+$/, ''));
    if (!match) continue;
    columns[match[1]] = { present: match[2] === '1', ...(match[3].trim() ? { message: match[3].trim() } : {}) };
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Reading the current state.
// ---------------------------------------------------------------------------

export const tableVersionsSql = (name: string): string =>
  `SELECT as4local, tabclass, as4date, as4time FROM dd02l WHERE tabname = '${tableName(name)}'`;

export const activeFieldsSql = (name: string): string =>
  `SELECT fieldname, position, keyflag, rollname FROM dd03l WHERE tabname = '${tableName(name)}' ` +
  "AND as4local = 'A' ORDER BY position";

export const appendsSql = (name: string): string =>
  `SELECT tabname FROM dd02l WHERE sqltab = '${tableName(name)}' AND tabclass = 'APPEND'`;

export const foreignKeyFieldsSql = (name: string): string =>
  `SELECT fieldname FROM dd08l WHERE tabname = '${tableName(name)}' AND as4local = 'A'`;

export const checkTableOfSql = (name: string): string =>
  `SELECT tabname FROM dd08l WHERE checktable = '${tableName(name)}' AND as4local = 'A'`;

export const indexFieldsSql = (name: string): string =>
  `SELECT fieldname FROM dd17s WHERE sqltab = '${tableName(name)}' AND as4local = 'A'`;

export const searchHelpFieldsSql = (name: string): string =>
  `SELECT fieldname FROM dd35l WHERE tabname = '${tableName(name)}' AND as4local = 'A'`;

export const technicalSettingsSql = (name: string): string =>
  `SELECT tabart, tabkat, bufallow FROM dd09l WHERE tabname = '${tableName(name)}' AND as4local = 'A'`;

export const activeDataElementsPrefix = "SELECT rollname FROM dd04l WHERE as4local = 'A' AND rollname IN (";
