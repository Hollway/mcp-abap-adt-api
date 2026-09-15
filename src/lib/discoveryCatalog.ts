/**
 * The discovery family, cut to a size a caller can read.
 *
 * Three of these answers are catalogues of the whole system, and they were
 * handed back whole. Measured on a classic ERP system:
 *
 *  - loadTypes: 141,045 characters - every creatable object type with its URI
 *    template, most of them irrelevant to the question that prompted the call;
 *  - adtDiscovery: 42,033 characters, the bulk of it template links nobody
 *    asked for;
 *  - adtCompatibiliyGraph: 29,039 characters of edges, one line per pair.
 *
 * Each is now answered as a summary over the whole catalogue plus one page of
 * rows, steered by a filter. The summary is what says how much was there, so
 * a narrowed answer never reads as a complete one.
 *
 * The other half of this module is the reverse: the three lookups that answer
 * with nothing at all when they find nothing - featureDetails,
 * collectionFeatureDetails and findCollectionByUrl each returned
 * {"status":"success"} and no field, for a title that exists and for one that
 * does not alike. What is missing there is not the data but the verdict, so
 * these helpers produce the candidates a caller can be pointed at instead.
 */

export interface Page {
  maxResults?: number;
  offset?: number;
}

const DEFAULT_PAGE = 50;

const clampPage = (opts: Page, fallback = DEFAULT_PAGE) => {
  const max = Number.isFinite(opts.maxResults) ? Math.max(1, Math.trunc(opts.maxResults as number)) : fallback;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.trunc(opts.offset as number)) : 0;
  return { max, offset };
};

const matches = (needle: string | undefined, ...haystack: (string | undefined)[]) => {
  if (!needle) return true;
  const n = needle.toLowerCase().replace(/\*/g, '');
  return haystack.some(h => typeof h === 'string' && h.toLowerCase().includes(n));
};

const countBy = <T>(rows: T[], key: (row: T) => string | undefined) => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
};

const topEntries = (counts: Record<string, number>, limit: number) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));

/* ------------------------------------------------------------------ types */

export interface LoadTypeRow {
  OBJECT_TYPE?: string;
  OBJECT_TYPE_LABEL?: string;
  CATEGORY?: string;
  CATEGORY_LABEL?: string;
  URI_TEMPLATE?: string;
  PARENT_OBJECT_TYPE?: string;
  OBJNAME_MAXLENGTH?: number;
  CAPABILITIES?: unknown[];
  [key: string]: unknown;
}

export interface LoadTypesOptions extends Page {
  /** Substring of the type id or its label, case-insensitive. */
  name?: string;
  /** Substring of the category id or its label. */
  category?: string;
}

export interface LoadTypesPage {
  summary: {
    total: number;
    matched: number;
    returned: number;
    offset: number;
    more: boolean;
    topCategories: { name: string; count: number }[];
  };
  filter: { name?: string; category?: string };
  types: {
    type?: string;
    label?: string;
    category?: string;
    parent?: string;
    uriTemplate?: string;
    maxNameLength?: number;
  }[];
}

export function pageLoadTypes(all: LoadTypeRow[], opts: LoadTypesOptions = {}): LoadTypesPage {
  const rows = Array.isArray(all) ? all : [];
  const { max, offset } = clampPage(opts);
  const matched = rows.filter(
    r =>
      matches(opts.name, r.OBJECT_TYPE, r.OBJECT_TYPE_LABEL) &&
      matches(opts.category, r.CATEGORY, r.CATEGORY_LABEL)
  );
  const page = matched.slice(offset, offset + max);
  return {
    summary: {
      total: rows.length,
      matched: matched.length,
      returned: page.length,
      offset,
      more: offset + page.length < matched.length,
      topCategories: topEntries(countBy(matched, r => r.CATEGORY_LABEL || r.CATEGORY), 8)
    },
    filter: { name: opts.name, category: opts.category },
    types: page.map(r => ({
      type: r.OBJECT_TYPE,
      label: r.OBJECT_TYPE_LABEL,
      category: r.CATEGORY_LABEL || r.CATEGORY,
      parent: r.PARENT_OBJECT_TYPE || undefined,
      uriTemplate: r.URI_TEMPLATE,
      maxNameLength: r.OBJNAME_MAXLENGTH
    }))
  };
}

/* -------------------------------------------------------------- discovery */

export interface DiscoveryCollection {
  href?: string;
  title?: string;
  templateLinks?: unknown[];
  [key: string]: unknown;
}

export interface DiscoveryWorkspace {
  title?: string;
  collection?: DiscoveryCollection | DiscoveryCollection[];
  [key: string]: unknown;
}

const collectionsOf = (workspace: DiscoveryWorkspace): DiscoveryCollection[] => {
  const c = workspace.collection;
  if (!c) return [];
  return Array.isArray(c) ? c : [c];
};

export interface DiscoveryOptions extends Page {
  /** Substring of a collection href or title, or of a workspace title. */
  search?: string;
  /** Keep the template links - off by default, they are most of the payload. */
  includeTemplates?: boolean;
}

export interface DiscoveryPage {
  summary: {
    workspaces: number;
    collections: number;
    matched: number;
    returned: number;
    offset: number;
    more: boolean;
    templateLinks: number;
  };
  filter: { search?: string; includeTemplates: boolean };
  collections: {
    workspace?: string;
    href?: string;
    title?: string;
    templateLinks?: unknown[];
    templateLinkCount?: number;
  }[];
}

export function pageDiscovery(workspaces: DiscoveryWorkspace[], opts: DiscoveryOptions = {}): DiscoveryPage {
  const spaces = Array.isArray(workspaces) ? workspaces : [];
  const { max, offset } = clampPage(opts, 60);
  const flat = spaces.flatMap(w =>
    collectionsOf(w).map(c => ({
      workspace: typeof w.title === 'string' ? w.title : undefined,
      href: c.href,
      title: typeof c.title === 'string' ? c.title : undefined,
      links: Array.isArray(c.templateLinks) ? c.templateLinks : []
    }))
  );
  const matched = flat.filter(c => matches(opts.search, c.href, c.title, c.workspace));
  const page = matched.slice(offset, offset + max);
  return {
    summary: {
      workspaces: spaces.length,
      collections: flat.length,
      matched: matched.length,
      returned: page.length,
      offset,
      more: offset + page.length < matched.length,
      templateLinks: flat.reduce((sum, c) => sum + c.links.length, 0)
    },
    filter: { search: opts.search, includeTemplates: !!opts.includeTemplates },
    collections: page.map(c =>
      opts.includeTemplates
        ? { workspace: c.workspace, href: c.href, title: c.title, templateLinks: c.links }
        : { workspace: c.workspace, href: c.href, title: c.title, templateLinkCount: c.links.length }
    )
  };
}

/** The titles featureDetails takes, for when it was handed one that is not there. */
export function discoveryTitles(workspaces: DiscoveryWorkspace[]): string[] {
  const titles = new Set<string>();
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    if (typeof w.title === 'string' && w.title) titles.add(w.title);
    for (const c of collectionsOf(w)) if (typeof c.title === 'string' && c.title) titles.add(c.title);
  }
  return [...titles];
}

/**
 * The template addresses collectionFeatureDetails actually matches on.
 *
 * The library looks a URL up among the templateLinks of every collection, not
 * among the collection addresses - so /sap/bc/adt/oo/classes, a collection
 * that plainly exists, finds nothing there. Both lists are needed to say
 * which of the two a caller has in hand.
 */
export function templateLinks(workspaces: DiscoveryWorkspace[]): string[] {
  const templates = new Set<string>();
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    for (const c of collectionsOf(w)) {
      for (const link of Array.isArray(c.templateLinks) ? c.templateLinks : []) {
        const template = (link as any)?.template;
        if (typeof template === 'string' && template) templates.add(template);
      }
    }
  }
  return [...templates];
}

/** Collection addresses, for when a URL matched none of them. */
export function collectionHrefs(workspaces: DiscoveryWorkspace[]): string[] {
  const hrefs = new Set<string>();
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    for (const c of collectionsOf(w)) if (typeof c.href === 'string' && c.href) hrefs.add(c.href);
  }
  return [...hrefs];
}

/**
 * The addresses closest to one that matched nothing: the collections sharing
 * the longest leading path with it, best first.
 */
export function nearestHrefs(hrefs: string[], url: string, limit = 5): string[] {
  const target = String(url || '').toLowerCase();
  const score = (href: string) => {
    const h = href.toLowerCase();
    let i = 0;
    while (i < h.length && i < target.length && h[i] === target[i]) i++;
    return i;
  };
  return hrefs
    .map(href => ({ href, score: score(href) }))
    .filter(h => h.score > '/sap/bc/adt/'.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(h => h.href);
}

/** The titles closest to one that matched nothing, by shared words. */
export function nearestTitles(titles: string[], title: string, limit = 5): string[] {
  const words = String(title || '')
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);
  if (!words.length) return titles.slice(0, limit);
  const score = (candidate: string) => {
    const c = candidate.toLowerCase();
    return words.reduce((sum, w) => sum + (c.includes(w) ? w.length : 0), 0);
  };
  return titles
    .map(t => ({ t, score: score(t) }))
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(t => t.t);
}

/* ---------------------------------------------------------- compatibility */

export interface GraphNode {
  nameSpace?: string;
  name?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  sourceNode?: GraphNode;
  targetNode?: GraphNode;
  [key: string]: unknown;
}

export interface GraphOptions extends Page {
  /** Substring of a namespace on either end of the edge. */
  namespace?: string;
  /** Substring of a node name on either end of the edge. */
  name?: string;
}

export interface GraphPage {
  summary: {
    edges: number;
    matched: number;
    returned: number;
    offset: number;
    more: boolean;
    nodes: number;
    namespaces: number;
    topNamespaces: { name: string; count: number }[];
  };
  filter: { namespace?: string; name?: string };
  edges: { from: string; to: string }[];
}

const nodeLabel = (n?: GraphNode) => (n ? [n.nameSpace, n.name].filter(Boolean).join('/') : '');

export function pageCompatibilityGraph(graph: { edges?: GraphEdge[] } | undefined, opts: GraphOptions = {}): GraphPage {
  const edges = Array.isArray(graph?.edges) ? (graph!.edges as GraphEdge[]) : [];
  const { max, offset } = clampPage(opts);
  const matched = edges.filter(
    e =>
      matches(opts.namespace, e.sourceNode?.nameSpace, e.targetNode?.nameSpace) &&
      matches(opts.name, e.sourceNode?.name, e.targetNode?.name)
  );
  const page = matched.slice(offset, offset + max);
  const nodes = new Set<string>();
  const namespaces: Record<string, number> = {};
  for (const e of edges) {
    for (const n of [e.sourceNode, e.targetNode]) {
      const label = nodeLabel(n);
      if (label) nodes.add(label);
      if (n?.nameSpace) namespaces[n.nameSpace] = (namespaces[n.nameSpace] || 0) + 1;
    }
  }
  return {
    summary: {
      edges: edges.length,
      matched: matched.length,
      returned: page.length,
      offset,
      more: offset + page.length < matched.length,
      nodes: nodes.size,
      namespaces: Object.keys(namespaces).length,
      topNamespaces: topEntries(namespaces, 8)
    },
    filter: { namespace: opts.namespace, name: opts.name },
    edges: page.map(e => ({ from: nodeLabel(e.sourceNode), to: nodeLabel(e.targetNode) }))
  };
}
