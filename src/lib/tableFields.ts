/**
 * The fields of a table or structure, as the dictionary knows them.
 *
 * getStructureSource answers with the DDL text and the field list parsed out
 * of it, which is the definition rather than the thing: the type of a field is
 * the name of its data element and nothing more, so "what is in this field,
 * how long is it, what does it mean" took one ddicElement call per field. And
 * an .INCLUDE stays a line of text - the fields it brings are simply not in
 * the list, which for EKPO is most of them.
 *
 * The dictionary tables have all of it, so this reads them:
 *
 *   DD02L/DD02T  the table itself: class, delivery class, maintenance, text
 *   DD03L        its fields, with the include markers among them
 *   DD04T        what a data element is called, in every language it has
 *   DD01L        the domain: type, length, decimals, check table
 *   DD12L/DD17S  the indexes and the fields in them
 *   DD08L/DD05S  the foreign keys and the fields they join on
 *
 * Reading only, and nothing here executes ABAP - which is the point: the
 * dictionary is most often asked about on the systems where nothing may run.
 */

export class TableFieldsError extends Error {}

/** A name is checked rather than escaped, because it goes into SQL. */
const DDIC_NAME = /^[A-Za-z_/][A-Za-z0-9_/]*$/;

export function ddicName(name: string, what = 'table name'): string {
  const text = String(name ?? '').trim().toUpperCase();
  if (!DDIC_NAME.test(text) || text.length > 30) {
    throw new TableFieldsError(`"${name}" is not a valid ${what}.`);
  }
  return text;
}

const list = (names: string[]): string =>
  names.map(name => `'${ddicName(name)}'`).join(',');

/**
 * How long a statement the data preview endpoint accepts.
 *
 * It refuses anything longer with "maximum number of characters in the line
 * exceeds 255", and it counts the whole statement: breaking it into lines does
 * not help, because a newline is not even accepted as whitespace there - the
 * parser reads "dd03l
WHERE" as a table name. So every query below is one
 * short line, ORDER BY is left out where the sorting can be done after the
 * fact, and a name list is cut to fit rather than to a count.
 *
 * Two characters of that budget cannot be saved: the comparisons need spaces
 * around the equals sign. Written tight, tabname='EKPO' is refused with "a
 * Boolean expression is required in positions starting with TABNAME=". The
 * commas of a select list are fine without them.
 */
export const SQL_LIMIT = 255;

export const headerQuery = (name: string): string =>
  `SELECT tabname,tabclass,contflag,mainflag FROM dd02l WHERE tabname = '${ddicName(name)}' AND as4local = 'A'`;

export const headerTextQuery = (name: string): string =>
  `SELECT ddlanguage,ddtext FROM dd02t WHERE tabname = '${ddicName(name)}' AND as4local = 'A'`;

/**
 * The fields of several structures at once: expanding an include means asking
 * for the next level, and one query per level beats one per structure.
 */
export const fieldsQuery = (names: string[]): string =>
  'SELECT tabname,fieldname,position,keyflag,rollname,domname,datatype,leng,decimals,notnull,' +
  `checktable,reftable,reffield,precfield FROM dd03l WHERE tabname IN (${list(names)}) AND as4local = 'A'`;

/**
 * Texts of the data elements, in every language they have.
 *
 * The language is not filtered in SQL on purpose: DD04T keys on the one
 * character SAP code, the connection carries the two character ISO one, and
 * the mapping between them is not something to guess inside a query. Picking
 * the row here costs a few more rows and cannot be wrong.
 */
export const textsQuery = (elements: string[]): string =>
  `SELECT rollname,ddlanguage,ddtext,scrtext_l FROM dd04t WHERE rollname IN (${list(elements)})`;

/**
 * What the domain adds: the conversion exit, which decides how a value has to
 * be written. The value table is deliberately not read - it is not the check
 * table of the field, and reporting it as one would be wrong.
 */
export const domainsQuery = (domains: string[]): string =>
  `SELECT domname,convexit FROM dd01l WHERE domname IN (${list(domains)}) AND as4local = 'A'`;

export const indexesQuery = (name: string): string =>
  `SELECT indexname,dbindex,uniqueflag FROM dd12l WHERE sqltab = '${ddicName(name)}' AND as4local = 'A'`;

export const indexFieldsQuery = (name: string): string =>
  `SELECT indexname,position,fieldname FROM dd17s WHERE sqltab = '${ddicName(name)}' AND as4local = 'A'`;

/**
 * The foreign keys of a table.
 *
 * The cardinality is two columns and only one of them is called what it
 * sounds like: CARDLEFT and CARD, not CARDLEFT and CARDRIGHT - which is what
 * this asked for at first and got "unknown column CARDRIGHT" for.
 */
export const foreignKeysQuery = (name: string): string =>
  'SELECT fieldname,checktable,frkart,cardleft,card,checkflag,arbgb,msgnr FROM dd08l ' +
  `WHERE tabname = '${ddicName(name)}' AND as4local = 'A'`;

/**
 * The fields of a foreign key.
 *
 * DD05S names them its own way: PRIMPOS is the position in the KEY OF THE
 * CHECK TABLE, and FORTABLE/FORKEY the field of this table that fills it -
 * or FORSTRING, a constant, when it is not a field at all.
 */
export const foreignKeyFieldsQuery = (name: string): string =>
  'SELECT fieldname,primpos,fortable,forkey,forstring FROM dd05s ' +
  `WHERE tabname = '${ddicName(name)}' AND as4local = 'A'`;

/**
 * Names split into lists that keep their query under the limit.
 *
 * The query itself decides how many fit, because the fixed part differs per
 * query and a name can be 30 characters or three. A single name whose query
 * is over the limit is still sent: the backend refusal says what happened,
 * and dropping it silently would not.
 */
export function chunkForQuery(
  names: string[],
  build: (names: string[]) => string,
  limit = SQL_LIMIT
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const name of names) {
    if (current.length > 0 && build([...current, name]).length > limit) {
      chunks.push(current);
      current = [name];
    } else {
      current.push(name);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** A row of a runQuery answer, keyed by column name. */
export type Row = Record<string, unknown>;

const text = (row: Row, column: string): string => {
  const value = row[column];
  return value === undefined || value === null ? '' : String(value).trim();
};

const number = (row: Row, column: string): number => {
  const value = Number(row[column]);
  return Number.isFinite(value) ? value : 0;
};

export interface TableField {
  name: string;
  position: number;
  key?: boolean;
  notNull?: boolean;
  dataElement?: string;
  domain?: string;
  dataType?: string;
  length?: number;
  decimals?: number;
  /** Table the value is checked against. */
  checkTable?: string;
  /** Field holding the unit or the currency of this one, as TABLE-FIELD. */
  reference?: string;
  text?: string;
  /** Structure this field came in through, when it was not declared here. */
  fromInclude?: string;
  /** Conversion exit on the domain, which changes how the value is displayed. */
  conversionExit?: string;
}

/** An include marker rather than a field: what it brings and where. */
export interface IncludeMarker {
  position: number;
  structure: string;
  /** The .INCLU--AP style marker carries a suffix; kept as it reads. */
  marker: string;
}

const isMarker = (fieldname: string): boolean => fieldname.startsWith('.');

/** The includes of one structure, in the order they sit in it. */
export function includesOf(rows: Row[]): IncludeMarker[] {
  return rows
    .filter(row => isMarker(text(row, 'FIELDNAME')) && text(row, 'PRECFIELD') !== '')
    .map(row => ({
      position: number(row, 'POSITION'),
      structure: text(row, 'PRECFIELD').toUpperCase(),
      marker: text(row, 'FIELDNAME')
    }));
}

export interface FlattenOptions {
  /** Rows by structure name, as the queries answered them. */
  byStructure: Map<string, Row[]>;
  /** How deep an include chain may go before it is called a cycle. */
  maxDepth?: number;
}

/**
 * The fields of a structure with its includes spliced in where they sit.
 *
 * An include occupies one position in the structure that holds it, and the
 * fields it brings belong at that position - so the list is built by walking
 * the rows in order and stepping into a marker when it is reached. Positions
 * are renumbered, because the numbers the dictionary keeps are per structure
 * and would repeat.
 */
export function flattenFields(name: string, options: FlattenOptions): {
  fields: TableField[];
  includes: string[];
  missing: string[];
} {
  const maxDepth = options.maxDepth ?? 15;
  const fields: TableField[] = [];
  const includes: string[] = [];
  const missing: string[] = [];

  const walk = (structure: string, depth: number, path: string[], from?: string): void => {
    if (depth > maxDepth) {
      throw new TableFieldsError(
        `The includes of ${name} go more than ${maxDepth} deep (${path.join(' -> ')}), which reads as a cycle.`
      );
    }
    const rows = options.byStructure.get(structure);
    if (!rows) {
      missing.push(structure);
      return;
    }
    for (const row of rows) {
      const fieldname = text(row, 'FIELDNAME');
      if (isMarker(fieldname)) {
        const included = text(row, 'PRECFIELD').toUpperCase();
        if (!included) continue;
        if (path.includes(included)) {
          throw new TableFieldsError(
            `${included} includes itself through ${path.join(' -> ')}.`
          );
        }
        includes.push(included);
        walk(included, depth + 1, [...path, included], included);
        continue;
      }
      fields.push({
        name: fieldname.toUpperCase(),
        position: fields.length + 1,
        ...(text(row, 'KEYFLAG') === 'X' ? { key: true } : {}),
        ...(text(row, 'NOTNULL') === 'X' ? { notNull: true } : {}),
        ...(text(row, 'ROLLNAME') ? { dataElement: text(row, 'ROLLNAME') } : {}),
        ...(text(row, 'DOMNAME') ? { domain: text(row, 'DOMNAME') } : {}),
        ...(text(row, 'DATATYPE') ? { dataType: text(row, 'DATATYPE') } : {}),
        length: number(row, 'LENG'),
        ...(number(row, 'DECIMALS') > 0 ? { decimals: number(row, 'DECIMALS') } : {}),
        ...(text(row, 'CHECKTABLE') ? { checkTable: text(row, 'CHECKTABLE') } : {}),
        ...(text(row, 'REFTABLE') && text(row, 'REFFIELD')
          ? { reference: `${text(row, 'REFTABLE')}-${text(row, 'REFFIELD')}` }
          : {}),
        ...(from ? { fromInclude: from } : {})
      });
    }
  };

  walk(ddicName(name), 0, [ddicName(name)]);
  return { fields, includes: [...new Set(includes)], missing: [...new Set(missing)] };
}

/**
 * The SAP one character language code for a two character ISO one.
 *
 * Only the ones this is sure of are listed; for the rest - RU to R, EN to E,
 * DE to D - the first letter is the code, and a wrong guess costs nothing:
 * pickText falls back to English and then to whatever text there is. A code
 * guessed into a collision would be worse than that, which is why the
 * doubtful ones are left out rather than half remembered.
 */
const LANGUAGE_CODES: Record<string, string> = {
  ZH: '1', JA: 'J', SV: 'V', DA: 'K', FI: 'U', EL: 'G', HE: 'B',
  KO: '3', TH: '2', UK: '8', NO: 'O'
};

export const languageCode = (iso: string | undefined): string => {
  const code = String(iso || '').trim().toUpperCase();
  if (!code) return 'E';
  if (code.length === 1) return code;
  return LANGUAGE_CODES[code] || code[0];
};

/**
 * One text out of the rows a table of texts answered.
 *
 * The connection language first, English next, and then whatever there is: a
 * field with a text only in German still has a name worth reporting.
 */
export function pickText(rows: Row[], language: string): Row | undefined {
  if (rows.length === 0) return undefined;
  const wanted = languageCode(language);
  return rows.find(row => text(row, 'DDLANGUAGE').toUpperCase() === wanted)
    || rows.find(row => text(row, 'DDLANGUAGE').toUpperCase() === 'E')
    || rows[0];
}

/** Texts by data element, each in the best language available. */
export function textsByElement(rows: Row[], language: string): Map<string, string> {
  const byElement = new Map<string, Row[]>();
  for (const row of rows) {
    const element = text(row, 'ROLLNAME').toUpperCase();
    if (!element) continue;
    const list_ = byElement.get(element);
    if (list_) list_.push(row);
    else byElement.set(element, [row]);
  }

  const texts = new Map<string, string>();
  for (const [element, list_] of byElement) {
    const best = pickText(list_, language);
    const label = best
      ? text(best, 'DDTEXT') || text(best, 'SCRTEXT_L') || text(best, 'SCRTEXT_M')
      : '';
    if (label) texts.set(element, label);
  }
  return texts;
}

/** Rows of DD03L grouped by the structure they belong to. */
export function groupByStructure(rows: Row[]): Map<string, Row[]> {
  const byStructure = new Map<string, Row[]>();
  for (const row of rows) {
    const structure = text(row, 'TABNAME').toUpperCase();
    if (!structure) continue;
    const list_ = byStructure.get(structure);
    if (list_) list_.push(row);
    else byStructure.set(structure, [row]);
  }
  for (const list_ of byStructure.values()) {
    list_.sort((a, b) => number(a, 'POSITION') - number(b, 'POSITION'));
  }
  return byStructure;
}

/**
 * The conversion exit of each field domain.
 *
 * This is the one thing the domain has that the field row does not, and it
 * matters before writing a value: a MATNR without its ALPHA conversion is a
 * different material number.
 */
export function applyConversionExits(fields: TableField[], rows: Row[]): TableField[] {
  const exits = new Map<string, string>();
  for (const row of rows) {
    const domain = text(row, 'DOMNAME').toUpperCase();
    const exit = text(row, 'CONVEXIT');
    if (domain && exit) exits.set(domain, exit);
  }
  if (exits.size === 0) return fields;
  return fields.map(field => {
    const exit = field.domain ? exits.get(field.domain.toUpperCase()) : undefined;
    return exit ? { ...field, conversionExit: exit } : field;
  });
}

export interface IndexDescription {
  name: string;
  dbName?: string;
  unique?: boolean;
  fields: string[];
}

/** The indexes of a table, each with the fields it is built on, in order. */
export function shapeIndexes(indexes: Row[], indexFields: Row[]): IndexDescription[] {
  const fieldsByIndex = new Map<string, { position: number; field: string }[]>();
  for (const row of indexFields) {
    const index = text(row, 'INDEXNAME').toUpperCase();
    const entry = { position: number(row, 'POSITION'), field: text(row, 'FIELDNAME').toUpperCase() };
    const list_ = fieldsByIndex.get(index);
    if (list_) list_.push(entry);
    else fieldsByIndex.set(index, [entry]);
  }

  return indexes.map(row => {
    const name = text(row, 'INDEXNAME').toUpperCase();
    const fields = (fieldsByIndex.get(name) || [])
      .sort((a, b) => a.position - b.position)
      .map(entry => entry.field)
      .filter(field => !isMarker(field));
    return {
      name,
      ...(text(row, 'DBINDEX') ? { dbName: text(row, 'DBINDEX') } : {}),
      ...(text(row, 'UNIQUEFLAG') === 'X' ? { unique: true } : {}),
      fields
    };
  });
}

export interface ForeignKeyDescription {
  field: string;
  checkTable: string;
  /** Cardinality as the dictionary writes it, e.g. C:N. */
  cardinality?: string;
  /** What kind of relation it is: text table, hierarchy, and so on. */
  kind?: string;
  /** Whether the check is actually enforced on input. */
  checked: boolean;
  /** Message issued when the check fails, as class and number. */
  message?: string;
  /**
   * What fills the key of the check table, in its key order: the field of
   * this table at that position, or a constant where the definition uses one.
   */
  keyFields: string[];
}

/**
 * The foreign keys of a table, each with what fills the key of its check
 * table.
 *
 * DD05S is worth reading twice: PRIMPOS is the position in the key of the
 * CHECK table, and FORTABLE/FORKEY the field of this table that fills it. So
 * the list reads as the key of the check table, in order, and what goes into
 * each position - which is what a join needs.
 */
export function shapeForeignKeys(keys: Row[], keyFields: Row[]): ForeignKeyDescription[] {
  const byField = new Map<string, { position: number; source: string }[]>();
  for (const row of keyFields) {
    const field = text(row, 'FIELDNAME').toUpperCase();
    const table = text(row, 'FORTABLE').toUpperCase();
    const key = text(row, 'FORKEY').toUpperCase();
    const constant = text(row, 'FORSTRING');
    const source = key ? (table ? `${table}-${key}` : key) : constant ? `'${constant}'` : '';
    if (!source) continue;
    const entry = { position: number(row, 'PRIMPOS'), source };
    const list_ = byField.get(field);
    if (list_) list_.push(entry);
    else byField.set(field, [entry]);
  }

  return keys.map(row => {
    const field = text(row, 'FIELDNAME').toUpperCase();
    return {
      field,
      checkTable: text(row, 'CHECKTABLE').toUpperCase(),
      ...(text(row, 'CARDLEFT') || text(row, 'CARD')
        ? { cardinality: `${text(row, 'CARDLEFT') || '?'}:${text(row, 'CARD') || '?'}` }
        : {}),
      ...(text(row, 'FRKART') ? { kind: text(row, 'FRKART') } : {}),
      ...(text(row, 'ARBGB') && text(row, 'MSGNR')
        ? { message: `${text(row, 'ARBGB')} ${text(row, 'MSGNR')}` }
        : {}),
      // Always reported, both ways: a key that is declared and not enforced is
      // exactly the thing worth knowing, and an absent flag would read as
      // "not asked" rather than as "not checked".
      checked: text(row, 'CHECKFLAG') === 'X',
      keyFields: (byField.get(field) || [])
        .sort((a, b) => a.position - b.position)
        .map(entry => entry.source)
    };
  });
}

/** What the dictionary calls the kind of a table, in words. */
export const TABLE_CLASSES: Record<string, string> = {
  TRANSP: 'transparent table',
  INTTAB: 'structure',
  APPEND: 'append structure',
  CLUSTER: 'cluster table',
  POOL: 'pooled table',
  VIEW: 'database view',
  DDLS: 'CDS entity'
};

/** Delivery classes, which decide what a transport does with the contents. */
export const DELIVERY_CLASSES: Record<string, string> = {
  A: 'application table',
  C: 'customizing table',
  L: 'table for temporary data',
  G: 'customizing table, protected against SAP updates',
  E: 'control table, namespace separated',
  S: 'system table, changes are transported',
  W: 'system table, contents transported with its own objects'
};
