/**
 * The signature of a function module, read from its source and written back.
 *
 * ADT serves a function module as ABAP that starts with its own interface -
 * not with the *"-comment block SE37 shows:
 *
 *   FUNCTION Z_APP_GET_INVOICE
 *     IMPORTING
 *       VALUE(IV_LGNUM) TYPE LGNUM OPTIONAL
 *     EXPORTING
 *       VALUE(ET_INVOICE) TYPE ZAPP_INVOICE_LIST_TT.
 *
 * So the signature is in the text, and writing the text is how it is set. Two
 * conventions matter and are easy to get backwards: VALUE(NAME) is pass by
 * value and a bare NAME is pass by reference (the default for IMPORTING in
 * SE37 is by value, and ADT writes that out), and the whole interface is one
 * statement whose full stop sits on the last entry.
 */

export interface FunctionParameter {
  name: string;
  type?: string;
  /** VALUE(NAME) rather than a bare NAME. */
  byValue?: boolean;
  optional?: boolean;
  default?: string;
  /** TABLES parameters declared the old way: NAME STRUCTURE dtype. */
  structure?: string;
  /** LIKE dobj, which older interfaces use instead of TYPE. */
  like?: string;
}

export interface FunctionSignature {
  name: string;
  importing: FunctionParameter[];
  exporting: FunctionParameter[];
  changing: FunctionParameter[];
  tables: FunctionParameter[];
  exceptions: string[];
}

export interface ParsedFunction {
  signature: FunctionSignature;
  /** 1-based line the FUNCTION statement starts on. */
  headerStart: number;
  /** 1-based line the interface ends on. */
  headerEnd: number;
  /** Lines of the body, between the interface and ENDFUNCTION. */
  body: string[];
  bodyLines: number;
}

export class FunctionModuleError extends Error {}

const SECTIONS = ['IMPORTING', 'EXPORTING', 'CHANGING', 'TABLES', 'EXCEPTIONS'] as const;
type Section = typeof SECTIONS[number];

/** Strip a line comment; a full comment line becomes empty. */
const code = (line: string): string => {
  const text = String(line ?? '');
  if (/^\s*\*/.test(text)) return '';
  const quote = text.indexOf('"');
  return quote >= 0 ? text.slice(0, quote) : text;
};

/**
 * One entry of the interface.
 *
 * The shapes seen on live modules: VALUE(NAME) TYPE t, NAME TYPE t DEFAULT x,
 * NAME TYPE t OPTIONAL, NAME STRUCTURE s, NAME LIKE d, and a TABLES entry
 * carrying the pragma ADT adds for an untyped parameter.
 */
export function parseParameter(text: string): FunctionParameter | undefined {
  let rest = text.trim().replace(/\.$/, '').trim();
  if (!rest) return undefined;
  rest = rest.replace(/##[A-Z0-9_]+/gi, '').trim();

  let byValue = false;
  let name: string;
  const value = /^(VALUE|REFERENCE)\s*\(\s*([^)\s]+)\s*\)\s*(.*)$/i.exec(rest);
  if (value) {
    byValue = value[1].toUpperCase() === 'VALUE';
    name = value[2];
    rest = value[3].trim();
  } else {
    const bare = /^([^\s]+)\s*(.*)$/.exec(rest);
    if (!bare) return undefined;
    name = bare[1];
    rest = bare[2].trim();
  }

  const parameter: FunctionParameter = { name: name.toUpperCase(), ...(byValue ? { byValue: true } : {}) };

  const optional = /\bOPTIONAL\b\s*$/i.exec(rest);
  if (optional) rest = rest.slice(0, optional.index).trim();
  const fallback = /\bDEFAULT\b\s+(.+)$/i.exec(rest);
  if (fallback) {
    parameter.default = fallback[1].trim();
    rest = rest.slice(0, fallback.index).trim();
  }
  if (optional) parameter.optional = true;

  const typed = /^TYPE\s+(.+)$/i.exec(rest);
  const structured = /^STRUCTURE\s+(.+)$/i.exec(rest);
  const alike = /^LIKE\s+(.+)$/i.exec(rest);
  if (typed) parameter.type = typed[1].trim();
  else if (structured) parameter.structure = structured[1].trim();
  else if (alike) parameter.like = alike[1].trim();

  return parameter;
}

const emptySignature = (name: string): FunctionSignature =>
  ({ name, importing: [], exporting: [], changing: [], tables: [], exceptions: [] });

/** Read a function module's own source into its signature and its body. */
export function parseFunctionSource(source: string): ParsedFunction {
  const lines = String(source ?? '').split(/\r\n|\n|\r/);
  let headerStart = 0;
  let name = '';
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*FUNCTION\s+([^\s.]+)\s*\.?\s*$/i.exec(code(lines[i]));
    if (match) { headerStart = i + 1; name = match[1].toUpperCase(); break; }
  }
  if (!headerStart) {
    throw new FunctionModuleError('This source does not start with a FUNCTION statement - it is not a function module.');
  }

  const signature = emptySignature(name);
  // The interface is one statement: it runs to the first full stop.
  let headerEnd = headerStart;
  const firstLine = code(lines[headerStart - 1]).trim();
  if (!/\.\s*$/.test(firstLine)) {
    let section: Section | undefined;
    for (let line = headerStart + 1; line <= lines.length; line++) {
      const text = code(lines[line - 1]).trim();
      headerEnd = line;
      const closes = /\.\s*$/.test(text);
      const bare = text.replace(/\.$/, '').trim();
      const keyword = SECTIONS.find(word => new RegExp(`^${word}\\b`, 'i').test(bare));
      if (keyword) {
        section = keyword;
        const inline = bare.slice(keyword.length).trim();
        if (inline) addEntry(signature, section, inline);
      } else if (bare) {
        if (!section) {
          throw new FunctionModuleError(
            `Line ${line} of the interface belongs to no section: "${text}".`
          );
        }
        addEntry(signature, section, bare);
      }
      if (closes) break;
    }
  }

  const body: string[] = [];
  for (let line = headerEnd + 1; line <= lines.length; line++) {
    if (/^\s*ENDFUNCTION\s*\./i.test(code(lines[line - 1]))) break;
    body.push(lines[line - 1]);
  }

  return { signature, headerStart, headerEnd, body, bodyLines: body.length };
}

/** Put one entry into the section being read. */
function addEntry(signature: FunctionSignature, section: Section, text: string): void {
  if (section === 'EXCEPTIONS') {
    const name = text.trim().replace(/\.$/, '').trim();
    if (name) signature.exceptions.push(name.toUpperCase());
    return;
  }
  const parameter = parseParameter(text);
  if (!parameter) return;
  const target: Record<Section, FunctionParameter[] | undefined> = {
    IMPORTING: signature.importing,
    EXPORTING: signature.exporting,
    CHANGING: signature.changing,
    TABLES: signature.tables,
    EXCEPTIONS: undefined
  };
  target[section]!.push(parameter);
}

const renderParameter = (parameter: FunctionParameter, indent: string): string => {
  // Upper case, as ADT itself writes an interface - ABAP does not care, but a
  // source that mixes both styles reads as if two people wrote it.
  const name = String(parameter.name || '').trim().toUpperCase();
  if (!name) throw new FunctionModuleError('Every parameter needs a name.');
  const head = parameter.byValue ? `VALUE(${name})` : name;
  const type = parameter.type
    ? ` TYPE ${parameter.type}`
    : parameter.structure
      ? ` STRUCTURE ${parameter.structure}`
      : parameter.like
        ? ` LIKE ${parameter.like}`
        : '';
  if (!type) {
    throw new FunctionModuleError(
      `Parameter ${name} needs a type (or structure/like); an untyped parameter cannot be written from here.`
    );
  }
  const tail = parameter.default !== undefined && parameter.default !== ''
    ? ` DEFAULT ${parameter.default}`
    : parameter.optional
      ? ' OPTIONAL'
      : '';
  return `${indent}${head}${type}${tail}`;
};

export interface FunctionSpec {
  name: string;
  importing?: FunctionParameter[];
  exporting?: FunctionParameter[];
  changing?: FunctionParameter[];
  tables?: FunctionParameter[];
  exceptions?: string[];
  /** Body lines, without FUNCTION/ENDFUNCTION. */
  implementation?: string[];
}

/**
 * The complete source of a function module.
 *
 * The interface is one statement, so the full stop goes on its last line -
 * and on the FUNCTION line itself when there are no parameters at all.
 */
export function buildFunctionSource(spec: FunctionSpec): string {
  const name = String(spec.name || '').trim().toUpperCase();
  if (!name) throw new FunctionModuleError('A function module needs a name.');

  const lines: string[] = [];
  const groups: Array<[Section, FunctionParameter[] | undefined]> = [
    ['IMPORTING', spec.importing],
    ['EXPORTING', spec.exporting],
    ['CHANGING', spec.changing],
    ['TABLES', spec.tables]
  ];
  for (const [word, parameters] of groups) {
    if (!parameters?.length) continue;
    lines.push(`  ${word}`);
    for (const parameter of parameters) lines.push(renderParameter(parameter, '    '));
  }
  if (spec.exceptions?.length) {
    lines.push('  EXCEPTIONS');
    for (const exception of spec.exceptions) {
      const text = String(exception).trim().toUpperCase();
      if (!text) continue;
      lines.push(`    ${text}`);
    }
  }

  const header = lines.length === 0
    ? [`FUNCTION ${name}.`]
    : [`FUNCTION ${name}`, ...lines.slice(0, -1), `${lines[lines.length - 1]}.`];

  // Indent one step in, keeping whatever indentation the caller wrote: their
  // nesting is information, and flattening it turns an IF block into a list.
  const body = (spec.implementation || []).length
    ? spec.implementation!.map(line => (line.trim() === '' ? '' : `  ${line}`))
    : [`  " TODO: implement ${name.toLowerCase()}`];

  return [...header, '', ...body, '', 'ENDFUNCTION.', ''].join('\n');
}

/** How many parameters and exceptions a signature has, for a short answer. */
export const signatureCounts = (signature: FunctionSignature): Record<string, number> => ({
  importing: signature.importing.length,
  exporting: signature.exporting.length,
  changing: signature.changing.length,
  tables: signature.tables.length,
  exceptions: signature.exceptions.length
});
