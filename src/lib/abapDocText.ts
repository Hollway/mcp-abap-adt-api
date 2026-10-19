/**
 * The short text of a method, an attribute, a constant or an event - and of
 * the parameters of a method - written as ABAP Doc.
 *
 * Unlike the description of the class itself, these have no metadata resource
 * in ADT: the backend takes them from the source. Measured on the ERP system in
 * $TMP: a comment line
 *
 *   "! <p class="shorttext synchronized" lang="ru">text</p>
 *
 * directly above a declaration lands in SEOCOMPOTX when the source is saved,
 * and "! @parameter name | <p class="shorttext synchronized" ...>text</p> lands
 * in SEOSUBCOTX. The synchronisation runs one way only: removing the comment
 * leaves the text in the table, so a source without ABAP Doc never wipes a
 * description somebody wrote in SE24 - and a description cannot be cleared by
 * deleting its comment either.
 *
 * Everything here is pure: it takes the source and answers with the line edits
 * patchObjectSource takes.
 */
import { readClassLayout } from './classEdit';

/** What SEOCOMPOTX-DESCRIPT and SEOSUBCOTX-DESCRIPT hold. */
export const MAX_SHORT_TEXT = 60;

export class AbapDocError extends Error {}

export interface ComponentTexts {
  /** The component the texts belong to: method, attribute, constant or event. */
  component: string;
  /** Its own short text; omitted to leave it as it is. */
  description?: string;
  /** Short texts of its parameters, by parameter name. */
  parameters?: Record<string, string>;
  /** ISO language of the texts, e.g. ru. */
  language: string;
}

export interface DocEdit {
  startLine?: number;
  endLine?: number;
  replacement?: string;
  insertAfterLine?: number;
  insertion?: string;
  describe: string;
}

export interface DocPlan {
  /** Empty when the texts are already what was asked for. */
  edits: DocEdit[];
  /** The line the component is declared on, 1-based. */
  declaredAt: number;
  before: string[];
  after: string[];
}

const DECLARATION = /^\s*((?:class-)?methods|(?:class-)?data|constants|(?:class-)?events)\b/i;
const SHORT_TEXT = /<p\s+class\s*=\s*"shorttext synchronized"[^>]*>(.*?)<\/p>/i;

const quoteRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The code of a line without its comment, so the full stop of a statement shows. */
const code = (line: string): string => {
  const text = String(line ?? '');
  if (/^\s*\*/.test(text)) return '';
  const quote = text.indexOf('"');
  return quote >= 0 ? text.slice(0, quote) : text;
};

const isDocLine = (line: string): boolean => /^\s*"!/.test(line);

export function escapeDocText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeDocText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A short text as the tables hold it: one line, trimmed, at most 60 characters. */
export function checkedShortText(value: unknown, what: string): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new AbapDocError(`The short text of ${what} is empty.`);
  if (text.length > MAX_SHORT_TEXT) {
    throw new AbapDocError(`The short text of ${what} is ${text.length} characters; the table holds ${MAX_SHORT_TEXT}.`);
  }
  return text;
}

const shortTextParagraph = (text: string, language: string): string =>
  `<p class="shorttext synchronized" lang="${language.toLowerCase()}">${escapeDocText(text)}</p>`;

/** The ABAP Doc lines for a new declaration: its own text, then its parameters. */
export function abapDocLines(
  indent: string,
  language: string,
  description?: string,
  parameters: Array<{ name: string; text: string }> = []
): string[] {
  const lines: string[] = [];
  if (description) lines.push(`${indent}"! ${shortTextParagraph(description, language)}`);
  for (const parameter of parameters) {
    lines.push(`${indent}"! @parameter ${parameter.name.toLowerCase()} | ${shortTextParagraph(parameter.text, language)}`);
  }
  return lines;
}

/** The lines the declarations of a class or an interface are written in. */
function declarationRange(lines: string[], source: string): { from: number; to: number } {
  const interfaceStart = lines.findIndex(line => /^\s*interface\s+\S+(\s|\.|$)/i.test(code(line)) && !/\bdeferred\b|\bload\b/i.test(code(line)));
  const classStart = lines.findIndex(line => /^\s*class\s+\S+\s+definition\b/i.test(code(line)));
  if (classStart >= 0 && (interfaceStart < 0 || classStart < interfaceStart)) {
    const layout = readClassLayout(source);
    return { from: classStart + 2, to: layout.definitionEnd - 1 };
  }
  if (interfaceStart >= 0) {
    const end = lines.findIndex((line, i) => i > interfaceStart && /^\s*endinterface\s*\./i.test(code(line)));
    if (end < 0) throw new AbapDocError('The interface has no ENDINTERFACE.');
    return { from: interfaceStart + 2, to: end };
  }
  throw new AbapDocError('This source is neither a class nor an interface.');
}

interface Declaration {
  /** Line the ABAP Doc goes above, 1-based. */
  line: number;
  /** The statement the component is declared in. */
  start: number;
  end: number;
  keyword: string;
}

/** Where a component is declared, and the statement it is declared in. */
function findDeclaration(lines: string[], source: string, component: string): Declaration {
  const { from, to } = declarationRange(lines, source);
  const name = quoteRegex(component.toLowerCase());
  const own = new RegExp(`^\\s*(?:(?:class-)?(?:methods|data|events)|constants)\\s+${name}(\\s|\\.|$)`, 'i');
  const chainHead = new RegExp(`^\\s*(?:(?:class-)?(?:methods|data|events)|constants)\\s*:\\s*${name}(\\s|,|\\.|$)`, 'i');
  const entry = new RegExp(`^\\s*${name}(\\s|,|\\.|$)`, 'i');

  let start: number | undefined;
  for (let line = from; line <= to; line++) {
    const text = code(lines[line - 1]).trim();
    if (!text) continue;
    if (start === undefined) start = line;
    if (!/\.\s*$/.test(text)) continue;

    const first = code(lines[start - 1]);
    const keyword = DECLARATION.exec(first);
    if (keyword) {
      const found = { start, end: line, keyword: keyword[1].toLowerCase() };
      if (own.test(first)) return { line: start, ...found };
      if (chainHead.test(first)) {
        throw new AbapDocError(
          `${component.toUpperCase()} is declared on the same line as the colon of its chain (line ${start}). ABAP Doc for a chain entry goes on the line above the entry, so put the entry on a line of its own first.`
        );
      }
      // An entry of a chain opens a line of its own after the colon.
      if (/:/.test(first)) {
        for (let at = start + 1; at <= line; at++) {
          if (entry.test(code(lines[at - 1]))) return { line: at, ...found };
        }
      }
    }
    start = undefined;
  }
  throw new AbapDocError(
    `${component.toUpperCase()} is not declared here as a method, an attribute, a constant or an event.`
  );
}

/**
 * The edits that give one component (and its parameters) these short texts.
 * An ABAP Doc block above the declaration is kept: its short text line is
 * replaced, or a new one put first; a parameter line is replaced, or added at
 * the end of the block.
 */
export function planComponentTexts(source: string, spec: ComponentTexts): DocPlan {
  const lines = String(source ?? '').split(/\r\n|\n|\r/);
  const component = String(spec.component || '').trim();
  if (!component) throw new AbapDocError('Which component? Pass component.');
  const parameters = Object.entries(spec.parameters || {});
  if (spec.description === undefined && !parameters.length) {
    throw new AbapDocError('Pass description, parameters or both.');
  }
  const description = spec.description === undefined
    ? undefined
    : checkedShortText(spec.description, component.toUpperCase());

  const declaration = findDeclaration(lines, source, component);
  if (parameters.length && !/methods|events/.test(declaration.keyword)) {
    throw new AbapDocError(`${component.toUpperCase()} is not a method or an event, so it has no parameters.`);
  }
  const statement = lines.slice(declaration.start - 1, declaration.end).map(code).join(' ');
  const checkedParameters = parameters.map(([name, text]) => {
    const bare = String(name).trim().replace(/^!/, '');
    if (!new RegExp(`(^|[\\s!(,:])${quoteRegex(bare)}(?=[\\s).,]|$)`, 'i').test(statement)) {
      throw new AbapDocError(`${component.toUpperCase()} has no parameter ${bare.toUpperCase()}.`);
    }
    return { name: bare.toLowerCase(), text: checkedShortText(text, `parameter ${bare.toUpperCase()}`) };
  });

  // The ABAP Doc block is the run of "! lines right above the declaration.
  let blockStart = declaration.line;
  while (blockStart > 1 && isDocLine(lines[blockStart - 2])) blockStart--;
  const before = lines.slice(blockStart - 1, declaration.line - 1);
  const indent = /^(\s*)/.exec(lines[declaration.line - 1])![1];
  const after = [...before];

  if (description !== undefined) {
    const paragraph = shortTextParagraph(description, spec.language);
    const at = after.findIndex(line => !/@parameter|@raising|@exception/i.test(line) && SHORT_TEXT.test(line));
    if (at >= 0) {
      after[at] = after[at].replace(SHORT_TEXT, paragraph);
    } else if (after.some(line => /<p\s+class\s*=\s*"shorttext synchronized"/i.test(line) && !/@parameter/i.test(line))) {
      throw new AbapDocError(`The short text of ${component.toUpperCase()} runs over more than one line; change it with editObject.`);
    } else {
      after.unshift(`${indent}"! ${paragraph}`);
    }
  }

  for (const parameter of checkedParameters) {
    const paragraph = shortTextParagraph(parameter.text, spec.language);
    const own = new RegExp(`^(\\s*"!\\s*@parameter\\s+!?${quoteRegex(parameter.name)}\\s*\\|\\s*)(.*)$`, 'i');
    const at = after.findIndex(line => own.test(line));
    if (at < 0) {
      after.push(`${indent}"! @parameter ${parameter.name} | ${paragraph}`);
    } else if (SHORT_TEXT.test(after[at])) {
      after[at] = after[at].replace(SHORT_TEXT, paragraph);
    } else {
      after[at] = after[at].replace(own, (_m, head, rest) => `${head}${paragraph}${rest ? ` ${rest}` : ''}`);
    }
  }

  const same = after.length === before.length && after.every((line, i) => line === before[i]);
  const describe = `ABAP Doc of ${component.toUpperCase()}`;
  const edits: DocEdit[] = same
    ? []
    : before.length
      ? [{ startLine: blockStart, endLine: declaration.line - 1, replacement: after.join('\n'), describe }]
      : [{ insertAfterLine: declaration.line - 1, insertion: after.join('\n'), describe }];
  return { edits, declaredAt: declaration.line, before, after };
}

/** The short text an ABAP Doc block carries for the component itself. */
export function shortTextOf(block: string[]): string | undefined {
  for (const line of block) {
    if (/@parameter|@raising|@exception/i.test(line)) continue;
    const match = SHORT_TEXT.exec(line);
    if (match) return unescapeDocText(match[1]);
  }
  return undefined;
}
