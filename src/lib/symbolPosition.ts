/**
 * Where a name sits in an ABAP source.
 *
 * Several ADT calls do not take a name at all: typeHierarchy, usageReferences
 * and findDefinition want a line and a column inside the source, because the
 * backend resolves whatever the cursor is on. Asking a caller to count columns
 * in a source it has not read is how those tools stayed unused, so the
 * position is worked out here from the name.
 *
 * Lines are 1-based and columns 0-based, which is what ADT's own
 * `uri#start=line,column` fragment uses.
 */
import { isCommentLine, codeOf } from './sourceScan';

export interface SymbolPosition {
  line: number;
  column: number;
  endColumn: number;
  /** The line the name was found on, for the answer to quote. */
  lineText: string;
  /** Which occurrence answered: the declaration or the implementation. */
  kind: 'definition' | 'declaration' | 'implementation';
}

const NEWLINES = /\r\n|\r|\n/;

/** Position of `name` inside `line`, as a word rather than a substring. */
const wordAt = (line: string, name: string): number => {
  const lower = line.toLowerCase();
  const wanted = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(wanted, from);
    if (at < 0) return -1;
    const before = at === 0 ? '' : line[at - 1];
    const after = line[at + wanted.length] || '';
    const isWordChar = (c: string) => c !== '' && /[A-Za-z0-9_/]/.test(c);
    if (!isWordChar(before) && !isWordChar(after)) return at;
    from = at + wanted.length;
  }
};

interface Candidate {
  pattern: RegExp;
  kind: SymbolPosition['kind'];
}

/**
 * First line whose code (comments stripped) matches one of the patterns and
 * also carries the name as a word. The patterns are tried in order, so a
 * declaration is preferred over an implementation.
 */
const locate = (
  source: string,
  name: string,
  candidates: Candidate[]
): SymbolPosition | undefined => {
  const lines = source.split(NEWLINES);
  for (const { pattern, kind } of candidates) {
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (isCommentLine(text)) continue;
      const code = codeOf(text);
      if (!pattern.test(code)) continue;
      const column = wordAt(code, name);
      if (column < 0) continue;
      return {
        line: i + 1,
        column,
        endColumn: column + name.length,
        lineText: text,
        kind
      };
    }
  }
  return undefined;
};

const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`);

/** The CLASS or INTERFACE statement that declares this type. */
export const locateType = (source: string, name: string): SymbolPosition | undefined =>
  locate(source, name, [
    { pattern: new RegExp(`^\\s*(CLASS|INTERFACE)\\s+${escaped(name)}\\b`, 'i'), kind: 'definition' }
  ]);

/**
 * The method with this name: its declaration if the source has one, otherwise
 * the METHOD block that implements it.
 *
 * The declaration comes first on purpose - ADT answers a where-used on the
 * declaration with every caller, while the implementation position is really
 * "the method's own body".
 */
export const locateMethod = (source: string, name: string): SymbolPosition | undefined =>
  locate(source, name, [
    {
      pattern: new RegExp(`^\\s*(CLASS-)?METHODS\\s+(${escaped(name)})\\b`, 'i'),
      kind: 'declaration'
    },
    // A chained declaration lists the names on their own lines, under a bare
    // METHODS: - the name is then the whole statement fragment.
    {
      pattern: new RegExp(`^\\s*${escaped(name)}\\s*($|[,.]|IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING|FOR |ABSTRACT|FINAL|REDEFINITION)`, 'i'),
      kind: 'declaration'
    },
    {
      pattern: new RegExp(`^\\s*METHOD\\s+${escaped(name)}\\s*\\.`, 'i'),
      kind: 'implementation'
    }
  ]);

/**
 * What a cursor position points at in the source the caller is sending.
 *
 * Every position-taking call was a pass-through, and the backend answers a
 * wrong position without saying it was wrong. Measured on a classic ERP
 * system, against CL_ABAP_TYPEDESCR:
 *
 *  - a line counted from 0 instead of 1 answered confidently about a
 *    different class (CL_ABAP_INTFDESCR for CL_ABAP_ELEMDESCR);
 *  - a cursor on blank space answered `{url: "", line: 0, column: 0}` with
 *    status success;
 *  - a line past the end of the source answered HTTP 500;
 *  - codeCompletion answered `[]` for both, which reads like "nothing may be
 *    written here" rather than "you are not pointing at the source".
 *
 * The source is already a required argument of all of these, so the position
 * can be checked against it before a call is spent, and the name under the
 * cursor can be handed back for the caller to recognise.
 */
export interface CursorAt {
  /** The line, quoted so a caller can see what it pointed at. */
  lineText: string;
  /** The identifier under the cursor, when it is on one. */
  token?: string;
  /** Why the position is not usable, when it is not. */
  problem?: string;
  /**
   * The position is not in the source at all, as opposed to merely not on a
   * name. Completion is asked at blank positions all the time - that is what
   * completing is - so only the first of the two is always an error.
   */
  outside?: boolean;
}

/** ABAP names carry underscores, slashes and the interface tilde. */
const NAME_CHAR = /[A-Za-z0-9_/~]/;

export const cursorAt = (source: string, line: number, column: number): CursorAt => {
  const lines = String(source ?? '').split(NEWLINES);
  if (!Number.isFinite(line) || line < 1 || line > lines.length) {
    return {
      lineText: '',
      outside: true,
      problem: `Line ${line} is outside the source you passed, which has ${lines.length} lines. Lines count from 1.`
    };
  }
  const lineText = lines[line - 1];
  if (!Number.isFinite(column) || column < 0 || column > lineText.length) {
    return {
      lineText,
      outside: true,
      problem: `Column ${column} is outside line ${line}, which is ${lineText.length} characters long. Columns count from 0.`
    };
  }
  // A cursor sitting just after a name belongs to it, the way an editor caret
  // does - so look left as well as right.
  let start = column;
  while (start > 0 && NAME_CHAR.test(lineText[start - 1])) start--;
  let end = column;
  while (end < lineText.length && NAME_CHAR.test(lineText[end])) end++;
  if (end === start) {
    return {
      lineText,
      problem: `Column ${column} of line ${line} is not on a name. The line reads: ${JSON.stringify(lineText)}`
    };
  }
  return { lineText, token: lineText.slice(start, end) };
};

/** ADT source URL of a class or interface, from its name. */
export const classSourceUrl = (name: string): string =>
  `/sap/bc/adt/oo/classes/${encodeURIComponent(name.trim().toLowerCase())}/source/main`;

export const interfaceSourceUrl = (name: string): string =>
  `/sap/bc/adt/oo/interfaces/${encodeURIComponent(name.trim().toLowerCase())}/source/main`;

/** The object URL a source URL belongs to - what lock and usageReferences take. */
export const objectUrlOf = (sourceUrl: string): string =>
  sourceUrl.split('#')[0].replace(/\/source\/main$/, '').replace(/\/source$/, '');
