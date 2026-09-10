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

/** The name in CLASS <name> DEFINITION. */
export const classNameOf = (source: string): string | undefined => {
  const match = /^\s*class\s+([\w/]+)\s+definition/im.exec(String(source ?? ''));
  return match ? match[1].toUpperCase() : undefined;
};

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

/**
 * Types the class declares itself.
 *
 * A parameter typed with one of these reads as a bare name in the source -
 * CHANGING ct_stawn TYPE tt_stawn - and that name means nothing anywhere else:
 * a snippet declaring DATA ... TYPE tt_stawn is refused with "type TT_STAWN is
 * unknown". Qualified as ZCL_APP=>TT_STAWN it resolves, which is why they are
 * collected here.
 */
export function listTypes(source: string): string[] {
  const layout = readClassLayout(source);
  const names = new Set<string>();
  // How deep inside a BEGIN OF ... END OF the reader is. The components in
  // there are not types, and taking them for types would be worse than
  // missing one: a component called MATNR would turn every parameter typed
  // MATNR into ZCL_X=>MATNR, which does not exist. The count lives out here
  // because the block can be one statement per line rather than one chain.
  let inStructure = 0;

  for (const statement of definitionStatements(layout)) {
    const lines: string[] = [];
    for (let line = statement.start; line <= statement.end; line++) {
      lines.push(code(layout.lines[line - 1]).trim());
    }
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    const head = /^types\s*:?\s*/i.exec(text);
    if (!head) continue;

    const body = text.slice(head[0].length).replace(/\.$/, '');
    for (const entry of chainEntries(body)) {
      // BEGIN OF names the structure; END OF closes one already collected.
      const begin = /^begin\s+of\s+([\w/]+)/i.exec(entry);
      if (begin) {
        if (inStructure === 0) names.add(begin[1].toUpperCase());
        inStructure++;
        continue;
      }
      if (/^end\s+of\b/i.test(entry)) {
        inStructure = Math.max(0, inStructure - 1);
        continue;
      }
      if (inStructure > 0) continue;
      const plain = /^([\w/]+)/.exec(entry);
      if (plain) names.add(plain[1].toUpperCase());
    }
  }
  return [...names];
}

/** The methods a class declares, without their parameters. */
export const listMethods = (source: string): MethodEntry[] =>
  declarations(source).map(({ name, isStatic, visibility }) => ({ name, isStatic, visibility }));

/** Every name-shaped token of a type expression. */
const NAME_TOKEN = /[A-Za-z_/][A-Za-z0-9_/]*/g;

/**
 * A parameter type as it reads from outside the class.
 *
 * The whole type expression is walked rather than matched as a bare name: a
 * parameter can be typed TYPE STANDARD TABLE OF ts_row or TYPE REF TO
 * ty_handle, and the name that needs qualifying sits inside it.
 */
export function qualifyTypes(
  parameter: FunctionParameter,
  owner: string | undefined,
  local: string[]
): FunctionParameter {
  if (!owner || local.length === 0) return parameter;
  const rewrite = (text: string): string =>
    text.replace(NAME_TOKEN, (token, offset: number) => {
      if (!local.some(name => name.toUpperCase() === token.toUpperCase())) return token;
      // Leave a name that is already reached through something else alone:
      // zcl_other=>ts_row and zif_x~ts_row are not this class's to qualify.
      const before = text.slice(0, offset);
      return before.endsWith('=>') || before.endsWith('~')
        ? token
        : `${owner.toLowerCase()}=>${token}`;
    });
  return {
    ...parameter,
    ...(parameter.type ? { type: rewrite(parameter.type) } : {}),
    ...(parameter.like ? { like: rewrite(parameter.like) } : {}),
    ...(parameter.structure ? { structure: rewrite(parameter.structure) } : {})
  };
}

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
  const owner = classNameOf(source);
  const local = owner ? listTypes(source) : [];
  const qualify = (list: FunctionParameter[]): FunctionParameter[] =>
    list.map(parameter => qualifyTypes(parameter, owner, local));
  const returning = qualify(parameters(parts.RETURNING))[0];

  return {
    name: declaration.name,
    isStatic: declaration.isStatic,
    ...(declaration.visibility ? { visibility: declaration.visibility } : {}),
    importing: qualify(parameters(parts.IMPORTING)),
    exporting: qualify(parameters(parts.EXPORTING)),
    changing: qualify(parameters(parts.CHANGING)),
    ...(returning ? { returning } : {}),
    exceptions: exceptionNames(parts.EXCEPTIONS),
    raising: exceptionNames(parts.RAISING),
    ...(/\bredefinition\b/i.test(declaration.entry) ? { redefinition: true } : {})
  };
}
