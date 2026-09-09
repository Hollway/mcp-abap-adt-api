/**
 * Line diff of two whole texts, for comparing versions of one ABAP object.
 *
 * sourcePatch.buildDiff renders the edits it just applied - it knows the ranges
 * and never has to look for them. Two revisions read from the system share no
 * such knowledge: what changed has to be worked out from the texts themselves.
 *
 * The method is patience diff, not a plain LCS. An ABAP source is full of lines
 * that repeat - ENDIF., ENDMETHOD., blank lines - and a longest-common-
 * subsequence match happily pairs an ENDMETHOD from one method with an
 * ENDMETHOD from another, producing a diff that is technically minimal and
 * unreadable. Patience matches only lines that occur exactly once on each side,
 * so the anchors are real landmarks, and recurses into the gaps between them.
 *
 * The fallback for a gap with no unique line is a bounded LCS; a gap too large
 * for that is reported as one replaced block rather than left to run for
 * minutes on a 10,000-line report.
 */

/** How many cells of LCS table are acceptable before a block is called coarse. */
const MAX_LCS_CELLS = 1_000_000;

export type DiffOpType = 'equal' | 'delete' | 'insert' | 'replace';

export interface DiffOp {
  type: DiffOpType;
  /** 0-based, half-open ranges into the before/after line arrays. */
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  /** A block that was too large to diff line by line. */
  coarse?: boolean;
}

export interface DiffStats {
  added: number;
  removed: number;
  hunks: number;
  identical: boolean;
  /** True when some block was reported wholesale instead of line by line. */
  coarse: boolean;
}

export interface UnifiedDiff {
  diff: string;
  stats: DiffStats;
}

/** Split a text into lines, tolerating CRLF - ADT serves both. */
export const splitLines = (text: string): string[] => {
  const body = String(text ?? '');
  const lines = body.split(/\r\n|\n|\r/);
  // A text ending in a newline leaves a phantom empty last element; dropping it
  // keeps the line numbers equal to what an editor shows.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const pushOp = (ops: DiffOp[], op: DiffOp): void => {
  if (op.aEnd <= op.aStart && op.bEnd <= op.bStart) return;
  const last = ops[ops.length - 1];
  if (last && last.type === op.type && !last.coarse && !op.coarse
    && last.aEnd === op.aStart && last.bEnd === op.bStart) {
    last.aEnd = op.aEnd;
    last.bEnd = op.bEnd;
    return;
  }
  ops.push(op);
};

/** Change block for a range neither side can be matched inside. */
const changeOp = (aStart: number, aEnd: number, bStart: number, bEnd: number, coarse?: boolean): DiffOp => {
  const type: DiffOpType = aEnd > aStart && bEnd > bStart
    ? 'replace'
    : aEnd > aStart ? 'delete' : 'insert';
  return { type, aStart, aEnd, bStart, bEnd, ...(coarse ? { coarse: true } : {}) };
};

/** Lines occurring exactly once in both ranges, paired by content. */
function uniqueMatches(
  a: string[], aStart: number, aEnd: number,
  b: string[], bStart: number, bEnd: number
): Array<[number, number]> {
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  const firstA = new Map<string, number>();
  const firstB = new Map<string, number>();
  for (let i = aStart; i < aEnd; i++) {
    const line = a[i];
    countA.set(line, (countA.get(line) || 0) + 1);
    if (!firstA.has(line)) firstA.set(line, i);
  }
  for (let i = bStart; i < bEnd; i++) {
    const line = b[i];
    countB.set(line, (countB.get(line) || 0) + 1);
    if (!firstB.has(line)) firstB.set(line, i);
  }
  const pairs: Array<[number, number]> = [];
  for (const [line, n] of countA) {
    if (n !== 1 || countB.get(line) !== 1) continue;
    // A blank or whitespace-only line is not a landmark even when it happens
    // to be unique: matching on it drags unrelated hunks together.
    if (line.trim() === '') continue;
    pairs.push([firstA.get(line)!, firstB.get(line)!]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return pairs;
}

/** Longest increasing subsequence by the second element, keeping the pairs. */
function longestIncreasing(pairs: Array<[number, number]>): Array<[number, number]> {
  if (pairs.length === 0) return [];
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous: number[] = new Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const value = pairs[i][1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] < value) low = mid + 1; else high = mid;
    }
    tails[low] = value;
    tailIndex[low] = i;
    previous[i] = low > 0 ? tailIndex[low - 1] : -1;
    }
  const result: Array<[number, number]> = [];
  let index = tailIndex[tails.length - 1];
  while (index >= 0) {
    result.push(pairs[index]);
    index = previous[index];
  }
  return result.reverse();
}

/** Bounded LCS for a block with no unique line to anchor on. */
function lcsOps(
  a: string[], aStart: number, aEnd: number,
  b: string[], bStart: number, bEnd: number,
  ops: DiffOp[]
): void {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  if (n === 0 || m === 0) {
    pushOp(ops, changeOp(aStart, aEnd, bStart, bEnd));
    return;
  }
  if (n * m > MAX_LCS_CELLS) {
    pushOp(ops, changeOp(aStart, aEnd, bStart, bEnd, true));
    return;
  }
  // table[i][j] = length of the LCS of a[aStart+i..] and b[bStart+j..]
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[aStart + i] === b[bStart + j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aStart + i] === b[bStart + j]) {
      pushOp(ops, { type: 'equal', aStart: aStart + i, aEnd: aStart + i + 1, bStart: bStart + j, bEnd: bStart + j + 1 });
      i++; j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      pushOp(ops, changeOp(aStart + i, aStart + i + 1, bStart + j, bStart + j));
      i++;
    } else {
      pushOp(ops, changeOp(aStart + i, aStart + i, bStart + j, bStart + j + 1));
      j++;
    }
  }
  pushOp(ops, changeOp(aStart + i, aEnd, bStart + j, bEnd));
}

function diffRange(
  a: string[], aStart: number, aEnd: number,
  b: string[], bStart: number, bEnd: number,
  ops: DiffOp[]
): void {
  // Equal head and tail first: they are the bulk of any real comparison.
  while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
    pushOp(ops, { type: 'equal', aStart, aEnd: aStart + 1, bStart, bEnd: bStart + 1 });
    aStart++; bStart++;
  }
  const tail: DiffOp[] = [];
  while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
    tail.unshift({ type: 'equal', aStart: aEnd - 1, aEnd, bStart: bEnd - 1, bEnd });
    aEnd--; bEnd--;
  }

  if (aStart === aEnd || bStart === bEnd) {
    pushOp(ops, changeOp(aStart, aEnd, bStart, bEnd));
  } else {
    const anchors = longestIncreasing(uniqueMatches(a, aStart, aEnd, b, bStart, bEnd));
    if (anchors.length === 0) {
      lcsOps(a, aStart, aEnd, b, bStart, bEnd, ops);
    } else {
      let ai = aStart;
      let bi = bStart;
      for (const [aAnchor, bAnchor] of anchors) {
        diffRange(a, ai, aAnchor, b, bi, bAnchor, ops);
        pushOp(ops, { type: 'equal', aStart: aAnchor, aEnd: aAnchor + 1, bStart: bAnchor, bEnd: bAnchor + 1 });
        ai = aAnchor + 1;
        bi = bAnchor + 1;
      }
      diffRange(a, ai, aEnd, b, bi, bEnd, ops);
    }
  }

  for (const op of tail) pushOp(ops, op);
}

/** The operations that turn `before` into `after`. */
export function diffLines(before: string[], after: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  diffRange(before, 0, before.length, after, 0, after.length, ops);
  return ops;
}

/**
 * Unified diff of two texts, with line numbers a reader can act on: the left
 * numbers address the before version, the right ones the after version.
 */
export function unifiedDiff(
  beforeText: string,
  afterText: string,
  options: { context?: number; beforeLabel?: string; afterLabel?: string } = {}
): UnifiedDiff {
  const context = Math.max(0, Number.isFinite(options.context as number) ? Number(options.context) : 3);
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const ops = diffLines(before, after);

  let added = 0;
  let removed = 0;
  let coarse = false;
  for (const op of ops) {
    if (op.type === 'equal') continue;
    removed += op.aEnd - op.aStart;
    added += op.bEnd - op.bStart;
    if (op.coarse) coarse = true;
  }
  if (added === 0 && removed === 0) {
    return { diff: '', stats: { added: 0, removed: 0, hunks: 0, identical: true, coarse: false } };
  }

  // Group changes that are close enough to share context into one hunk.
  const changes = ops.map((op, index) => ({ op, index })).filter(entry => entry.op.type !== 'equal');
  const groups: Array<{ from: number; to: number }> = [];
  for (const { index } of changes) {
    const last = groups[groups.length - 1];
    if (last && index - last.to <= 1) { last.to = index; continue; }
    groups.push({ from: index, to: index });
  }

  const lines: string[] = [];
  const header: string[] = [];
  if (options.beforeLabel || options.afterLabel) {
    header.push(`--- ${options.beforeLabel || 'before'}`);
    header.push(`+++ ${options.afterLabel || 'after'}`);
  }

  for (const group of groups) {
    const first = ops[group.from];
    const last = ops[group.to];
    const aFrom = Math.max(0, first.aStart - context);
    const bFrom = Math.max(0, first.bStart - context);
    const aTo = Math.min(before.length, last.aEnd + context);
    const bTo = Math.min(after.length, last.bEnd + context);

    lines.push(`@@ -${aFrom + 1},${aTo - aFrom} +${bFrom + 1},${bTo - bFrom} @@`);
    for (let i = aFrom; i < first.aStart; i++) lines.push(` ${before[i]}`);
    for (let index = group.from; index <= group.to; index++) {
      const op = ops[index];
      if (op.type === 'equal') {
        for (let i = op.aStart; i < op.aEnd; i++) lines.push(` ${before[i]}`);
        continue;
      }
      if (op.coarse) {
        lines.push(`-... ${op.aEnd - op.aStart} lines, too large a block to diff line by line`);
        lines.push(`+... ${op.bEnd - op.bStart} lines`);
        continue;
      }
      for (let i = op.aStart; i < op.aEnd; i++) lines.push(`-${before[i]}`);
      for (let i = op.bStart; i < op.bEnd; i++) lines.push(`+${after[i]}`);
    }
    for (let i = last.aEnd; i < aTo; i++) lines.push(` ${before[i]}`);
  }

  return {
    diff: [...header, ...lines].join('\n'),
    stats: { added, removed, hunks: groups.length, identical: false, coarse }
  };
}
