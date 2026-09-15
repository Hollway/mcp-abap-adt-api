/**
 * What a class is made of, in a shape that can be read.
 *
 * Two answers of this family were unusable as exposed:
 *
 *  - classIncludes took a class name, and the library method behind it is a
 *    pure function over a class structure. Every call ended in
 *    "clas.includes is not iterable" - a TypeError reported as a transport
 *    error, on a tool whose schema promised a name;
 *  - classComponents handed back the backend tree unchanged: 13,501
 *    characters for CL_SALV_TABLE, most of it the link arrays ADT uses to
 *    navigate, around a list of names that runs to a tenth of that.
 */
import type { ClassComponent } from 'abap-adt-api';

export interface ClassIncludeRow {
  includeType: string;
  url: string;
}

/** The include map of a class structure, as rows rather than a Map. */
export function classIncludeRows(structure: any, includes: Map<string, string>): ClassIncludeRow[] {
  void structure;
  return [...includes.entries()].map(([includeType, url]) => ({ includeType, url }));
}

export interface ComponentRow {
  name: string;
  type: string;
  visibility?: string;
  level?: string;
  constant?: boolean;
  readOnly?: boolean;
  /** The owner within the class - an interface name for inherited members. */
  parent?: string;
}

export interface ComponentsOptions {
  /** Substring of the component name, case-insensitive. */
  name?: string;
  /** Substring of the ADT type, e.g. CLAS/OM for a method. */
  type?: string;
  /** public, protected or private. */
  visibility?: string;
  maxResults?: number;
  offset?: number;
}

export interface ComponentsPage {
  class: { name?: string; type?: string; visibility?: string; final?: boolean };
  summary: {
    total: number;
    matched: number;
    returned: number;
    offset: number;
    more: boolean;
    byType: { name: string; count: number }[];
    byVisibility: { name: string; count: number }[];
  };
  filter: { name?: string; type?: string; visibility?: string };
  components: ComponentRow[];
}

const flatten = (node: any, parent: string | undefined, rows: ComponentRow[]) => {
  const children = Array.isArray(node?.components) ? node.components : [];
  for (const c of children) {
    const name = String(c['adtcore:name'] ?? '');
    rows.push({
      name,
      type: String(c['adtcore:type'] ?? ''),
      visibility: c.visibility,
      level: c.level,
      constant: c.constant,
      readOnly: c.readOnly,
      parent
    });
    flatten(c, name || parent, rows);
  }
  return rows;
};

const tally = (rows: ComponentRow[], key: (r: ComponentRow) => string | undefined) => {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
};

const contains = (needle: string | undefined, haystack: string | undefined) =>
  !needle || String(haystack ?? '').toLowerCase().includes(needle.toLowerCase());

export function pageClassComponents(root: ClassComponent | any, opts: ComponentsOptions = {}): ComponentsPage {
  const rows = flatten(root, undefined, []);
  const matched = rows.filter(
    r => contains(opts.name, r.name) && contains(opts.type, r.type) && contains(opts.visibility, r.visibility)
  );
  const max = Number.isFinite(opts.maxResults) ? Math.max(1, Math.trunc(opts.maxResults as number)) : 100;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.trunc(opts.offset as number)) : 0;
  const page = matched.slice(offset, offset + max);
  return {
    class: {
      name: root?.['adtcore:name'],
      type: root?.['adtcore:type'],
      visibility: root?.visibility,
      final: root?.final
    },
    summary: {
      total: rows.length,
      matched: matched.length,
      returned: page.length,
      offset,
      more: offset + page.length < matched.length,
      byType: tally(matched, r => r.type),
      byVisibility: tally(matched, r => r.visibility)
    },
    filter: { name: opts.name, type: opts.type, visibility: opts.visibility },
    components: page
  };
}

/** The class URL behind a name, or the URL itself when one was given. */
export function classUrl(clas: string): string {
  const value = String(clas ?? '').trim();
  if (value.startsWith('/')) return value.replace(/\/(source\/main|includes\/.*)$/, '');
  return `/sap/bc/adt/oo/classes/${value.toLowerCase()}`;
}
