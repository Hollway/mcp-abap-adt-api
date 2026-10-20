/**
 * The code a graph answer shows: the member itself, or the block around the
 * place that makes a reference - never the whole source.
 *
 * The where-used index knows the include of a reference, not its line. For a
 * method or a function module that is enough - the include is the member. For
 * a program include or a class's local implementations the line is found by
 * looking for the target's name, and the block around it (METHOD, FORM,
 * MODULE, FUNCTION) is what gets shown.
 */

/** ADT addresses of the sources a graph node can live in. */
export function sourceUrlOf(node: {
  objectType: string;
  object: string;
  member?: string | null;
  part?: string;
  include?: string;
  subc?: string | null;
}): string | undefined {
  const lower = (name: string) => encodeURIComponent(name.toLowerCase());
  switch (node.objectType) {
    case 'CLAS': {
      const base = `/sap/bc/adt/oo/classes/${lower(node.object)}`;
      switch (node.part) {
        case 'CCIMP': return `${base}/includes/implementations`;
        case 'CCDEF': return `${base}/includes/definitions`;
        case 'CCMAC': return `${base}/includes/macros`;
        case 'CCAU': return `${base}/includes/testclasses`;
        default: return `${base}/source/main`;
      }
    }
    case 'INTF':
      return `/sap/bc/adt/oo/interfaces/${lower(node.object)}/source/main`;
    case 'FUGR':
      if (node.member) return `/sap/bc/adt/functions/groups/${lower(node.object)}/fmodules/${lower(node.member)}/source/main`;
      if (node.include && node.include !== `SAPL${node.object}`) {
        return `/sap/bc/adt/functions/groups/${lower(node.object)}/includes/${lower(node.include)}/source/main`;
      }
      return undefined;
    case 'PROG':
      return node.subc === 'I'
        ? `/sap/bc/adt/programs/includes/${lower(node.object)}/source/main`
        : `/sap/bc/adt/programs/programs/${lower(node.object)}/source/main`;
    default:
      return undefined;
  }
}

export interface CodeBlock {
  /** What the block is: METHOD get_bukrs, FORM read_data, or the include when no block encloses the lines. */
  title: string;
  /** First and last line of the block, 1-based. */
  from: number;
  to: number;
  /** Lines in the block that name the target. */
  hits: number[];
  code: string;
  /** Lines left out of a block longer than the limit. */
  omitted?: number;
}

const isComment = (line: string) => /^\s*\*/.test(line) || /^\s*"/.test(line);
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

const BLOCK_START = /^\s*(METHOD|FORM|MODULE|FUNCTION)\s+([^\s.]+)/i;
const BLOCK_END: Record<string, RegExp> = {
  METHOD: /^\s*ENDMETHOD\s*\./i,
  FORM: /^\s*ENDFORM\s*\./i,
  MODULE: /^\s*ENDMODULE\s*\./i,
  FUNCTION: /^\s*ENDFUNCTION\s*\./i
};

/**
 * Lines that name an identifier as a word - so get_bukrs does not hit
 * get_bukrs_list - case-insensitively, skipping comments.
 */
export function linesNaming(lines: string[], name: string): number[] {
  const bare = name.split(/=>|~|->/).pop() || name;
  const word = new RegExp(`(^|[^A-Za-z0-9_/])${escapeRegex(bare)}($|[^A-Za-z0-9_/])`, 'i');
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (!isComment(line) && word.test(line)) hits.push(index);
  });
  return hits;
}

/** The block that encloses a line: the nearest opening statement above it whose end lies below it. */
function enclosing(lines: string[], index: number): { start: number; end: number; title: string } | undefined {
  for (let start = index; start >= 0; start--) {
    const match = BLOCK_START.exec(lines[start]);
    if (!match) continue;
    const keyword = match[1].toUpperCase();
    const endPattern = BLOCK_END[keyword];
    for (let end = start + 1; end < lines.length; end++) {
      if (endPattern.test(lines[end])) {
        return end >= index ? { start, end, title: `${keyword} ${match[2].toLowerCase()}` } : undefined;
      }
    }
    return undefined;
  }
  return undefined;
}

/** A block's text, cut down to the head, the hit lines with a little context, and the end when it is long. */
function render(lines: string[], start: number, end: number, hits: number[], maxLines: number): { code: string; omitted?: number } {
  const total = end - start + 1;
  if (total <= maxLines) return { code: lines.slice(start, end + 1).join('\n') };
  const keep = new Set<number>();
  for (let i = start; i < Math.min(start + 3, end + 1); i++) keep.add(i);
  keep.add(end);
  const context = 3;
  for (const hit of hits) {
    for (let i = Math.max(start, hit - context); i <= Math.min(end, hit + context); i++) keep.add(i);
    if (keep.size >= maxLines) break;
  }
  const out: string[] = [];
  let skipped = 0;
  let omitted = 0;
  for (let i = start; i <= end; i++) {
    if (keep.has(i)) {
      if (skipped > 0) out.push(`    " ... ${skipped} line(s) left out`);
      skipped = 0;
      out.push(lines[i]);
    } else {
      skipped += 1;
      omitted += 1;
    }
  }
  return { code: out.join('\n'), omitted };
}

/** Where one method's implementation lies in a class source: 0-based first and last line. */
export function methodLines(lines: string[], method: string): { from: number; to: number } | undefined {
  const start = new RegExp(`^\\s*METHOD\\s+${escapeRegex(method)}\\s*\\.`, 'i');
  const from = lines.findIndex(line => start.test(line));
  if (from < 0) return undefined;
  let to = from + 1;
  while (to < lines.length && !BLOCK_END.METHOD.test(lines[to])) to++;
  return { from, to: Math.min(to, lines.length - 1) };
}

/** The implementation of one method in a class source, by name (interface methods as zif_x~meth). */
export function methodBlock(source: string, method: string, maxLines = 150, target?: string): CodeBlock | undefined {
  const lines = source.split(/\r?\n/);
  const range = methodLines(lines, method);
  if (!range) return undefined;
  const { from, to } = range;
  const hits = target ? linesNaming(lines, target).filter(line => line > from && line <= to) : [];
  const rendered = render(lines, from, to, hits, maxLines);
  return {
    title: `METHOD ${method.toLowerCase()}`,
    from: from + 1,
    to: to + 1,
    hits: hits.map(line => line + 1),
    ...rendered
  };
}

/**
 * The blocks of a source that name the target - each enclosing block once,
 * a window of lines where no block encloses the hit (a report's main code).
 */
export function blocksNaming(source: string, target: string, maxBlocks = 3, maxLines = 80): CodeBlock[] {
  const lines = source.split(/\r?\n/);
  const hits = linesNaming(lines, target);
  const blocks: CodeBlock[] = [];
  const covered = new Set<number>();
  for (const hit of hits) {
    if (covered.has(hit)) continue;
    if (blocks.length >= maxBlocks) break;
    const block = enclosing(lines, hit);
    const start = block ? block.start : Math.max(0, hit - 5);
    const end = block ? block.end : Math.min(lines.length - 1, hit + 5);
    const inside = hits.filter(line => line >= start && line <= end);
    inside.forEach(line => covered.add(line));
    blocks.push({
      title: block ? block.title : 'lines',
      from: start + 1,
      to: end + 1,
      hits: inside.map(line => line + 1),
      ...render(lines, start, end, inside, maxLines)
    });
  }
  return blocks;
}
