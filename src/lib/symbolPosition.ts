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

/** ADT source URL of a class or interface, from its name. */
export const classSourceUrl = (name: string): string =>
  `/sap/bc/adt/oo/classes/${encodeURIComponent(name.trim().toLowerCase())}/source/main`;

export const interfaceSourceUrl = (name: string): string =>
  `/sap/bc/adt/oo/interfaces/${encodeURIComponent(name.trim().toLowerCase())}/source/main`;

/** The object URL a source URL belongs to - what lock and usageReferences take. */
export const objectUrlOf = (sourceUrl: string): string =>
  sourceUrl.split('#')[0].replace(/\/source\/main$/, '').replace(/\/source$/, '');
