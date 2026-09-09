/**
 * Where an object's readable text lives, and how a package is walked.
 *
 * The node list a package answers with is not usable as it stands: it gives
 * every object a URI, but for most types that URI is the SAPGUI bridge
 * (/sap/bc/adt/vit/wb/object_type/tabldt/object_name/ZFOO), which serves object
 * properties and no content. The mapping from type to the collection that
 * really serves the source is what turns a package listing into something that
 * can be read or searched.
 *
 * Sub-packages appear in the same list as DEVC/K nodes, and an unknown package
 * answers with an empty list rather than an error - so "empty" and "not there"
 * look identical and have to be told apart another way.
 */

const lower = (name: string): string => {
  const text = String(name).trim().toLowerCase();
  return text.includes('/') ? encodeURIComponent(text) : text;
};

/** Types whose text ADT serves, and the URL that serves it. */
const SOURCE_LOCATIONS: Record<string, (name: string) => string> = {
  'CLAS/OC': name => `/sap/bc/adt/oo/classes/${lower(name)}/source/main`,
  'INTF/OI': name => `/sap/bc/adt/oo/interfaces/${lower(name)}/source/main`,
  'PROG/P': name => `/sap/bc/adt/programs/programs/${lower(name)}/source/main`,
  'PROG/I': name => `/sap/bc/adt/programs/includes/${lower(name)}/source/main`,
  'FUGR/F': name => `/sap/bc/adt/functions/groups/${lower(name)}/source/main`,
  'DDLS/DF': name => `/sap/bc/adt/ddic/ddl/sources/${lower(name)}/source/main`,
  // Tables and structures share one collection, and it is the only place
  // their fields can be read.
  'TABL/DT': name => `/sap/bc/adt/ddic/structures/${lower(name)}/source/main`,
  'TABL/DS': name => `/sap/bc/adt/ddic/structures/${lower(name)}/source/main`,
  // Access controls: the collection is /sap/bc/adt/acm/dcl/sources, as
  // discovery lists it. No DCLS object existed on the system this was written
  // against, so the path comes from discovery rather than from a read.
  'DCLS/DL': name => `/sap/bc/adt/acm/dcl/sources/${lower(name)}/source/main`,
  // Transformations sit under xslt/transformations, not xslt/sources.
  'XSLT/VT': name => `/sap/bc/adt/xslt/transformations/${lower(name)}/source/main`
};

/**
 * Metadata extensions (DDLX/EX) are deliberately absent: this backend serves
 * no collection for them at all, so a URL for one would only ever 404.
 */

export const sourceUrlFor = (objectType: string, name: string): string | undefined => {
  const build = SOURCE_LOCATIONS[String(objectType).trim().toUpperCase()];
  return build ? build(name) : undefined;
};

export const READABLE_TYPES: readonly string[] = Object.keys(SOURCE_LOCATIONS);

/** The ADT object URL (not the source, not the SAPGUI bridge) where there is one. */
export const objectUrlFor = (objectType: string, name: string): string | undefined => {
  const source = sourceUrlFor(objectType, name);
  return source ? source.replace(/\/source\/main$/, '') : undefined;
};

export interface WalkedObject {
  objectType: string;
  name: string;
  /** Package the object was found in - not always the one that was asked for. */
  packageName: string;
  description?: string;
  objectUrl?: string;
  sourceUrl?: string;
}

export interface WalkResult {
  objects: WalkedObject[];
  packages: string[];
  /** Packages that were found but not opened, because a limit was reached. */
  notWalked: string[];
  truncated: boolean;
  deepestLevel: number;
}

export interface WalkOptions {
  /** 1 walks only the named package, 2 its sub-packages, and so on. */
  maxDepth?: number;
  maxObjects?: number;
  /** Only these ADT types, e.g. ["CLAS/OC", "PROG/P"]. */
  objectTypes?: string[];
  /** Keep only what has readable text. */
  readableOnly?: boolean;
}

export interface PackageNode {
  OBJECT_TYPE: string;
  OBJECT_NAME: string;
  OBJECT_URI?: string;
  DESCRIPTION?: string;
}

/**
 * Walk a package and its sub-packages breadth-first.
 *
 * Breadth-first on purpose: a limit reached half-way then leaves a complete
 * picture of the upper levels rather than one deep branch, and the packages
 * that were skipped are named so the caller can go into them directly.
 */
export async function walkPackage(
  root: string,
  read: (packageName: string) => Promise<PackageNode[]>,
  options: WalkOptions = {}
): Promise<WalkResult> {
  const maxDepth = Math.max(1, Number(options.maxDepth) || 1);
  const maxObjects = Math.max(1, Number(options.maxObjects) || 500);
  const wanted = options.objectTypes?.length
    ? new Set(options.objectTypes.map(t => String(t).trim().toUpperCase()))
    : undefined;

  const objects: WalkedObject[] = [];
  const visited = new Set<string>();
  const packages: string[] = [];
  const notWalked: string[] = [];
  let truncated = false;
  let deepestLevel = 0;

  let level = [String(root).trim().toUpperCase()];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const packageName of level) {
      if (visited.has(packageName)) continue;
      visited.add(packageName);
      packages.push(packageName);
      deepestLevel = depth;

      const nodes = await read(packageName);
      for (const node of nodes) {
        const objectType = String(node.OBJECT_TYPE || '').toUpperCase();
        const name = String(node.OBJECT_NAME || '');
        if (!objectType || !name) continue;

        if (objectType === 'DEVC/K') {
          if (depth < maxDepth) next.push(name.toUpperCase());
          else if (!notWalked.includes(name.toUpperCase())) notWalked.push(name.toUpperCase());
          continue;
        }
        if (wanted && !wanted.has(objectType)) continue;
        const sourceUrl = sourceUrlFor(objectType, name);
        if (options.readableOnly && !sourceUrl) continue;
        if (objects.length >= maxObjects) { truncated = true; continue; }

        objects.push({
          objectType,
          name,
          packageName,
          ...(node.DESCRIPTION ? { description: node.DESCRIPTION } : {}),
          ...(sourceUrl ? { objectUrl: sourceUrl.replace(/\/source\/main$/, ''), sourceUrl } : {})
        });
      }
    }
    level = next;
  }

  // Nothing is swept up here. A sub-package seen at the depth limit is put on
  // notWalked at the point it is seen, and one seen before the limit goes on
  // `next` and is opened - so the level this loop ends on is always empty. A
  // pass over it only looked like it named the packages that were skipped.
  return { objects, packages, notWalked, truncated, deepestLevel };
}

/** Count by ADT type, for an answer that says what a package is made of. */
export function countByType(objects: WalkedObject[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const object of objects) {
    counts[object.objectType] = (counts[object.objectType] || 0) + 1;
  }
  return counts;
}
