/**
 * Reading ABAP source as text: search and outline.
 *
 * ADT can locate a class method by fragment type, and nothing else. A FORM of
 * a report, a MODULE, an event block or a plain statement has no fragment
 * type - asking for one has been answered with 400 and 500, and a rejected
 * fragment request is one of the ways an ADT session dies. Meanwhile the
 * source itself is one cheap read away, so the honest way to find something in
 * a two-thousand-line report is to read it and look.
 *
 * Everything here is pure text work on a source string: no client, no session.
 */

/** One matching line, with optional surrounding lines. */
export interface SourceMatch {
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface FindOptions {
  pattern: string;
  regex?: boolean;
  ignoreCase?: boolean;
  contextLines?: number;
  maxMatches?: number;
  /** Skip comment lines, which is usually what a search for code wants. */
  skipComments?: boolean;
}

export interface FindResult {
  matches: SourceMatch[];
  totalMatches: number;
  truncated: boolean;
  totalLines: number;
}

export class ScanError extends Error {}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a line is a comment.
 *
 * ABAP has two: a `*` in the very first column comments out the whole line,
 * and a `"` starts a comment that runs to the end of the line. A line whose
 * code part is only whitespace is a comment for our purposes.
 */
export const isCommentLine = (line: string): boolean => {
  if (line.startsWith('*')) return true;
  return line.trim().length > 0 && codeOf(line).trim().length === 0;
};

/**
 * The code part of a line: the trailing `"` comment removed, quotes respected.
 *
 * A `"` inside a character literal is not a comment, and `''` is how a literal
 * escapes its own quote - both matter, because ABAP is full of texts with
 * inches, and mistaking one for a comment would hide real code.
 */
export const codeOf = (line: string): string => {
  if (line.startsWith('*')) return '';
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      inLiteral = !inLiteral;
    } else if (ch === '"' && !inLiteral) {
      return line.slice(0, i);
    }
  }
  return line;
};

/** Search a source text line by line. */
export function findInSource(source: string, options: FindOptions): FindResult {
  const {
    pattern,
    regex = false,
    ignoreCase = true,
    contextLines = 0,
    maxMatches = 200,
    skipComments = false
  } = options;

  if (!pattern) throw new ScanError('pattern must not be empty.');

  let matcher: RegExp;
  try {
    matcher = new RegExp(regex ? pattern : escapeRegExp(pattern), ignoreCase ? 'i' : '');
  } catch (error: any) {
    throw new ScanError(`pattern is not a valid regular expression: ${error?.message}`);
  }

  const lines = source.split(/\r?\n/);
  const matches: SourceMatch[] = [];
  let totalMatches = 0;

  lines.forEach((line, index) => {
    const haystack = skipComments ? codeOf(line) : line;
    if (!matcher.test(haystack)) return;

    totalMatches += 1;
    if (matches.length >= maxMatches) return;

    const match: SourceMatch = { line: index + 1, text: line };
    if (contextLines > 0) {
      const before = lines.slice(Math.max(0, index - contextLines), index);
      const after = lines.slice(index + 1, index + 1 + contextLines);
      if (before.length) match.before = before;
      if (after.length) match.after = after;
    }
    matches.push(match);
  });

  return {
    matches,
    totalMatches,
    truncated: totalMatches > matches.length,
    totalLines: lines.length
  };
}

/** One declaration found in the source. */
export interface OutlineEntry {
  kind: string;
  name: string;
  line: number;
}

/**
 * The statements worth listing. Order matters: the first pattern that matches
 * a line wins, so `CLASS ... IMPLEMENTATION` must come before plain `CLASS`.
 */
const OUTLINE_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'REPORT', re: /^\s*(?:REPORT|PROGRAM)\s+([\w\/]+)/i },
  { kind: 'FUNCTION-POOL', re: /^\s*FUNCTION-POOL\s+([\w\/]+)/i },
  { kind: 'INCLUDE', re: /^\s*INCLUDE\s+([\w\/]+)\s*(?:IF\s+FOUND\s*)?\./i },
  { kind: 'CLASS-DEFINITION', re: /^\s*CLASS\s+([\w\/]+)\s+DEFINITION/i },
  { kind: 'CLASS-IMPLEMENTATION', re: /^\s*CLASS\s+([\w\/]+)\s+IMPLEMENTATION/i },
  { kind: 'INTERFACE', re: /^\s*INTERFACE\s+([\w\/~]+)\s*(?:PUBLIC)?\s*\./i },
  { kind: 'METHOD', re: /^\s*METHOD\s+([\w\/~]+)\s*\./i },
  { kind: 'FORM', re: /^\s*FORM\s+([\w\/]+)/i },
  { kind: 'MODULE', re: /^\s*MODULE\s+([\w\/]+)/i },
  { kind: 'FUNCTION', re: /^\s*FUNCTION\s+([\w\/]+)\s*\./i },
  { kind: 'EVENT', re: /^\s*(START-OF-SELECTION|END-OF-SELECTION|INITIALIZATION|LOAD-OF-PROGRAM|TOP-OF-PAGE|END-OF-PAGE)\s*\./i },
  { kind: 'EVENT', re: /^\s*(AT\s+SELECTION-SCREEN[\w\s-]*|AT\s+LINE-SELECTION|AT\s+USER-COMMAND)\s*\./i }
];

/**
 * Table of contents of a source: the blocks a developer navigates by.
 *
 * Text scanning, not parsing - a statement split over several lines is found
 * by its first line, which is exactly what a jump target needs to be.
 */
export function outlineSource(source: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = codeOf(raw);
    if (!line.trim()) return;
    for (const { kind, re } of OUTLINE_PATTERNS) {
      const match = line.match(re);
      if (match) {
        entries.push({
          kind,
          name: match[1].replace(/\s+/g, ' ').toUpperCase(),
          line: index + 1
        });
        return;
      }
    }
  });
  return entries;
}

/** Includes a program pulls in, in the order they appear. */
export function includedPrograms(source: string): string[] {
  const names = outlineSource(source)
    .filter(e => e.kind === 'INCLUDE')
    .map(e => e.name);
  return [...new Set(names)];
}

/** Source URL of a report include. */
export const includeSourceUrl = (name: string): string =>
  `/sap/bc/adt/programs/includes/${encodeURIComponent(name.toLowerCase())}/source/main`;
