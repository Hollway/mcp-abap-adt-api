/**
 * One level of the repository tree, cut to a size worth reading.
 *
 * The backend answers a whole level at once and has no paging here either.
 * Measured on a classic ERP system, SABAPDEMOS answers with 802 nodes and
 * 238,596 characters - past the response cap, so the tool could only hand
 * back a truncated blob. A node averages 293 characters, and two of its
 * fields are the same SAPGUI bridge URI written twice: OBJECT_URI and
 * OBJECT_VIT_URI. Neither serves content - packageTree is what resolves real
 * source URLs - so one of them is kept and the empty fields are dropped.
 *
 * The object types of the level are what a caller usually wants first, and
 * the backend already sends them as their own list, so they are counted and
 * kept whole: they are the answer to "what is in this package".
 */
export interface TreeNode {
  type?: string;
  name?: string;
  techName?: string;
  uri?: string;
  description?: string;
  expandable?: boolean;
}

export interface NodePage {
  counts: {
    nodes: number;
    byType: Record<string, number>;
    objectTypes: number;
    categories: number;
  };
  total: number;
  offset: number;
  returned: number;
  more: boolean;
  objectTypes: any[];
  categories: any[];
  nodes: TreeNode[];
}

export interface NodePageOptions {
  offset?: number;
  maxResults?: number;
  objectType?: string;
}

export const DEFAULT_MAX_NODES = 100;

export const trimNode = (raw: any): TreeNode => {
  const node: TreeNode = {
    type: raw?.OBJECT_TYPE || undefined,
    name: raw?.OBJECT_NAME || undefined,
    uri: raw?.OBJECT_URI || raw?.OBJECT_VIT_URI || undefined
  };
  // Written by the backend on every node, and equal to the name on most of
  // them - worth keeping only where it says something the name does not.
  if (raw?.TECH_NAME && raw.TECH_NAME !== raw.OBJECT_NAME) node.techName = raw.TECH_NAME;
  if (raw?.DESCRIPTION) node.description = raw.DESCRIPTION;
  if (raw?.EXPANDABLE) node.expandable = true;
  return node;
};

export const pageNodes = (contents: any, options: NodePageOptions = {}): NodePage => {
  const all: any[] = Array.isArray(contents?.nodes) ? contents.nodes : [];
  const byType: Record<string, number> = {};
  for (const node of all) {
    const type = node?.OBJECT_TYPE || '(none)';
    byType[type] = (byType[type] || 0) + 1;
  }
  const wanted = options.objectType
    ? all.filter(node => String(node?.OBJECT_TYPE || '').toUpperCase() === options.objectType!.toUpperCase())
    : all;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const max = Math.max(1, Math.floor(options.maxResults ?? DEFAULT_MAX_NODES));
  const page = wanted.slice(offset, offset + max);
  const objectTypes: any[] = Array.isArray(contents?.objectTypes) ? contents.objectTypes : [];
  const categories: any[] = Array.isArray(contents?.categories) ? contents.categories : [];
  return {
    counts: {
      nodes: all.length,
      byType,
      objectTypes: objectTypes.length,
      categories: categories.length
    },
    total: wanted.length,
    offset,
    returned: page.length,
    more: offset + page.length < wanted.length,
    objectTypes,
    categories,
    nodes: page.map(trimNode)
  };
};
