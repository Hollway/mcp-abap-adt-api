/**
 * A domain written through DDIF_DOMA_PUT, for the releases that serve no
 * /sap/bc/adt/ddic/domains at all.
 *
 * The order was measured on such a system: RS_CORR_INSERT (directory entry and
 * request), DDIF_DOMA_PUT (header and fixed values in one call), then
 * DDIF_DOMA_ACTIVATE. The arguments are the ones createDomain already takes, so
 * a caller does not have to know which way the domain was written.
 */
import { charLiteral } from './textPool';
import {
  DDIF_DECLARATIONS,
  DdifError,
  correctionInfoLines,
  correctionStep,
  ddicObjectName,
  ddifLanguageLines,
  flagLiteral,
  stepLines,
  textLiteral,
  wholeNumber
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';
import type { DomainPatch } from './ddicProperties';

export interface DomainDdifSpec extends DomainPatch {
  name: string;
  packageName: string;
  /** The request, already resolved from a task if one was given. */
  request?: string;
  language?: string;
  activate?: boolean;
}

/** DD01V-DOMVALUE_L and _H are CHAR 10, DD07V-DDTEXT CHAR 60. */
const FIX_VALUE_LENGTH = 10;
const TEXT_LENGTH = 60;

export const DOMAIN_PUT_EXCEPTIONS = ['DOMA_NOT_FOUND', 'NAME_INCONSISTENT', 'DOMA_INCONSISTENT', 'PUT_FAILURE', 'PUT_REFUSED'];
export const DOMAIN_ACTIVATE_EXCEPTIONS = ['NOT_FOUND', 'PUT_FAILURE'];

export interface DomainSnippet {
  code: string[];
  /** Exception names per step, for parseDdifPrint. */
  exceptions: Record<string, string[]>;
}

const dataType = (value: unknown): string => {
  const type = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(type)) {
    throw new DdifError(`'${value}' is not a dictionary data type, e.g. CHAR, NUMC, DEC, DATS.`);
  }
  return type;
};

/** The ABAP that creates, defines and (by default) activates the domain. */
export function domainDdifSnippet(spec: DomainDdifSpec): DomainSnippet {
  const name = ddicObjectName(spec.name, 'domain');
  const literal = charLiteral(name);
  const length = wholeNumber(spec.length, 'length', 1, 999999);
  const decimals = spec.decimals === undefined ? 0 : wholeNumber(spec.decimals, 'decimals', 0, 999999);
  const outputLength = spec.outputLength === undefined
    ? length
    : wholeNumber(spec.outputLength, 'outputLength', 1, 999999);

  const header = [
    `ls_dd01v-domname = ${literal}.`,
    'ls_dd01v-ddlanguage = lv_langu.',
    `ls_dd01v-datatype = ${charLiteral(dataType(spec.datatype))}.`,
    `ls_dd01v-leng = ${length}.`,
    `ls_dd01v-outputlen = ${outputLength}.`,
    `ls_dd01v-decimals = ${decimals}.`,
    `ls_dd01v-lowercase = ${flagLiteral(spec.lowercase)}.`,
    `ls_dd01v-signflag = ${flagLiteral(spec.signExists)}.`,
    `ls_dd01v-ampmformat = ${flagLiteral(spec.ampmFormat)}.`,
    `ls_dd01v-ddtext = ${textLiteral(spec.description, 'description', TEXT_LENGTH)}.`
  ];
  if (spec.conversionExit) {
    const exit = String(spec.conversionExit).trim().toUpperCase();
    if (!/^[A-Z0-9_]{1,5}$/.test(exit)) throw new DdifError(`'${spec.conversionExit}' is not a conversion exit, e.g. ALPHA.`);
    header.push(`ls_dd01v-convexit = ${charLiteral(exit)}.`);
  }
  if (spec.style) {
    const style = String(spec.style).trim();
    if (!/^\d{1,2}$/.test(style)) throw new DdifError(`style is the two-digit output style, not '${spec.style}'.`);
    header.push(`ls_dd01v-outputstyle = ${charLiteral(style.padStart(2, '0'))}.`);
  }
  if (spec.valueTable) {
    header.push(`ls_dd01v-entitytab = ${charLiteral(ddicObjectName(spec.valueTable, 'value table'))}.`);
  }

  const fixValues = spec.fixValues || [];
  if (!Array.isArray(fixValues)) throw new DdifError('fixValues is a list of {low, high, text}.');
  if (fixValues.length) header.push(`ls_dd01v-valexi = 'X'.`);
  const fixLines = fixValues.map((value, index) => {
    if (value?.low === undefined || value.low === null || String(value.low) === '') {
      throw new DdifError(`Fixed value ${index + 1} has no low value.`);
    }
    return 'APPEND VALUE #( ' +
      `domname = ${literal} valpos = '${String(index + 1).padStart(4, '0')}' ddlanguage = lv_langu ` +
      `domvalue_l = ${textLiteral(value.low, `low value ${index + 1}`, FIX_VALUE_LENGTH)} ` +
      (value.high ? `domvalue_h = ${textLiteral(value.high, `high value ${index + 1}`, FIX_VALUE_LENGTH)} ` : '') +
      `ddtext = ${textLiteral(value.text ?? '', `text of fixed value ${index + 1}`, TEXT_LENGTH)} ) TO lt_dd07v.`;
  });

  const correction = correctionStep({
    objectType: 'DOMA',
    name,
    packageName: spec.packageName,
    request: spec.request,
    mode: 'I'
  });
  const put: StepSpec = {
    step: 'put',
    call: [
      "CALL FUNCTION 'DDIF_DOMA_PUT'",
      `  EXPORTING name = ${literal} dd01v_wa = ls_dd01v`,
      '  TABLES dd07v_tab = lt_dd07v'
    ],
    exceptions: DOMAIN_PUT_EXCEPTIONS
  };
  const activate: StepSpec = {
    step: 'activate',
    call: [
      "CALL FUNCTION 'DDIF_DOMA_ACTIVATE'",
      `  EXPORTING name = ${literal}`,
      '  IMPORTING rc = lv_rc'
    ],
    exceptions: DOMAIN_ACTIVATE_EXCEPTIONS,
    rc: true
  };

  return {
    code: [
      ...DDIF_DECLARATIONS,
      'DATA ls_dd01v TYPE dd01v.',
      'DATA lt_dd07v TYPE STANDARD TABLE OF dd07v WITH EMPTY KEY.',
      ...ddifLanguageLines(spec.language),
      ...stepLines(correction),
      ...correctionInfoLines(),
      ...header,
      ...fixLines,
      ...stepLines(put),
      ...(spec.activate === false ? [] : stepLines(activate))
    ],
    exceptions: {
      transport: correction.exceptions || [],
      put: DOMAIN_PUT_EXCEPTIONS,
      activate: DOMAIN_ACTIVATE_EXCEPTIONS
    }
  };
}

/** What the system holds for the domain afterwards, as the proof. */
export const domainHeaderSql = (name: string): string =>
  `SELECT as4local, datatype, leng, decimals, valexi FROM dd01l WHERE domname = '${ddicObjectName(name, 'domain')}'`;
