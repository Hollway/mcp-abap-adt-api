/**
 * Adding a member to an ABAP class, and taking one out.
 *
 * A method lives in two places in one text: the declaration inside a
 * visibility section of the DEFINITION part, and the implementation between
 * the METHOD/ENDMETHOD of the IMPLEMENTATION part. Doing that with
 * patchObjectSource means reading the source, finding both places, guessing
 * the indentation and writing two edits whose line numbers must both still be
 * right - which is why this is worth having as one operation.
 *
 * Everything here is pure: it takes the source and a specification, and
 * answers with the edits patchObjectSource takes. What the edits are applied
 * with, and how the object is locked and activated, is the handler's business.
 */

export type Visibility = 'public' | 'protected' | 'private';

export interface Parameter {
  name: string;
  type: string;
  /** IMPORTING only: OPTIONAL, or DEFAULT <value> when a default is given. */
  optional?: boolean;
  default?: string;
}

export interface MethodSpec {
  name: string;
  visibility?: Visibility;
  /** CLASS-METHODS rather than METHODS. */
  static?: boolean;
  importing?: Parameter[];
  exporting?: Parameter[];
  changing?: Parameter[];
  returning?: Parameter;
  raising?: string[];
  /** Body lines. Indented to the class's own style; no METHOD/ENDMETHOD. */
  implementation?: string[];
  /** Declaration text to use verbatim, instead of building one. */
  declaration?: string;
}

export interface AttributeSpec {
  name: string;
  type: string;
  visibility?: Visibility;
  /** CLASS-DATA rather than DATA. */
  static?: boolean;
  /** CONSTANTS, which needs a value. */
  constant?: boolean;
  value?: string;
  /** READ-ONLY, which ADT only accepts in the public section. */
  readOnly?: boolean;
}

export interface ClassLayout {
  lines: string[];
  /** 1-based line of each `<visibility> section.` that is there. */
  sections: Partial<Record<Visibility, number>>;
  /** 1-based line of the ENDCLASS that closes the definition. */
  definitionEnd: number;
  /** 1-based line of `CLASS ... IMPLEMENTATION.`, when there is one. */
  implementationStart?: number;
  /** 1-based line of the ENDCLASS that closes the implementation. */
  implementationEnd?: number;
}

export class ClassEditError extends Error {}

const SECTION = /^\s*(public|protected|private)\s+section\s*\.\s*(?:"|\*)?/i;
const ENDCLASS = /^\s*endclass\s*\.\s*(?:"|\*)?/i;
const IMPLEMENTATION = /^\s*class\s+\S+\s+implementation\s*\.\s*(?:"|\*)?/i;
const DEFINITION = /^\s*class\s+\S+\s+definition\b/i;

/** Strip a line comment so punctuation at the end of a statement is visible. */
const code = (line: string): string => {
  const text = String(line ?? '');
  if (/^\s*\*/.test(text)) return '';
  const quote = text.indexOf('"');
  return quote >= 0 ? text.slice(0, quote) : text;
};

const isBlank = (line: string): boolean => code(line).trim() === '';

/**
 * Find the parts of a class source. The definition and the implementation are
 * one document in ADT, and both end with an ENDCLASS, so they are told apart
 * by the CLASS ... IMPLEMENTATION line between them.
 */
export function readClassLayout(source: string): ClassLayout {
  const lines = String(source ?? '').split(/\r\n|\n|\r/);
  const sections: Partial<Record<Visibility, number>> = {};
  let definitionStart = 0;
  let implementationStart: number | undefined;
  let definitionEnd = 0;
  let implementationEnd: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const text = code(lines[i]);
    if (!definitionStart && DEFINITION.test(text)) { definitionStart = i + 1; continue; }
    if (!implementationStart && IMPLEMENTATION.test(text)) { implementationStart = i + 1; continue; }
    const section = SECTION.exec(text);
    if (section && !implementationStart) {
      const name = section[1].toLowerCase() as Visibility;
      if (!sections[name]) sections[name] = i + 1;
      continue;
    }
    if (ENDCLASS.test(text)) {
      if (implementationStart) implementationEnd = i + 1;
      else if (!definitionEnd) definitionEnd = i + 1;
    }
  }

  if (!definitionStart) throw new ClassEditError('This source has no CLASS ... DEFINITION - it is not a class.');
  if (!definitionEnd) throw new ClassEditError('The class definition has no ENDCLASS.');
  return { lines, sections, definitionEnd, implementationStart, implementationEnd };
}

/** Last line of a visibility section's body, 1-based; the header when empty. */
const sectionBodyEnd = (layout: ClassLayout, visibility: Visibility): number => {
  const start = layout.sections[visibility];
  if (!start) {
    throw new ClassEditError(
      `This class has no ${visibility} section. Sections present: ${Object.keys(layout.sections).join(', ') || 'none'}.`
    );
  }
  const nextSection = Object.values(layout.sections)
    .filter(line => (line as number) > start)
    .sort((a, b) => (a as number) - (b as number))[0] as number | undefined;
  const limit = Math.min(nextSection ?? layout.definitionEnd, layout.definitionEnd);
  let end = start;
  for (let line = start + 1; line < limit; line++) {
    if (!isBlank(layout.lines[line - 1])) end = line;
  }
  return end;
};

/** The indentation this class uses inside a section, or a sensible default. */
const sectionIndent = (layout: ClassLayout, visibility: Visibility): string => {
  const start = layout.sections[visibility];
  if (start) {
    for (let line = start + 1; line < layout.definitionEnd; line++) {
      const text = layout.lines[line - 1];
      if (isBlank(text)) continue;
      if (SECTION.test(code(text))) break;
      const indent = /^(\s*)/.exec(text)![1];
      if (indent) return indent;
    }
  }
  return '    ';
};

/** The indentation this class uses for its METHOD blocks. */
const methodIndent = (layout: ClassLayout): string => {
  if (layout.implementationStart && layout.implementationEnd) {
    for (let line = layout.implementationStart + 1; line < layout.implementationEnd; line++) {
      const match = /^(\s*)method\s+\S+/i.exec(layout.lines[line - 1]);
      if (match) return match[1];
    }
  }
  return '  ';
};

const parameterList = (parameters: Parameter[] | undefined, indent: string): string[] => {
  if (!parameters?.length) return [];
  return parameters.map(parameter => {
    const name = String(parameter.name || '').trim();
    const type = String(parameter.type || '').trim();
    if (!name || !type) throw new ClassEditError('Every parameter needs a name and a type.');
    const suffix = parameter.default !== undefined && parameter.default !== ''
      ? ` DEFAULT ${parameter.default}`
      : parameter.optional
        ? ' OPTIONAL'
        : '';
    return `${indent}!${name} TYPE ${type}${suffix}`;
  });
};

/** The METHODS declaration for one method, indented like its neighbours. */
export function methodDeclaration(spec: MethodSpec, indent: string): string[] {
  if (spec.declaration) return String(spec.declaration).split(/\r\n|\n|\r/);
  const name = String(spec.name || '').trim();
  if (!name) throw new ClassEditError('A method needs a name.');

  const keyword = spec.static ? 'CLASS-METHODS' : 'METHODS';
  const inner = `${indent}  `;
  const parameterIndent = `${indent}    `;
  const lines = [`${indent}${keyword} ${name}`];

  const groups: Array<[string, Parameter[] | undefined]> = [
    ['IMPORTING', spec.importing],
    ['EXPORTING', spec.exporting],
    ['CHANGING', spec.changing]
  ];
  for (const [word, parameters] of groups) {
    if (!parameters?.length) continue;
    lines.push(`${inner}${word}`);
    lines.push(...parameterList(parameters, parameterIndent));
  }
  if (spec.returning) {
    const type = String(spec.returning.type || '').trim();
    const value = String(spec.returning.name || '').trim();
    if (!type || !value) throw new ClassEditError('A returning parameter needs a name and a type.');
    lines.push(`${inner}RETURNING`);
    lines.push(`${parameterIndent}VALUE(${value}) TYPE ${type}`);
  }
  if (spec.raising?.length) {
    lines.push(`${inner}RAISING`);
    lines.push(...spec.raising.map(exception => `${parameterIndent}${String(exception).trim()}`));
  }

  // One statement, one full stop: on its own where the signature has groups,
  // on the name where it has none.
  if (lines.length === 1) lines[0] = `${lines[0]} .`;
  else lines.push(`${parameterIndent}.`);
  return lines;
}

/** The METHOD ... ENDMETHOD block, with the body indented one step in. */
export function methodImplementation(spec: MethodSpec, indent: string): string[] {
  const name = String(spec.name || '').trim();
  // Indented one step in, keeping the caller's own indentation: their nesting
  // is information, and flattening it turns an IF block into a list.
  const body = (spec.implementation || []).length
    ? spec.implementation!.map(line => (line.trim() === '' ? '' : `${indent}  ${line}`))
    : [`${indent}  " TODO: implement ${name.toLowerCase()}`];
  return [`${indent}METHOD ${name.toLowerCase()}.`, ...body, `${indent}ENDMETHOD.`];
}

export interface InsertEditPlan {
  insertAfterLine: number;
  insertion: string;
  describe: string;
}

export interface DeleteEditPlan {
  startLine: number;
  endLine: number;
  replacement: string;
  describe: string;
}

export type ClassEdit = InsertEditPlan | DeleteEditPlan;

const quoteRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Statement {
  start: number;
  end: number;
  /** Whether it opens a chain: METHODS: a, b, c. */
  chained: boolean;
}

/**
 * The statements inside the visibility sections of the definition part, as
 * line ranges. A statement runs to the full stop - inside a chain the commas
 * separate entries, not statements - so a declaration spread over eight lines
 * of parameters is one range. The CLASS ... DEFINITION statement itself is not
 * one of these: nothing is ever declared in it.
 */
export function definitionStatements(layout: ClassLayout): Statement[] {
  const statements: Statement[] = [];
  const firstSection = Math.min(...Object.values(layout.sections).map(line => line as number));
  if (!Number.isFinite(firstSection)) return statements;
  let start: number | undefined;
  for (let line = firstSection; line < layout.definitionEnd; line++) {
    const text = code(layout.lines[line - 1]).trim();
    if (text === '' || SECTION.test(text) || DEFINITION.test(text)) { start = undefined; continue; }
    if (start === undefined) start = line;
    if (/\.\s*$/.test(text)) {
      const first = code(layout.lines[start - 1]).trim();
      statements.push({ start, end: line, chained: /(^|\s)(class-)?(methods|data|constants|class-data)\s*:/i.test(first) });
      start = undefined;
    }
  }
  return statements;
}

/** Where a method is already declared or implemented, if it is. */
export function findMethod(layout: ClassLayout, name: string): {
  declaredAt?: number;
  implementedAt?: number;
} {
  const wanted = quoteRegex(String(name).trim().toLowerCase());
  // The declared name follows METHODS (or the colon of a chain), or opens the
  // line as the next entry of one.
  const declares = new RegExp(`^\\s*(?:(?:class-)?methods\\s*:?\\s*)?${wanted}(\\s|,|\\.|$)`, 'i');
  let declaredAt: number | undefined;
  let implementedAt: number | undefined;

  for (const statement of definitionStatements(layout)) {
    const first = code(layout.lines[statement.start - 1]).trim();
    if (!/^(class-)?methods\b/i.test(first)) continue;
    for (let line = statement.start; line <= statement.end; line++) {
      const text = code(layout.lines[line - 1]);
      // A parameter line starts with ! or a keyword, never with the name
      // being declared - so matching the head of the line is enough.
      if (declares.test(text)) { declaredAt = line; break; }
    }
    if (declaredAt) break;
  }

  if (layout.implementationStart && layout.implementationEnd) {
    const implements_ = new RegExp(`^\\s*method\\s+${wanted}\\s*\\.`, 'i');
    for (let line = layout.implementationStart; line < layout.implementationEnd; line++) {
      if (implements_.test(code(layout.lines[line - 1]))) { implementedAt = line; break; }
    }
  }
  return { ...(declaredAt ? { declaredAt } : {}), ...(implementedAt ? { implementedAt } : {}) };
}

/** The edits that add one method to a class. */
export function planAddMethod(source: string, spec: MethodSpec): ClassEdit[] {
  const layout = readClassLayout(source);
  const visibility = (spec.visibility || 'public') as Visibility;
  const existing = findMethod(layout, spec.name);
  if (existing.declaredAt || existing.implementedAt) {
    throw new ClassEditError(
      `${String(spec.name).toUpperCase()} is already there${existing.declaredAt ? ` (declared on line ${existing.declaredAt})` : ''}${existing.implementedAt ? ` (implemented on line ${existing.implementedAt})` : ''}. Change it with patchObjectSource, or delete it first.`
    );
  }
  if (!layout.implementationStart || !layout.implementationEnd) {
    throw new ClassEditError('This source has no CLASS ... IMPLEMENTATION part, so a method has nowhere to be implemented.');
  }

  const declaration = methodDeclaration(spec, sectionIndent(layout, visibility)).join('\n');
  const implementation = methodImplementation(spec, methodIndent(layout)).join('\n');

  // Last non-blank line before the implementation's ENDCLASS: appending after
  // the ENDCLASS itself would put the method outside the class.
  let implementationAnchor = layout.implementationStart;
  for (let line = layout.implementationStart + 1; line < layout.implementationEnd; line++) {
    if (!isBlank(layout.lines[line - 1])) implementationAnchor = line;
  }

  // Descending line order, so applying one edit cannot move the other.
  return [
    {
      insertAfterLine: implementationAnchor,
      insertion: implementation,
      describe: `implementation of ${String(spec.name).toUpperCase()}`
    },
    {
      insertAfterLine: sectionBodyEnd(layout, visibility),
      insertion: declaration,
      describe: `${visibility} declaration of ${String(spec.name).toUpperCase()}`
    }
  ];
}

/** The edits that add one attribute or constant to a class. */
export function planAddAttribute(source: string, spec: AttributeSpec): ClassEdit[] {
  const layout = readClassLayout(source);
  const visibility = (spec.visibility || 'private') as Visibility;
  const name = String(spec.name || '').trim();
  const type = String(spec.type || '').trim();
  if (!name || !type) throw new ClassEditError('An attribute needs a name and a type.');
  if (spec.constant && (spec.value === undefined || spec.value === '')) {
    throw new ClassEditError('A constant needs a value.');
  }
  if (spec.readOnly && visibility !== 'public') {
    throw new ClassEditError('READ-ONLY is only accepted on a public attribute.');
  }

  const indent = sectionIndent(layout, visibility);
  const keyword = spec.constant
    ? (spec.static ? 'CLASS-DATA' : 'CONSTANTS')
    : (spec.static ? 'CLASS-DATA' : 'DATA');
  const value = spec.value !== undefined && spec.value !== '' ? ` VALUE ${spec.value}` : '';
  const readOnly = spec.readOnly ? ' READ-ONLY' : '';
  const declaration = `${indent}${keyword} ${name} TYPE ${type}${value}${readOnly} .`;

  return [{
    insertAfterLine: sectionBodyEnd(layout, visibility),
    insertion: declaration,
    describe: `${visibility} ${keyword.toLowerCase()} ${name.toUpperCase()}`
  }];
}

/** The statement a line belongs to. */
const statementOf = (layout: ClassLayout, line: number): Statement => {
  const found = definitionStatements(layout).find(
    statement => statement.start <= line && line <= statement.end
  );
  if (!found) throw new ClassEditError(`Could not tell where the declaration on line ${line} begins and ends.`);
  return found;
};

/** The edits that take one method out of a class, declaration and body. */
export function planDeleteMethod(source: string, name: string): ClassEdit[] {
  const layout = readClassLayout(source);
  const found = findMethod(layout, name);
  if (!found.declaredAt && !found.implementedAt) {
    throw new ClassEditError(`${String(name).toUpperCase()} is not declared or implemented in this class.`);
  }

  const edits: DeleteEditPlan[] = [];

  if (found.implementedAt && layout.implementationEnd) {
    let end = found.implementedAt;
    while (end < layout.implementationEnd && !/^\s*endmethod\s*\./i.test(code(layout.lines[end - 1]))) end++;
    if (!/^\s*endmethod\s*\./i.test(code(layout.lines[end - 1]))) {
      throw new ClassEditError(`The implementation of ${String(name).toUpperCase()} has no ENDMETHOD; refusing to guess where it ends.`);
    }
    edits.push({
      startLine: found.implementedAt,
      endLine: end,
      replacement: '',
      describe: `implementation of ${String(name).toUpperCase()}`
    });
  }

  if (found.declaredAt) {
    const { start, end, chained } = statementOf(layout, found.declaredAt);
    // Another entry on the same line: METHODS: first, second. Removing part of
    // a line is a text edit, not a line edit, and guessing it wrong rewrites
    // somebody else's declaration.
    const entryLine = code(layout.lines[found.declaredAt - 1]).trim();
    const shared = /,/.test(entryLine) && !/,\s*$/.test(entryLine);

    if (chained && shared) {
      throw new ClassEditError(
        `The declaration of ${String(name).toUpperCase()} on line ${found.declaredAt} shares a line with another method in a METHODS: chain. Edit that line with patchObjectSource instead.`
      );
    }

    if (!chained) {
      edits.push({
        startLine: start,
        endLine: end,
        replacement: '',
        describe: `declaration of ${String(name).toUpperCase()}`
      });
    } else {
      // One entry of a chain, not the whole statement: it runs from its own
      // line to the line that ends it with a comma or the full stop.
      let entryEnd = found.declaredAt;
      while (entryEnd < end && !/[,.]\s*$/.test(code(layout.lines[entryEnd - 1]).trim())) entryEnd++;
      const isLastEntry = /\.\s*$/.test(code(layout.lines[entryEnd - 1]).trim());
      const hasEarlierEntry = found.declaredAt > start + 1
        || !/(^|\s)(class-)?methods\s*:\s*$/i.test(code(layout.lines[start - 1]).trim());

      if (!isLastEntry) {
        edits.push({
          startLine: found.declaredAt,
          endLine: entryEnd,
          replacement: '',
          describe: `declaration of ${String(name).toUpperCase()} (one entry of a chain)`
        });
      } else if (hasEarlierEntry) {
        // The entry before it ends in a comma that now has nothing to join to.
        const previous = layout.lines[found.declaredAt - 2];
        edits.push({
          startLine: found.declaredAt - 1,
          endLine: entryEnd,
          replacement: previous.replace(/,\s*$/, ' .'),
          describe: `declaration of ${String(name).toUpperCase()} (last entry of a chain)`
        });
      } else {
        // The only entry: the chain itself goes.
        edits.push({
          startLine: start,
          endLine: end,
          replacement: '',
          describe: `declaration of ${String(name).toUpperCase()} (the whole chain)`
        });
      }
    }
  }

  // Descending, so the first edit applied cannot move the second.
  return edits.sort((a, b) => b.startLine - a.startLine);
}
