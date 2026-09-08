/**
 * Apply small edits to an ABAP source text.
 *
 * ADT has no partial write: setObjectSource replaces the whole object, so a
 * sixteen-line change means re-uploading two thousand lines and hoping nothing
 * else moved. These helpers let the server do that arithmetic instead: the
 * caller says what to replace, the server reads the current source, applies the
 * edits and can show exactly which lines changed.
 *
 * Every position refers to the source as it was read. Edits are resolved to
 * character ranges first and applied from the end, so earlier edits cannot
 * shift the coordinates of later ones.
 */

export interface LineEdit {
  /** 1-based first line to replace. */
  startLine: number;
  /** 1-based last line to replace; defaults to startLine. */
  endLine?: number;
  /** Replacement text; '' deletes the lines. */
  replacement: string;
}

export interface TextEdit {
  /** Exact substring to replace. */
  anchor: string;
  replacement: string;
  /** Which occurrence to replace, 1-based. Required when the anchor repeats. */
  occurrence?: number;
}

export interface InsertEdit {
  /** Insert after this 1-based line; 0 inserts at the top of the file. */
  insertAfterLine: number;
  insertion: string;
}

export type SourceEdit = LineEdit | TextEdit | InsertEdit;

export interface ResolvedEdit {
  start: number;
  end: number;
  text: string;
  /** 1-based line range the edit covers in the original source. */
  firstLine: number;
  lastLine: number;
  /**
   * Whether the edit covers whole lines. A line replacement or deletion
   * does; an anchor edit changes part of a line, and its character range is
   * the only accurate description of what it removes.
   */
  wholeLines: boolean;
  /**
   * For a pure insertion: the line it goes after (0 = before the first line).
   * An insertion sits between two lines instead of replacing any, which a
   * diff has to describe differently.
   */
  insertAfter?: number;
  /**
   * The text starts with a newline that only terminates the line already
   * there - the case of inserting at the end of a file that does not end with
   * a newline. That newline adds no line of its own.
   */
  textClosesPreviousLine?: boolean;
  describe: string;
}

export class PatchError extends Error {}

const isLineEdit = (e: SourceEdit): e is LineEdit =>
  typeof (e as LineEdit).startLine === 'number';
const isTextEdit = (e: SourceEdit): e is TextEdit =>
  typeof (e as TextEdit).anchor === 'string';
const isInsertEdit = (e: SourceEdit): e is InsertEdit =>
  typeof (e as InsertEdit).insertAfterLine === 'number';

export const newlineOf = (source: string): string =>
  source.includes('\r\n') ? '\r\n' : '\n';

/** Character offset of the start of every line, plus the total length. */
const lineOffsets = (source: string, nl: string): number[] => {
  const offsets = [0];
  let at = 0;
  while (true) {
    const next = source.indexOf(nl, at);
    if (next < 0) break;
    at = next + nl.length;
    offsets.push(at);
  }
  return offsets;
};

const lineOfOffset = (offsets: number[], offset: number): number => {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

export function resolveEdits(source: string, edits: SourceEdit[]): ResolvedEdit[] {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new PatchError('No edits given.');
  }
  const nl = newlineOf(source);
  const offsets = lineOffsets(source, nl);
  const lineCount = offsets.length;
  const resolved: ResolvedEdit[] = [];

  const lineStart = (line: number) => offsets[line - 1];
  const lineEndExclusive = (line: number) =>
    line < lineCount ? offsets[line] : source.length;

  for (const edit of edits) {
    if (isLineEdit(edit)) {
      const first = edit.startLine;
      const last = edit.endLine ?? edit.startLine;
      if (!Number.isInteger(first) || !Number.isInteger(last)) {
        throw new PatchError('startLine and endLine must be whole numbers.');
      }
      if (first < 1 || first > lineCount) {
        throw new PatchError(`startLine ${first} is outside the source (1..${lineCount}).`);
      }
      if (last < first || last > lineCount) {
        throw new PatchError(`endLine ${last} must be between startLine and ${lineCount}.`);
      }
      if (typeof edit.replacement !== 'string') {
        throw new PatchError('replacement must be a string (use "" to delete the lines).');
      }
      // The range covers the line contents without the trailing newline, so a
      // replacement is spliced in place. A deletion has to swallow a newline as
      // well, otherwise removing a line would leave an empty one behind - the
      // following line's newline normally, the preceding one for the last line.
      const deleting = edit.replacement.length === 0;
      let start = lineStart(first);
      let end = last < lineCount ? lineEndExclusive(last) - nl.length : source.length;
      if (deleting) {
        if (last < lineCount) end += nl.length;
        else if (first > 1) start -= nl.length;
      }
      resolved.push({
        start,
        end,
        text: edit.replacement.replace(/\r?\n/g, nl),
        firstLine: first,
        lastLine: last,
        wholeLines: true,
        describe: first === last ? `line ${first}` : `lines ${first}-${last}`
      });
      continue;
    }

    if (isInsertEdit(edit)) {
      const after = edit.insertAfterLine;
      if (!Number.isInteger(after) || after < 0 || after > lineCount) {
        throw new PatchError(`insertAfterLine ${after} is outside the source (0..${lineCount}).`);
      }
      if (typeof edit.insertion !== 'string') {
        throw new PatchError('insertion must be a string.');
      }
      const at = after === 0 ? 0 : lineEndExclusive(after);
      const body = edit.insertion.replace(/\r?\n/g, nl);
      // At the end of a file that does not end with a newline, the insertion
      // needs one in front of it; nothing is ever appended after it, or the
      // file would grow a trailing empty line.
      const atEnd = at === source.length;
      const needsLeadingNl = after > 0 && atEnd && !source.endsWith(nl);
      resolved.push({
        start: at,
        end: at,
        text: (needsLeadingNl ? nl : '') + body + (atEnd ? '' : nl),
        firstLine: after === 0 ? 1 : after,
        lastLine: after === 0 ? 1 : after,
        wholeLines: false,
        insertAfter: after,
        textClosesPreviousLine: needsLeadingNl,
        describe: after === 0 ? 'before line 1' : `after line ${after}`
      });
      continue;
    }

    if (isTextEdit(edit)) {
      if (!edit.anchor) throw new PatchError('anchor must not be empty.');
      if (typeof edit.replacement !== 'string') {
        throw new PatchError('replacement must be a string.');
      }
      // ADT serves this system's sources with CRLF line ends, and an anchor is
      // typed with plain newlines - matching it literally made every
      // multi-line anchor "not found". The anchor is translated to the
      // source's own line ending, exactly as replacements already are.
      const anchor = edit.anchor.replace(/\r?\n/g, nl);
      const positions: number[] = [];
      let at = source.indexOf(anchor);
      while (at >= 0) {
        positions.push(at);
        at = source.indexOf(anchor, at + anchor.length);
      }
      if (positions.length === 0) {
        throw new PatchError(`anchor not found: ${JSON.stringify(edit.anchor.slice(0, 80))}`);
      }
      if (positions.length > 1 && edit.occurrence === undefined) {
        throw new PatchError(
          `anchor matches ${positions.length} times; pass occurrence (1..${positions.length}) or extend the anchor.`
        );
      }
      const index = (edit.occurrence ?? 1) - 1;
      if (index < 0 || index >= positions.length) {
        throw new PatchError(`occurrence must be between 1 and ${positions.length}.`);
      }
      const start = positions[index];
      const end = start + anchor.length;
      resolved.push({
        start,
        end,
        text: edit.replacement.replace(/\r?\n/g, nl),
        firstLine: lineOfOffset(offsets, start),
        lastLine: lineOfOffset(offsets, Math.max(start, end - 1)),
        wholeLines: false,
        describe: `anchor at line ${lineOfOffset(offsets, start)}`
      });
      continue;
    }

    throw new PatchError(
      'Each edit needs startLine (+ optional endLine), anchor, or insertAfterLine.'
    );
  }

  const ordered = [...resolved].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new PatchError(
        `Edits overlap: ${ordered[i - 1].describe} and ${ordered[i].describe}.`
      );
    }
  }
  return ordered;
}

/** Apply resolved edits from the end so earlier ones keep their offsets. */
export function applyEdits(source: string, resolved: ResolvedEdit[]): string {
  let out = source;
  for (const edit of [...resolved].reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * A unified-diff-style hunk per edit, with context. Built from the known ranges
 * rather than by diffing the whole file, so it is exact and cheap.
 */
export function buildDiff(
  source: string,
  resolved: ResolvedEdit[],
  context = 3
): string {
  const nl = newlineOf(source);
  const before = source.split(nl);
  const hunks: string[] = [];

  /**
   * Lines of a chunk of text, without the phantom empty element that split()
   * leaves when the text ends with a newline. An insertion carries its own
   * trailing newline and a deletion swallows one, so without this the diff
   * showed an added or removed blank line that never existed - which makes the
   * whole diff untrustworthy, and the hunk counts wrong with it.
   */
  const chunkLines = (text: string): string[] => {
    const parts = text.split(nl);
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };

  for (const edit of resolved) {
    // A deletion swallows a newline - the one after the range, or the one
    // before it for the last line of the file - so the character range is a
    // poor description of which lines went away. For whole-line edits take
    // the lines themselves.
    const removed = edit.end <= edit.start
      ? []
      : edit.wholeLines
        ? before.slice(edit.firstLine - 1, edit.lastLine)
        : chunkLines(source.slice(edit.start, edit.end));

    const added = edit.text.length > 0 ? chunkLines(edit.text) : [];
    // Inserting at the end of a file that does not end with a newline needs a
    // leading newline, but that newline only terminates the line already
    // there - it adds no line of its own and must not appear as one.
    if (edit.textClosesPreviousLine && added[0] === '') added.shift();

    // A pure insertion sits between two lines rather than replacing any, so
    // the line it follows belongs to the context before it - the old code
    // stopped one line short and dropped it from the hunk entirely.
    const isInsert = edit.insertAfter !== undefined;
    const contextEnd = isInsert ? edit.insertAfter! : edit.firstLine - 1;
    const contextStart = isInsert ? edit.insertAfter! + 1 : edit.lastLine + 1;
    const from = Math.max(1, (isInsert ? edit.insertAfter! : edit.firstLine) - context);
    const to = Math.min(before.length, contextStart + context - 1);

    const header = isInsert
      // unified-diff convention for an insertion after line N: -N,0 +N+1,count
      ? `@@ -${edit.insertAfter},0 +${edit.insertAfter! + 1},${added.length} @@ ${edit.describe}`
      : `@@ -${edit.firstLine},${removed.length} +${edit.firstLine},${added.length} @@ ${edit.describe}`;

    const lines: string[] = [header];
    for (let i = from; i <= contextEnd; i++) lines.push(` ${before[i - 1]}`);
    for (const line of removed) lines.push(`-${line}`);
    for (const line of added) lines.push(`+${line}`);
    for (let i = contextStart; i <= to; i++) lines.push(` ${before[i - 1]}`);
    hunks.push(lines.join('\n'));
  }

  return hunks.join('\n');
}
