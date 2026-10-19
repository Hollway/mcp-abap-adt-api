/**
 * An existing domain, read and changed without /sap/bc/adt/ddic/domains.
 *
 * createDomain already falls back to DDIF_DOMA_PUT on a release that serves no
 * domain endpoint. Changing a domain that exists was the gap: the one thing
 * left was a hand-written snippet calling RS_CORR_INSERT and DDIF_DOMA_PUT,
 * which is exactly what an automatic permission check reads as getting round a
 * missing tool - and it stopped a task that needed one fixed value added.
 *
 * Reading needs no ABAP at all: DD01L, DD01T, DD07L and DD07T hold the whole
 * definition, and TADIR the package and master language. Writing follows the
 * table change in lib/tableDdif: register, read the definition with
 * DDIF_DOMA_GET, stop if it is not what the preview saw, change only the
 * fields asked for on top of what was read (so nothing this module does not
 * model is blanked), write, activate - and if the activation fails, write
 * back what was read and activate that.
 *
 * The texts of fixed values are kept per position in DD07T, one row per
 * language. DDIF_DOMA_PUT numbers the values 1..n again on every write and
 * moves the texts in the other languages along with their value (measured on
 * the ERP system, 2026-10-19: with value 2 of 1-2-3-4 removed, the English
 * text of 4 went from position 4 to 3). So a kept value is handed over with
 * the position it was read under, a new one after the last, and the answer
 * speaks of the positions the values end up at.
 */
import { createHash } from 'crypto';
import { charLiteral, stringLiteral } from './textPool';
import {
  DDIF_DECLARATIONS,
  DdifError,
  correctionInfoLines,
  correctionStep,
  ddicObjectName,
  flagLiteral,
  ownStepLine,
  stepLines,
  textLiteral,
  wholeNumber
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';
import {
  DOMAIN_ACTIVATE_EXCEPTIONS,
  DOMAIN_PUT_EXCEPTIONS,
  FIX_VALUE_LENGTH,
  TEXT_LENGTH,
  domainDataType
} from './domainDdif';
import type { DomainFixValuePatch, DomainPatch, DomainState } from './ddicProperties';

export type Row = Record<string, any>;

/** DD01L-AS4LOCAL: the active version, or the one being edited. */
export type DomainVersion = 'A' | 'N';

const domainName = (name: string): string => ddicObjectName(name, 'domain');

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/** Every version of the header. The longest name keeps this under 255 characters. */
export const domainVersionsSql = (name: string): string =>
  'SELECT as4local, datatype, leng, outputlen, decimals, lowercase, signflag, valexi, entitytab, convexit, ' +
  `ampmformat, outputstyle, as4date, as4time FROM dd01l WHERE domname = '${domainName(name)}'`;

export const domainTextsSql = (name: string, version: DomainVersion): string =>
  `SELECT ddlanguage, ddtext FROM dd01t WHERE domname = '${domainName(name)}' AND as4local = '${version}'`;

export const fixValuesSql = (name: string, version: DomainVersion): string =>
  `SELECT valpos, domvalue_l, domvalue_h FROM dd07l WHERE domname = '${domainName(name)}' AND as4local = '${version}' ORDER BY valpos`;

export const fixValueTextsSql = (name: string, version: DomainVersion): string =>
  `SELECT valpos, ddlanguage, ddtext FROM dd07t WHERE domname = '${domainName(name)}' AND as4local = '${version}'`;

export const domainDirectorySql = (name: string): string =>
  `SELECT devclass, author, masterlang, srcsystem FROM tadir WHERE pgmid = 'R3TR' AND object = 'DOMA' AND obj_name = '${domainName(name)}'`;

/** The one-character language key of an ISO code. */
export const languageOfIsoSql = (iso: string): string => {
  const code = String(iso ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(code)) throw new DdifError(`'${iso}' is not a language: pass the SAP key (R) or the ISO code (RU).`);
  return `SELECT spras FROM t002 WHERE laiso = '${code}'`;
};

/** What the tables hold for one version of the domain. */
export interface DomainTables {
  header: Row;
  texts: Row[];
  values: Row[];
  valueTexts: Row[];
  directory?: Row;
}

/** A fixed value with its texts in every language there is one in. */
export interface FixValueRow {
  position: number;
  low: string;
  high: string;
  texts: Record<string, string>;
}

const text = (value: unknown): string => String(value ?? '').trim();
const flag = (value: unknown): boolean => text(value) === 'X';
/** NUMC comes back from the query endpoint as a number, or as digits, or not at all when it is zero. */
const num = (value: unknown): number => {
  const number = Number(text(value) || 0);
  return Number.isFinite(number) ? number : 0;
};

/** The fixed values in position order, each with its texts by language. */
export function fixValueRows(values: Row[], valueTexts: Row[]): FixValueRow[] {
  const texts = new Map<number, Record<string, string>>();
  for (const row of valueTexts) {
    const position = num(row.VALPOS);
    const byLanguage = texts.get(position) || {};
    byLanguage[text(row.DDLANGUAGE)] = text(row.DDTEXT);
    texts.set(position, byLanguage);
  }
  return values
    .map(row => ({
      position: num(row.VALPOS),
      low: text(row.DOMVALUE_L),
      high: text(row.DOMVALUE_H),
      texts: texts.get(num(row.VALPOS)) || {}
    }))
    .sort((a, b) => a.position - b.position);
}

/** Every language the domain or one of its values has a text in. */
export function textLanguages(tables: Pick<DomainTables, 'texts' | 'valueTexts'>): string[] {
  const all = [...tables.texts, ...tables.valueTexts].map(row => text(row.DDLANGUAGE)).filter(Boolean);
  return [...new Set(all)].sort();
}

/**
 * The tables, in the shape getDomainProperties answers with over ADT - so a
 * caller reads the same fields whichever way the domain was read. Languages
 * are the one-character SAP keys the tables hold.
 */
export function domainStateFromTables(tables: DomainTables, language: string): { state: DomainState; fixValues: FixValueRow[] } {
  const { header, directory } = tables;
  const description = tables.texts.find(row => text(row.DDLANGUAGE) === language);
  const fixValues = fixValueRows(tables.values, tables.valueTexts);
  const style = num(header.OUTPUTSTYLE);
  return {
    fixValues,
    state: {
      metaData: {
        name: '',
        description: text(description?.DDTEXT),
        language,
        masterLanguage: text(directory?.MASTERLANG),
        masterSystem: text(directory?.SRCSYSTEM),
        responsible: text(directory?.AUTHOR),
        packageName: text(directory?.DEVCLASS)
      },
      properties: {
        typeInformation: {
          datatype: text(header.DATATYPE),
          length: num(header.LENG),
          decimals: num(header.DECIMALS)
        },
        outputInformation: {
          length: num(header.OUTPUTLEN),
          ...(style ? { style: String(style).padStart(2, '0') } : {}),
          ...(text(header.CONVEXIT) ? { conversionExit: text(header.CONVEXIT) } : {}),
          signExists: flag(header.SIGNFLAG),
          lowercase: flag(header.LOWERCASE),
          ampmFormat: flag(header.AMPMFORMAT)
        },
        valueInformation: {
          valueTableRef: text(header.ENTITYTAB),
          appendExists: false,
          fixValues: fixValues.map(value => ({
            low: value.low,
            ...(value.high ? { high: value.high } : {}),
            text: value.texts[language] ?? ''
          }))
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Planning the change.
// ---------------------------------------------------------------------------

export interface PlannedFixValue {
  /** Where the value ends up: DDIF_DOMA_PUT numbers the list 1..n. */
  position: number;
  /** The VALPOS the snippet hands over - the one it was read under, or one after the last. */
  valpos: number;
  low: string;
  high: string;
  text: string;
  /** A value the domain has now keeps its row; only its text may change. */
  origin: 'kept' | 'added';
  retexted?: boolean;
}

export interface DomainChangePlan {
  /** DD01V field -> what it is and what it becomes, for the preview. */
  header: Record<string, { from: string; to: string }>;
  /** The ABAP that puts the header changes onto ls_dd01v. */
  assignments: string[];
  /** The whole new list, or undefined when the values stay as they are. */
  fixValues?: PlannedFixValue[];
  added: string[];
  removed: string[];
  retexted: string[];
  changed: boolean;
}

export interface CurrentDomain {
  header: Row;
  /** The short text in the language the change is made in. */
  description: string;
  fixValues: FixValueRow[];
}

/**
 * A header field as the plan compares it, from a DD01L row and the short text:
 * numbers without their leading zeros, flags as X or blank. The same function
 * reads the "from" of the preview and the proof after the write.
 */
export function headerValue(field: string, header: Row, description: string): string {
  const column = header[field.toUpperCase()];
  switch (field) {
    case 'ddtext': return description;
    case 'leng':
    case 'decimals':
    case 'outputlen': return String(num(column));
    case 'outputstyle': return String(num(column)).padStart(2, '0');
    case 'lowercase':
    case 'signflag':
    case 'ampmformat':
    case 'valexi': return flag(column) ? 'X' : '';
    default: return text(column);
  }
}

const valueKey = (low: string, high: string): string => `${low}\u0000${high}`;
const valueLabel = (low: string, high: string): string => (high ? `${low}..${high}` : low || "' '");

/**
 * What the patch changes, against what the domain holds now.
 *
 * Only the fields the caller passed are written, and only where they differ.
 * A new length takes the output length along when the two were equal - that
 * is what "output length defaults to the field length" means to a caller who
 * said nothing about it. fixValues is the whole new list, as on the ADT path;
 * a value that exists keeps its place in the order and, given without a text,
 * its text; a new value goes after the last.
 */
export function planDomainChange(current: CurrentDomain, patch: DomainPatch, language: string): DomainChangePlan {
  const header: DomainChangePlan['header'] = {};
  const assignments: string[] = [];
  const set = (field: string, to: string, literal: string) => {
    const from = headerValue(field, current.header, current.description);
    if (from === to) return;
    header[field] = { from, to };
    assignments.push(`ls_dd01v-${field} = ${literal}.`);
  };
  const h = current.header;

  if (patch.description !== undefined) {
    const value = String(patch.description);
    set('ddtext', value, textLiteral(value, 'description', TEXT_LENGTH));
  }
  if (patch.datatype !== undefined) {
    const value = domainDataType(patch.datatype);
    set('datatype', value, charLiteral(value));
  }
  const length = patch.length === undefined ? undefined : wholeNumber(patch.length, 'length', 1, 999999);
  if (length !== undefined) set('leng', String(length), String(length));
  if (patch.decimals !== undefined) {
    const value = wholeNumber(patch.decimals, 'decimals', 0, 999999);
    set('decimals', String(value), String(value));
  }
  const outputLength = patch.outputLength !== undefined
    ? wholeNumber(patch.outputLength, 'outputLength', 1, 999999)
    : length !== undefined && num(h.OUTPUTLEN) === num(h.LENG) ? length : undefined;
  if (outputLength !== undefined) set('outputlen', String(outputLength), String(outputLength));

  const flagField = (field: string, value: boolean | undefined) => {
    if (value === undefined) return;
    set(field, value === true ? 'X' : '', flagLiteral(value));
  };
  flagField('lowercase', patch.lowercase);
  flagField('signflag', patch.signExists);
  flagField('ampmformat', patch.ampmFormat);

  if (patch.conversionExit !== undefined) {
    const exit = String(patch.conversionExit).trim().toUpperCase();
    if (exit && !/^[A-Z0-9_]{1,5}$/.test(exit)) throw new DdifError(`'${patch.conversionExit}' is not a conversion exit, e.g. ALPHA.`);
    set('convexit', exit, charLiteral(exit));
  }
  if (patch.style !== undefined) {
    const style = String(patch.style).trim();
    if (!/^\d{1,2}$/.test(style)) throw new DdifError(`style is the two-digit output style, not '${patch.style}'.`);
    const padded = style.padStart(2, '0');
    set('outputstyle', padded, charLiteral(padded));
  }
  if (patch.valueTable !== undefined) {
    const table = String(patch.valueTable).trim() ? ddicObjectName(patch.valueTable, 'value table') : '';
    set('entitytab', table, charLiteral(table));
  }

  const values = patch.fixValues === undefined ? undefined : planFixValues(current.fixValues, patch.fixValues, language);
  if (values) {
    const wanted = values.planned.length ? 'X' : '';
    set('valexi', wanted, flagLiteral(wanted === 'X'));
  }
  const valuesChanged = !!values && (values.added.length + values.removed.length + values.retexted.length > 0);
  return {
    header,
    assignments,
    ...(valuesChanged ? { fixValues: values!.planned } : {}),
    added: values?.added ?? [],
    removed: values?.removed ?? [],
    retexted: values?.retexted ?? [],
    changed: assignments.length > 0 || valuesChanged
  };
}

function planFixValues(
  current: FixValueRow[],
  wanted: DomainFixValuePatch[],
  language: string
): { planned: PlannedFixValue[]; added: string[]; removed: string[]; retexted: string[] } {
  if (!Array.isArray(wanted)) throw new DdifError('fixValues is a list of {low, high, text}.');
  const existing = new Map(current.map(value => [valueKey(value.low, value.high), value]));
  const seen = new Set<string>();
  let last = current.reduce((max, value) => Math.max(max, value.position), 0);
  const planned: PlannedFixValue[] = [];
  const added: string[] = [];
  const retexted: string[] = [];

  wanted.forEach((value, index) => {
    if (value?.low === undefined || value.low === null) throw new DdifError(`Fixed value ${index + 1} has no low value (pass "" for the blank value).`);
    const low = String(value.low).trim();
    const high = String(value.high ?? '').trim();
    textLiteral(low, `low value ${index + 1}`, FIX_VALUE_LENGTH);
    textLiteral(high, `high value ${index + 1}`, FIX_VALUE_LENGTH);
    const key = valueKey(low, high);
    if (seen.has(key)) throw new DdifError(`Fixed value ${valueLabel(low, high)} is in the list twice.`);
    seen.add(key);

    const hit = existing.get(key);
    if (hit) {
      const now = hit.texts[language] ?? '';
      const given = value.text === undefined ? now : String(value.text);
      textLiteral(given, `text of fixed value ${valueLabel(low, high)}`, TEXT_LENGTH);
      const changed = given !== now;
      if (changed) retexted.push(valueLabel(low, high));
      planned.push({ position: 0, valpos: hit.position, low, high, text: given, origin: 'kept', ...(changed ? { retexted: true } : {}) });
      return;
    }
    const given = String(value.text ?? '');
    textLiteral(given, `text of fixed value ${valueLabel(low, high)}`, TEXT_LENGTH);
    last += 1;
    if (last > 9999) throw new DdifError('A domain holds at most 9999 fixed value positions.');
    planned.push({ position: 0, valpos: last, low, high, text: given, origin: 'added' });
    added.push(valueLabel(low, high));
  });

  const removed = current
    .filter(value => !seen.has(valueKey(value.low, value.high)))
    .map(value => valueLabel(value.low, value.high));
  planned.sort((a, b) => a.valpos - b.valpos);
  planned.forEach((value, index) => { value.position = index + 1; });
  return { planned, added, removed, retexted };
}

/** The fixed values as the snippet prints them from DDIF_DOMA_GET: "0001:low:high," each. */
export const fixValuesFingerprint = (values: { position: number; low: string; high: string }[]): string =>
  values.map(value => `${String(value.position).padStart(4, '0')}:${value.low}:${value.high},`).join('');

/**
 * The token a write has to bring back from its preview: the domain as it was
 * read (header, the moment it was last activated, every value and text) and
 * the change itself, in the language it is made in.
 */
export function domainPreviewToken(
  name: string,
  language: string,
  stamp: string,
  current: CurrentDomain,
  plan: DomainChangePlan
): string {
  const normal = {
    name,
    language,
    stamp,
    header: Object.keys(current.header).sort().map(key => [key, text(current.header[key])]),
    values: current.fixValues.map(value => [value.position, value.low, value.high, Object.entries(value.texts).sort()]),
    assignments: plan.assignments,
    planned: (plan.fixValues || []).map(value => [value.valpos, value.low, value.high, value.text])
  };
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The snippet.
// ---------------------------------------------------------------------------

export const DOMAIN_GET_EXCEPTIONS = ['ILLEGAL_INPUT'];

export interface DomainChangeSpec {
  name: string;
  packageName: string;
  request?: string;
  /** One-character SAP key: the texts are read and written in it. */
  language: string;
  /** fixValuesFingerprint of the values the preview saw. */
  expected: string;
  plan: DomainChangePlan;
  activate: boolean;
}

/** A long string literal over several lines: a line past 255 characters and the class is not written. */
const longStringLines = (variable: string, value: string): string[] => {
  if (!value) return [`${variable} = \`\`.`];
  const pieces: string[] = [];
  for (let at = 0; at < value.length; at += 120) pieces.push(value.slice(at, at + 120));
  return pieces.map((piece, index) =>
    (index === 0 ? `${variable} = ` : '  && ') + stringLiteral(piece) + (index === pieces.length - 1 ? '.' : ''));
};

/** The lines that build the new value list: kept rows as DDIF_DOMA_GET read them, new rows from scratch. */
const valueLines = (literal: string, values: PlannedFixValue[]): string[] => {
  const lines = ['CLEAR lt_dd07v.'];
  for (const value of values) {
    const position = charLiteral(String(value.valpos).padStart(4, '0'));
    if (value.origin === 'kept') {
      lines.push(`APPEND lt_old[ valpos = ${position} ] TO lt_dd07v.`);
      if (value.retexted) {
        lines.push(`lt_dd07v[ valpos = ${position} ]-ddlanguage = lv_langu.`);
        lines.push(`lt_dd07v[ valpos = ${position} ]-ddtext = ${charLiteral(value.text)}.`);
      }
      continue;
    }
    lines.push(
      `APPEND VALUE #( domname = ${literal} valpos = ${position} ddlanguage = lv_langu`,
      `  domvalue_l = ${charLiteral(value.low)} domvalue_h = ${charLiteral(value.high)}`,
      `  ddtext = ${charLiteral(value.text)} ) TO lt_dd07v.`
    );
  }
  return lines;
};

/**
 * Register; read the definition; stop if the values are not the ones the
 * preview saw; put the change on top of what was read; write; activate, and
 * put back what was read if the activation fails.
 */
export function domainChangeSnippet(spec: DomainChangeSpec): { code: string[]; exceptions: Record<string, string[]> } {
  const name = domainName(spec.name);
  const literal = charLiteral(name);
  if (!/^[A-Z0-9]$/.test(spec.language)) throw new DdifError(`'${spec.language}' is not a one-character language key.`);

  const correction = correctionStep({
    objectType: 'DOMA',
    name,
    packageName: spec.packageName,
    request: spec.request,
    mode: ' '
  });
  const get: StepSpec = {
    step: 'get',
    call: [
      "CALL FUNCTION 'DDIF_DOMA_GET'",
      `  EXPORTING name = ${literal} state = 'A' langu = lv_langu`,
      '  IMPORTING gotstate = lv_state dd01v_wa = ls_old',
      '  TABLES dd07v_tab = lt_old'
    ],
    exceptions: DOMAIN_GET_EXCEPTIONS
  };
  const put = (step: string, header: string, values: string): StepSpec => ({
    step,
    call: [
      "CALL FUNCTION 'DDIF_DOMA_PUT'",
      `  EXPORTING name = ${literal} dd01v_wa = ${header}`,
      `  TABLES dd07v_tab = ${values}`
    ],
    exceptions: DOMAIN_PUT_EXCEPTIONS
  });
  const activate = (step: string): StepSpec => ({
    step,
    call: [
      "CALL FUNCTION 'DDIF_DOMA_ACTIVATE'",
      `  EXPORTING name = ${literal}`,
      '  IMPORTING rc = lv_rc'
    ],
    exceptions: DOMAIN_ACTIVATE_EXCEPTIONS,
    rc: true,
    continueOnFailure: true
  });

  const code = [
    ...DDIF_DECLARATIONS,
    'DATA ls_dd01v TYPE dd01v.',
    'DATA ls_old TYPE dd01v.',
    'DATA lt_dd07v TYPE STANDARD TABLE OF dd07v WITH EMPTY KEY.',
    'DATA lt_old TYPE STANDARD TABLE OF dd07v WITH EMPTY KEY.',
    'DATA lv_state TYPE ddgotstate.',
    'DATA lv_values TYPE string.',
    'DATA lv_expected TYPE string.',
    `lv_langu = ${charLiteral(spec.language)}.`,
    ...stepLines(correction),
    ...correctionInfoLines(),
    ...stepLines(get),
    'SORT lt_old BY valpos.',
    'LOOP AT lt_old INTO DATA(ls_value).',
    '  lv_values = |{ lv_values }{ ls_value-valpos }:{ ls_value-domvalue_l }:{ ls_value-domvalue_h },|.',
    'ENDLOOP.',
    ...longStringLines('lv_expected', spec.expected),
    "IF lv_state <> 'A' OR lv_values <> lv_expected.",
    `  ${ownStepLine('compare', false, 'state { lv_state }, values { lv_values }')}`,
    '  RETURN.',
    'ENDIF.',
    ownStepLine('compare', true),
    'ls_dd01v = ls_old.',
    'lt_dd07v = lt_old.',
    'ls_dd01v-ddlanguage = lv_langu.',
    ...spec.plan.assignments,
    ...(spec.plan.fixValues ? valueLines(literal, spec.plan.fixValues) : []),
    ...stepLines(put('put', 'ls_dd01v', 'lt_dd07v')),
    ...(spec.activate
      ? [
        ...stepLines(activate('activate')),
        'IF lv_subrc <> 0 OR lv_rc > 4.',
        ...stepLines({ ...put('rollback_put', 'ls_old', 'lt_old'), continueOnFailure: true }),
        ...stepLines(activate('rollback_activate')),
        '  RETURN.',
        'ENDIF.'
      ]
      : [])
  ];
  return {
    code,
    exceptions: {
      transport: correction.exceptions || [],
      get: DOMAIN_GET_EXCEPTIONS,
      put: DOMAIN_PUT_EXCEPTIONS,
      activate: DOMAIN_ACTIVATE_EXCEPTIONS,
      rollback_put: DOMAIN_PUT_EXCEPTIONS,
      rollback_activate: DOMAIN_ACTIVATE_EXCEPTIONS
    }
  };
}
