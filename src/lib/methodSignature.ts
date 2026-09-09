/**
 * The signature of a method, read out of its class.
 *
 * classComponents answers what a class is made of - methods, their visibility,
 * their kind - and stops there: it says nothing about what a method takes or
 * gives back. So the only place a method's parameters can be read is the
 * definition part of the source, and calling a method means reading them.
 *
 * Two shapes of that text make it more than a regular expression:
 *
 *   CLASS-METHODS get_stawn
 *     IMPORTING !iv_matnr TYPE matnr
 *               iv_werks  TYPE werks_d OPTIONAL
 *     RETURNING VALUE(rv_stawn) TYPE stawn
 *     RAISING   cx_mm_error.
 *
 * one statement over four lines - and the chained form, where one statement
 * declares several methods separated by commas:
 *
 *   CLASS-METHODS: first IMPORTING iv_a TYPE c,
 *                  second RETURNING VALUE(r) TYPE i.
 *
 * The parameters are then parsed by the same reader the function module
 * interface uses: the entries have the same shapes, VALUE(NAME) and all.
 */

import { readClassLayout, definitionStatements } from './classEdit';
import { parseParameter } from './functionModule';
import type { FunctionParameter } from './functionModule';
import type { CallableSignature } from './callGen';

export class MethodSignatureError extends Error {}

export interface MethodSignature extends CallableSignature {
  name: string;
  /** CLASS-METHODS rather than METHODS. */
  isStatic: boolean;
  visibility?: 'public' | 'protected' | 'private';
  /** Class-based exceptions, which arrive as an exception object. */
  raising: string[];
  /** Declared with REDEFINITION, so the parameters are the parent's. */
  redefinition?: boolean;
}

export interface MethodEntry {
  name: string;
  isStatic: boolean;
  visibility?: 'public' | 'protected' | 'private';
}

const SECTION_NAMES = ['IMPORTING', 'EXPORTING', 'CHANGING', 'RETURNING', 'RAISING', 'EXCEPTIONS'] as const;
type SectionName = typeof SECTION_NAMES[number];

/** Strip a line comment; a full comment line becomes empty. */
const code = (line: string): string => {
  const text = String(line ?? '');
  if (/^\s*\*/.test(text)) return '';
  const quote = text.indexOf('"');
  return quote >= 0 ? text.slice(0, quote) : text;
};

/** Split a chain into its entries: the commas separate methods, not statements. */
function chainEntries(text: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '(') depth++;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      entries.push(text.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(text.slice(start));
  return entries.map(entry => entry.trim()).filter(entry => entry.length > 0);
}

/**
 * The sections of one entry, keyed by keyword.
 *
 * The keywords are found as whole words in the order they appear, which is
 * also the order ABAP requires them in - so each section runs to the next
 * keyword.
 */
function sections(entry: string): Partial<Record<SectionName, string>> {
  const found: { name: SectionName; at: number; after: number }[] = [];
  for (const name of SECTION_NAMES) {
    const pattern = new RegExp(`(^|\\s)${name}(\\s|$)`, 'i');
    const match = pattern.exec(entry);
    if (match) {
      found.push({
        name,
        at: match.index + match[1].length,
        after: match.index + match[1].length + name.length
      });
    }
  }
  found.sort((a, b) => a.at - b.at);

  const result: Partial<Record<SectionName, string>> = {};
  found.forEach((section, index) => {
    const end = index + 1 < found.length ? found[index + 1].at : entry.length;
    result[section.name] = entry.slice(section.after, end).trim();
  });
  return result;
}

/** Where in a section text each parameter begins. */
function splitParameters(text: string): string[] {
  const pattern = /(?:^|\s)(?:(?:value|reference)\s*\(\s*!?[\w/]+\s*\)|!?[\w/]+)\s+(?:type|like)\b/gi;
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    // The match may start on the whitespace that separates it from the
    // previous parameter; the parameter itself starts after that.
    const offset = /^\s/.test(match[0]) ? 1 : 0;
    starts.push(match.index + offset);
    // Continue after the name so a type expression cannot start a parameter.
    pattern.lastIndex = match.index + match[0].length;
  }
  if (!starts.length) return [];
  return starts
    .map((start, index) => text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length).trim())
    .filter(part => part.length > 0);
}

/** The parameters of one section. */
const parameters = (text: string | undefined): FunctionParameter[] => {
  if (!text) return [];
  const result: FunctionParameter[] = [];
  for (const part of splitParameters(text)) {
    const parsed = parseParameter(part.replace(/^!/, '').replace(/\(\s*!/, '('));
    if (parsed) result.push(parsed);
  }
  return result;
};

/** Class-based exception names, with the RESUMABLE wrapper taken off. */
const exceptionNames = (text: string | undefined): string[] =>
  !text
    ? []
    : text
      .replace(/resumable\s*\(\s*([\w/]+)\s*\)/gi, '$1')
      .split(/[\s,]+/)
      .map(name => name.replace(/\.$/, '').trim().toUpperCase())
      .filter(name => /^[A-Z/][A-Z0-9_/]*$/.test(name));

interface Declaration {
  entry: string;
  isStatic: boolean;
  visibility?: 'public' | 'protected' | 'private';
  name: string;
}

/** Every method declared in the definition part, with the text that declares it. */
function declarations(source: string): Declaration[] {
  const layout = readClassLayout(source);
  const found: Declaration[] = [];

  const visibilityOf = (line: number): 'public' | 'protected' | 'private' | undefined => {
    let best: { visibility: 'public' | 'protected' | 'private'; at: number } | undefined;
    for (const [visibility, at] of Object.entries(layout.sections)) {
      const start = at as number;
      if (start <= line && (!best || start > best.at)) {
        best = { visibility: visibility as 'public' | 'protected' | 'private', at: start };
      }
    }
    return best?.visibility;
  };

  for (const statement of definitionStatements(layout)) {
    const lines: string[] = [];
    for (let line = statement.start; line <= statement.end; line++) {
      lines.push(code(layout.lines[line - 1]).trim());
    }
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    const head = /^(class-)?methods\s*:?\s*/i.exec(text);
    if (!head) continue;

    const isStatic = !!head[1];
    const visibility = visibilityOf(statement.start);
    const body = text.slice(head[0].length).replace(/\.$/, '');
    for (const entry of statement.chained ? chainEntries(body) : [body]) {
      // The tilde belongs to the name: if_x~do_it is one method, and cutting
      // at it would report the interface as the method.
      const name = /^!?([\w/~]+)/.exec(entry);
      if (!name) continue;
      found.push({ entry, isStatic, visibility, name: name[1].toUpperCase() });
    }
  }
  return found;
}

/** The methods a class declares, without their parameters. */
export const listMethods = (source: string): MethodEntry[] =>
  declarations(source).map(({ name, isStatic, visibility }) => ({ name, isStatic, visibility }));

/**
 * The signature of one method of a class.
 *
 * A method that is not there is answered with the ones that are: the mistake
 * is nearly always a name, and the list is the cheapest way to correct it.
 */
export function parseMethodSignature(source: string, methodName: string): MethodSignature {
  const wanted = String(methodName || '').trim().toUpperCase();
  if (!wanted) throw new MethodSignatureError('Pass the method name.');

  const all = declarations(source);
  const declaration = all.find(entry => entry.name === wanted);
  if (!declaration) {
    const names = all.map(entry => `${entry.name}${entry.isStatic ? ' (static)' : ''}`);
    throw new MethodSignatureError(
      `This class does not declare ${wanted}. It declares: ${names.join(', ') || 'no methods at all'}.`
    );
  }

  const parts = sections(declaration.entry);
  const returning = parameters(parts.RETURNING)[0];

  return {
    name: declaration.name,
    isStatic: declaration.isStatic,
    ...(declaration.visibility ? { visibility: declaration.visibility } : {}),
    importing: parameters(parts.IMPORTING),
    exporting: parameters(parts.EXPORTING),
    changing: parameters(parts.CHANGING),
    ...(returning ? { returning } : {}),
    exceptions: exceptionNames(parts.EXCEPTIONS),
    raising: exceptionNames(parts.RAISING),
    ...(/\bredefinition\b/i.test(declaration.entry) ? { redefinition: true } : {})
  };
}
