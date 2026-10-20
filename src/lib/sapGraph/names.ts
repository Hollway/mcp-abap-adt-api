/**
 * Reading the names SAP's where-used index writes.
 *
 * WBCROSSGT and CROSS record a reference by the include it sits in, never by
 * the method or function module around it, and the target as a path:
 * ZCL_X\ME:METH, CX_ROOT\IN:IF_MESSAGE\ME:GET_LONGTEXT, ZCL_X\ME:M\DA:PARAM.
 * Everything here turns those into the object/member pairs a question is
 * asked in. Pure functions, so the rules can be pinned by tests without a
 * system.
 */

/** Object types a reference can come from. */
export type OwnerType = 'CLAS' | 'INTF' | 'FUGR' | 'PROG';

/**
 * What an include is part of.
 *
 * part: CM00A for a method include, CU/CO/CI for the sections of a class,
 * CCIMP and friends for its local classes, U01 or F01 for a function group
 * include, SAPL for the group main program; empty for a plain program.
 */
export interface IncludeOwner {
  object: string;
  objectType: OwnerType;
  part: string;
  /** TMDIR METHODINDX for a CMnnn include. */
  methodIndex?: number;
  /** TFDIR INCLUDE (two characters) for an Unn include of a function group. */
  functionInclude?: string;
}

/** Where in its owner a reference was written - what callers are usually after is 'method'. */
export type SourcePart = 'method' | 'definition' | 'local' | 'function' | 'functionGroup' | 'program';

const CLASS_SUFFIX = /^(CP|CU|CO|CI|CT|CS|IP|IU|CCDEF|CCIMP|CCMAC|CCAU|CM[0-9A-Z]{3})$/;
const DEFINITION_PARTS = new Set(['CP', 'CU', 'CO', 'CI', 'CT', 'CS', 'IP', 'IU']);

/**
 * CMnnn counts methods in base 36: CM009, CM00A, ..., CM00Z, CM010. TMDIR
 * holds the same number in decimal - CM00A is method 10.
 */
export const methodIndexOf = (code: string): number | undefined => {
  const value = parseInt(code, 36);
  return Number.isFinite(value) && /^[0-9A-Z]{3}$/.test(code) ? value : undefined;
};

/**
 * The owner of an include, from its name alone.
 *
 * A class pool include is the class name padded to 30 characters with '='
 * and a suffix (ZCL_X=========================CM001); a class whose name is
 * the full 30 characters has no padding at all. A function group include is
 * L<group><three characters>, its main program SAPL<group>. Everything else
 * is a program or a program include.
 *
 * customerPrefixes names the first letters of customer objects (Z, Y): only
 * those are read as function groups, so a program called LIST_USERS stays a
 * program.
 */
export function ownerOfInclude(include: string, customerPrefixes: readonly string[] = ['Z', 'Y']): IncludeOwner {
  const name = include.trim().toUpperCase();

  if (name.length > 30) {
    const suffix = name.slice(30);
    const head = name.slice(0, 30);
    if (CLASS_SUFFIX.test(suffix)) {
      const object = head.replace(/=+$/, '');
      if (object && !object.includes('=')) {
        const objectType: OwnerType = suffix === 'IP' || suffix === 'IU' ? 'INTF' : 'CLAS';
        const owner: IncludeOwner = { object, objectType, part: suffix };
        if (suffix.startsWith('CM')) owner.methodIndex = methodIndexOf(suffix.slice(2));
        return owner;
      }
    }
  }

  const startsCustomer = (rest: string) => customerPrefixes.some(prefix => rest.startsWith(prefix));
  if (name.startsWith('SAPL') && startsCustomer(name.slice(4))) {
    return { object: name.slice(4), objectType: 'FUGR', part: 'SAPL' };
  }
  if (name.startsWith('L') && name.length > 4 && startsCustomer(name.slice(1))) {
    const part = name.slice(-3);
    const owner: IncludeOwner = { object: name.slice(1, -3), objectType: 'FUGR', part };
    if (/^U\d\d$/.test(part)) owner.functionInclude = part.slice(1);
    return owner;
  }
  return { object: name, objectType: 'PROG', part: '' };
}

/** Which part of its owner an include is, in the words a caller filters by. */
export function sourcePartOf(owner: { objectType: string; part: string }): SourcePart {
  if (owner.objectType === 'FUGR') return /^U\d\d$/.test(owner.part) ? 'function' : 'functionGroup';
  if (owner.objectType !== 'CLAS' && owner.objectType !== 'INTF') return 'program';
  if (owner.part.startsWith('CM')) return 'method';
  if (DEFINITION_PARTS.has(owner.part)) return 'definition';
  return 'local';
}

/** A reference target: the object, and the member path inside it. */
export interface Target {
  object: string;
  member?: string;
}

/** What a WBCROSSGT name says, or why it is not a reference worth keeping. */
export interface ParsedGtName extends Target {
  /** The reference is to a parameter or local of a method, not to the object. */
  parameter?: boolean;
  /** The object is a program or function module named by \PR: or \FU: - its locals, not a global type. */
  local?: boolean;
}

/**
 * A WBCROSSGT name, as object and member.
 *
 * ZCL_X\ME:METH                          -> ZCL_X, METH
 * CX_ROOT\IN:IF_MESSAGE\ME:GET_LONGTEXT  -> CX_ROOT, IF_MESSAGE~GET_LONGTEXT
 * ZCL_X\TY:TT_ROWS                       -> ZCL_X, TT_ROWS
 * \PR:ZR_REPORT\CL:LCL_APP\ME:RUN        -> ZR_REPORT, LCL_APP=>RUN
 * ZCL_X\ME:METH\DA:IV_WERKS              -> a parameter of METH, flagged
 * ZS_ROW                                 -> ZS_ROW
 */
export function parseGtName(name: string): ParsedGtName {
  const segments = name.trim().toUpperCase().split('\\');
  const tagged = (segment: string) => {
    const match = /^([A-Z]{2}):(.*)$/.exec(segment);
    return match ? { tag: match[1], value: match[2] } : { tag: '', value: segment };
  };
  const parts = segments.filter((segment, index) => index > 0 || segment !== '').map(tagged);
  if (parts.length === 0) return { object: '' };

  const object = parts[0].value;
  let member = '';
  let terminals = 0;
  for (const part of parts.slice(1)) {
    if (part.tag === 'IN') member += `${part.value}~`;
    else if (part.tag === 'CL' || part.tag === 'IT' || part.tag === 'FU' || part.tag === 'PR') member += `${part.value}=>`;
    else {
      terminals += 1;
      member += terminals > 1 ? `/${part.value}` : part.value;
    }
  }
  const parsed: ParsedGtName = { object };
  if (member) parsed.member = member.replace(/(=>|~)$/, '');
  if (terminals > 1) parsed.parameter = true;
  if (parts[0].tag === 'PR' || parts[0].tag === 'FU') parsed.local = true;
  return parsed;
}

/** Edge kinds by WBCROSSGT OTYPE. */
export const GT_KINDS: Record<string, string> = {
  ME: 'method',
  EV: 'event',
  DA: 'data',
  TY: 'type',
  TK: 'typeKey'
};

/** Edge kinds by CROSS TYPE - the ones whose meaning is certain; the rest keep their letter. */
export const CROSS_KINDS: Record<string, string> = {
  F: 'function',
  U: 'perform',
  R: 'submit',
  T: 'transaction',
  N: 'message'
};

export const kindOfGt = (otype: string): string => GT_KINDS[otype] || `gt:${otype}`;
export const kindOfCross = (type: string): string => CROSS_KINDS[type] || `cross:${type || '?'}`;

/**
 * A CROSS row's target.
 *
 * PERFORM writes the form as NAME and the program it lives in as PROG - empty
 * when it is the calling program's own form. A message is the class padded to
 * twenty characters and the number: 'SBDS                349'.
 */
export function crossTarget(type: string, name: string, prog: string): Target {
  const value = name.trim().toUpperCase();
  if (type === 'U') return { object: prog.trim().toUpperCase(), member: value };
  if (type === 'N') {
    const match = /^(\S+)\s+(\d{3})$/.exec(value);
    return match ? { object: match[1], member: match[2] } : { object: value };
  }
  return { object: value };
}

/** Whether a name belongs to the customer namespace. */
export const isCustomerName = (name: string, prefixes: readonly string[] = ['Z', 'Y']): boolean => {
  const upper = name.trim().toUpperCase().replace(/^\\[A-Z]{2}:/, '');
  return prefixes.some(prefix => upper.startsWith(prefix)) || /^\/[^/]+\//.test(upper);
};

/**
 * Text as it is indexed and searched: lower case, ё folded to е (the index
 * tokenizer keeps them apart, and people type both), names split on the
 * characters ABAP joins words with.
 */
export const normalizeText = (text: string): string =>
  text.toLowerCase().replace(/ё/g, 'е').replace(/[_=~>\-/\\:]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A word cut back to what its forms share, so that a prefix search finds them
 * all: цены, цен and ценам all start with цен. Russian words lose their final
 * vowels, ь and й (at most two letters, never below three); an English word
 * its plural s. Crude, and meant to be - the index has no morphology, and a
 * search that finds a few words too many is the better failure.
 */
export const searchStem = (word: string): string => {
  if (/[а-я]/.test(word)) {
    let stem = word;
    for (let cut = 0; cut < 2 && stem.length > 3 && /[аеиоуыэюяьй]$/.test(stem); cut++) stem = stem.slice(0, -1);
    return stem;
  }
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
};

/** The words of a search phrase as they are matched: normalized, stripped to letters and digits, cut to their stems. */
export const searchTerms = (text: string): string[] =>
  normalizeText(text)
    .split(' ')
    .map(word => word.replace(/[^0-9a-zа-я]/g, ''))
    .filter(word => word.length > 0)
    .map(searchStem);
/**
 * A search phrase as an FTS5 query: every word a prefix term, quoted so that
 * nothing a person types is read as query syntax.
 */
export function ftsQuery(text: string, mode: 'all' | 'any' = 'all'): string | undefined {
  const words = searchTerms(text);
  if (words.length === 0) return undefined;
  return words.map(word => `"${word}"*`).join(mode === 'all' ? ' ' : ' OR ');
}

/** SAP one-letter language keys for the ISO codes a logon is usually given in. */
const LANGUAGE_KEYS: Record<string, string> = {
  RU: 'R', EN: 'E', DE: 'D', FR: 'F', ES: 'S', IT: 'I', PL: 'L', UK: '8', ZH: '1', JA: 'J', PT: 'P', TR: 'T', KK: 'K'
};

/** The SPRAS key for a logon language: one letter passes through, an ISO code is looked up. */
export const languageKey = (language: string | undefined): string => {
  const value = String(language || '').trim().toUpperCase();
  if (value.length === 1) return value;
  return LANGUAGE_KEYS[value] || 'E';
};

/** A literal for Open SQL. */
export const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;
