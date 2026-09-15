/**
 * Where-used answers, cut to a size a caller can read.
 *
 * The backend has no paging here: one call answers with the whole tree, and
 * the tree is enormous. Measured on a classic ERP system, CL_ABAP_TYPEDESCR
 * answers with 40,660 rows and 21,075,252 characters - a hundred times the
 * response cap, so the tool could only ever hand back a truncated blob. Even
 * a class picked for being rarely used, CL_ABAP_GZIP, answers with 542 rows
 * and 256,575 characters, also past the cap.
 *
 * Two things make that payload so large, and both are dealt with here:
 *
 *  - every row carries ADT bookkeeping - who is responsible, the description,
 *    the package URI - which averages some 500 characters per row against the
 *    hundred or so that say anything. Rows are trimmed to what identifies the
 *    place and what the next call needs;
 *  - the rows are a tree flattened into a list: one row per package, one per
 *    object, one per include, and only some of them are usage sites. The ones
 *    that are carry an objectIdentifier, and usageReferenceSnippets silently
 *    drops every row without one - so those rows are counted, can be asked
 *    for on their own, and are never mistaken for the whole answer.
 *
 * The fetch itself is not made cheaper by any of this: the backend still
 * sends the whole tree and this server still parses it. What is saved is the
 * context of whoever asked.
 */
import type { UsageReference } from 'abap-adt-api';

export interface UsageRow {
  name?: string;
  type?: string;
  package?: string;
  uri?: string;
  /** What usageReferenceSnippets needs; absent on the grouping rows. */
  objectIdentifier?: string;
  /** How the backend graded the usage, e.g. "gradeDirect,includeProductive". */
  usage?: string;
}

export interface UsageSummary {
  total: number;
  usageSites: number;
  objects: number;
  packages: number;
  byType: Record<string, number>;
  topPackages: { name: string; rows: number }[];
}

export interface UsagePage {
  summary: UsageSummary;
  offset: number;
  returned: number;
  more: boolean;
  rows: UsageRow[];
}

export interface PageOptions {
  offset?: number;
  maxResults?: number;
  /** Only the rows a snippet can be fetched for. */
  onlyWithSnippets?: boolean;
}

export const DEFAULT_MAX_RESULTS = 100;

const packageOf = (row: UsageReference): string | undefined =>
  row?.packageRef?.['adtcore:name'] || undefined;

export const trimUsageRow = (row: UsageReference): UsageRow => {
  const trimmed: UsageRow = {
    name: row['adtcore:name'] || undefined,
    type: row['adtcore:type'] || undefined,
    package: packageOf(row),
    uri: row.uri || undefined
  };
  if (row.objectIdentifier) trimmed.objectIdentifier = row.objectIdentifier;
  if (row.usageInformation) trimmed.usage = row.usageInformation;
  return trimmed;
};

export const summariseUsages = (rows: UsageReference[]): UsageSummary => {
  const byType: Record<string, number> = {};
  const objects = new Set<string>();
  const packages = new Map<string, number>();
  let usageSites = 0;
  for (const row of rows) {
    const type = row['adtcore:type'] || '(none)';
    byType[type] = (byType[type] || 0) + 1;
    if (row['adtcore:name']) objects.add(`${type} ${row['adtcore:name']}`);
    const pack = packageOf(row);
    if (pack) packages.set(pack, (packages.get(pack) || 0) + 1);
    if (row.objectIdentifier) usageSites++;
  }
  const topPackages = [...packages.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({ name, rows: count }));
  return {
    total: rows.length,
    usageSites,
    objects: objects.size,
    packages: packages.size,
    byType,
    topPackages
  };
};

/**
 * One page of the answer, with the summary always covering the whole of it -
 * a count that shrank with the page would be worse than no count at all.
 */
export const pageUsages = (rows: UsageReference[], options: PageOptions = {}): UsagePage => {
  const summary = summariseUsages(rows);
  const wanted = options.onlyWithSnippets ? rows.filter(row => !!row.objectIdentifier) : rows;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const max = Math.max(1, Math.floor(options.maxResults ?? DEFAULT_MAX_RESULTS));
  const page = wanted.slice(offset, offset + max);
  return {
    summary,
    offset,
    returned: page.length,
    more: offset + page.length < wanted.length,
    rows: page.map(trimUsageRow)
  };
};

/**
 * The identifiers usageReferenceSnippets can actually work with.
 *
 * It builds its request out of objectIdentifier alone and drops every row
 * without one, so a caller who hands back the grouping rows of the tree gets
 * an empty answer and no reason for it.
 */
export const snippetableReferences = (references: any): UsageReference[] => {
  const rows = Array.isArray(references) ? references : [];
  return rows.filter(row => row && typeof row.objectIdentifier === 'string' && row.objectIdentifier.length > 0);
};
