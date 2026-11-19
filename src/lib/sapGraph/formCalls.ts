/**
 * Who calls a subroutine of a report.
 *
 * The where-used index (CROSS) records PERFORM only when it names another
 * program - PERFORM form IN PROGRAM zother. A report calling its own FORM,
 * which is nearly every call, is not recorded at all (on a large ERP system:
 * some forty rows of the kind, none of them usable). So the graph cannot
 * answer it, and saying "no callers" would be wrong. What the graph does
 * know is which includes make up the report (D010INC); those are read -
 * through the same source cache as the rest of the answers - and searched for
 * PERFORM form.
 */
import { blocksAt, blockTitleAt, formBlock, performLines, sourceUrlOf, CodeBlock } from './source';
import type { GraphStore } from './store';

export interface FormCallSite {
  include: string;
  /** 1-based lines with the PERFORM. */
  lines: number[];
  /** The block the call is made from: FORM other, MODULE x, METHOD y. */
  within: string[];
  url: string;
  blocks?: CodeBlock[];
}

export interface FormCallsResult {
  definedIn?: { include: string; line: number; url: string; block?: CodeBlock };
  sites: FormCallSite[];
  /** Includes read and searched. */
  scanned: number;
  /** Includes left unread over the limit. */
  notScanned: number;
  failed: { include: string; error: string }[];
}

export interface FormCallsDeps {
  store: GraphStore;
  read(url: string): Promise<string>;
}

export interface FormCallsOptions {
  /** Includes to read at most, the report itself counted. */
  maxIncludes: number;
  /** Call sites whose code is attached. 0 attaches none, and no definition block either. */
  maxBlocks: number;
}

/**
 * The report and the program includes it is made of, the report first.
 * D010INC also lists the sections of every class the report uses
 * (ZCL_X=====CU) and function group includes; no FORM of the report lives
 * there, so they are not read.
 */
export function includesOfReport(store: Pick<GraphStore, 'includesOf' | 'includeRow'>, program: string): string[] {
  const own = store.includesOf(program).filter(include => {
    if (include === program || include.startsWith('<')) return false;
    const row = store.includeRow(include);
    return row ? row.objectType === 'PROG' : !include.includes('=');
  });
  return [program, ...own.sort()];
}

export async function formCalls(program: string, form: string, deps: FormCallsDeps, options: FormCallsOptions): Promise<FormCallsResult> {
  const all = includesOfReport(deps.store, program);
  const toRead = all.slice(0, Math.max(1, options.maxIncludes));
  const result: FormCallsResult = { sites: [], scanned: 0, notScanned: all.length - toRead.length, failed: [] };

  for (const include of toRead) {
    const row = deps.store.includeRow(include);
    const subc = row?.subc ?? (include === program ? '1' : 'I');
    const url = sourceUrlOf({ objectType: 'PROG', object: include, subc })!;
    let source: string;
    try {
      source = await deps.read(url);
    } catch (error: any) {
      result.failed.push({ include, error: String(error?.message || error) });
      continue;
    }
    result.scanned += 1;
    const lines = source.split(/\r?\n/);

    if (!result.definedIn) {
      const block = formBlock(lines, form, 150);
      if (block) {
        result.definedIn = { include, line: block.from, url, ...(options.maxBlocks > 0 ? { block } : {}) };
      }
    }

    const hits = performLines(lines, form, program);
    if (hits.length === 0) continue;
    const within = [...new Set(hits.map(hit => blockTitleAt(lines, hit) || 'main code'))];
    const site: FormCallSite = { include, lines: hits.map(hit => hit + 1), within, url };
    if (result.sites.length < options.maxBlocks) site.blocks = blocksAt(lines, hits, 2, 60);
    result.sites.push(site);
  }
  return result;
}
