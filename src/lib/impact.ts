/**
 * Rolling a where-used answer up into what depends on an object.
 *
 * usageReferences answers with a flat list that is really a tree: a row per
 * package, a row per object inside it, and a row per place inside that - a
 * method, an include of a function group, a function module, the test
 * include. ZCL_APP_RETURN answers with 352 rows and about 178,000 characters,
 * which is more than a context window should spend on the question "what
 * breaks if I change this".
 *
 * What is wanted from that is the objects, with the places inside them, and
 * which package each belongs to. The rows carry enough to rebuild it: every
 * row but the package ones has a parentUri, and where the parent is missing
 * the URI itself says which object it belongs to.
 */

export interface UsageRow {
  uri?: string;
  parentUri?: string;
  usageInformation?: string;
  objectIdentifier?: string;
  'adtcore:name'?: string;
  'adtcore:type'?: string;
  'adtcore:description'?: string;
  packageRef?: { 'adtcore:name'?: string; 'adtcore:uri'?: string };
}

export interface ImpactPlace {
  name: string;
  kind: string;
  /** From a test include rather than productive code. */
  test?: boolean;
  /** The row this place came from, kept only to look up its source snippet. */
  objectIdentifier?: string;
}

export interface ImpactObject {
  name: string;
  type: string;
  package?: string;
  description?: string;
  objectUrl?: string;
  places: ImpactPlace[];
  /** Every place found is in test code. */
  testOnly?: boolean;
  /** More places than were listed. */
  morePlaces?: number;
}

export interface ImpactSummary {
  objects: number;
  packages: number;
  places: number;
  byType: Record<string, number>;
  /** The heaviest packages only; `packages` is the true count. */
  byPackage: Record<string, number>;
  packagesNotListed?: number;
  testOnlyObjects: number;
}

export interface ImpactResult {
  objects: ImpactObject[];
  summary: ImpactSummary;
  /** Objects dropped because they are not custom code. */
  standardObjectsHidden: number;
  /** Objects beyond maxObjects. */
  objectsHidden: number;
}

export interface ImpactOptions {
  /** Keep only Z*, Y* and /namespace/ objects. Default true. */
  onlyCustom?: boolean;
  /** Keep usages that are only in test includes. Default true. */
  includeTests?: boolean;
  /** Only usages in this package. */
  packageName?: string;
  maxObjects?: number;
  maxPlacesPerObject?: number;
  /** How many packages the summary histogram lists. Default 20. */
  maxPackagesInSummary?: number;
}

/** Packages are rows too, and they are not what depends on anything. */
const PACKAGE_TYPE = /^DEVC/i;

/**
 * Rows that stand for an object rather than a place inside one.
 *
 * FUGR/F is matched exactly, and FUGR/FF deliberately is not: a function
 * module is reported as a place inside its group, which is how it is
 * addressed and how it travels in a transport. Matching the family by prefix
 * would swallow it, and the group would then never appear as the object.
 */
const OBJECT_TYPES_EXACT = new Set(['CLAS/OC', 'INTF/OI', 'PROG/P', 'FUGR/F', 'MSAG/N']);
const OBJECT_TYPE_FAMILIES =
  /^(TABL|DDLS|DTEL|DOMA|XSLT|ENHO|ENHS|WDYN|SRVD|SRVB|TRAN|DCLS|DDLX|VIEW|SHLP|TTYP)\//i;

const isObjectType = (type?: string): boolean => {
  const text = String(type || '').toUpperCase();
  return OBJECT_TYPES_EXACT.has(text) || OBJECT_TYPE_FAMILIES.test(text);
};

/** What a place inside an object is called, from its ADT type. */
const PLACE_KINDS: Array<[RegExp, string]> = [
  [/^CLAS\/OM/i, 'method'],
  [/^CLAS\/OSI/i, 'class include'],
  [/^CLAS\/OSU/i, 'class include'],
  [/^CLAS\/OSO/i, 'class include'],
  [/^CLAS\/OCN/i, 'class include'],
  [/^FUGR\/FF/i, 'function module'],
  [/^FUGR\/I/i, 'include'],
  [/^PROG\/I/i, 'include'],
  [/^INTF\/IO/i, 'interface method']
];

const CUSTOM_NAME = /^(z|y|\/[a-z0-9_]+\/)/i;

/** Object a URI belongs to, when no parent row names it. */
export function ownerFromUri(uri: string): { name: string; type: string; objectUrl: string } | undefined {
  const path = String(uri || '').split('#')[0];
  const patterns: Array<[RegExp, string, (name: string) => string]> = [
    [/^\/sap\/bc\/adt\/oo\/classes\/([^/]+)/i, 'CLAS/OC', name => `/sap/bc/adt/oo/classes/${name}`],
    [/^\/sap\/bc\/adt\/oo\/interfaces\/([^/]+)/i, 'INTF/OI', name => `/sap/bc/adt/oo/interfaces/${name}`],
    [/^\/sap\/bc\/adt\/functions\/groups\/([^/]+)/i, 'FUGR/F', name => `/sap/bc/adt/functions/groups/${name}`],
    [/^\/sap\/bc\/adt\/programs\/programs\/([^/]+)/i, 'PROG/P', name => `/sap/bc/adt/programs/programs/${name}`],
    [/^\/sap\/bc\/adt\/programs\/includes\/([^/]+)/i, 'PROG/I', name => `/sap/bc/adt/programs/includes/${name}`]
  ];
  for (const [pattern, type, url] of patterns) {
    const match = pattern.exec(path);
    if (match) {
      const encoded = match[1];
      return { name: decodeURIComponent(encoded).toUpperCase(), type, objectUrl: url(encoded) };
    }
  }
  return undefined;
}

const placeKind = (type?: string): string => {
  for (const [pattern, kind] of PLACE_KINDS) if (pattern.test(String(type || ''))) return kind;
  return type ? String(type) : 'usage';
};

const isTestUsage = (row: UsageRow): boolean =>
  /includeTest/i.test(String(row.usageInformation || ''))
  || /\/includes\/testclasses/i.test(String(row.uri || ''));

/**
 * Group the rows by the object they belong to.
 *
 * A place row is attached to the nearest ancestor that stands for an object;
 * when the chain leads nowhere - the parent row simply is not in the answer -
 * the URI is read instead, which is the same information in another form.
 */
export function rollUpUsages(rows: UsageRow[], options: ImpactOptions = {}): ImpactResult {
  const onlyCustom = options.onlyCustom !== false;
  const includeTests = options.includeTests !== false;
  const maxObjects = Math.max(1, Number(options.maxObjects) || 100);
  const maxPlaces = Math.max(1, Number(options.maxPlacesPerObject) || 8);
  const wantedPackage = String(options.packageName || '').trim().toUpperCase();

  const byUri = new Map<string, UsageRow>();
  for (const row of rows) {
    const uri = String(row?.uri || '').split('#')[0];
    if (uri && !byUri.has(uri)) byUri.set(uri, row);
  }

  const objects = new Map<string, ImpactObject>();
  const placesSeen = new Set<string>();
  let standardObjectsHidden = 0;

  const ownerOf = (row: UsageRow): { name: string; type: string; objectUrl?: string; row?: UsageRow } | undefined => {
    // Walk up the parents first: they carry the real type and description.
    const seen = new Set<string>();
    let current: UsageRow | undefined = row;
    while (current) {
      const type = String(current['adtcore:type'] || '');
      if (isObjectType(type) && current !== row) {
        return {
          name: String(current['adtcore:name'] || '').toUpperCase(),
          type,
          objectUrl: String(current.uri || '').split('#')[0],
          row: current
        };
      }
      const parent = String(current.parentUri || '').split('#')[0];
      if (!parent || seen.has(parent) || PACKAGE_TYPE.test(String(byUri.get(parent)?.['adtcore:type'] || ''))) break;
      seen.add(parent);
      current = byUri.get(parent);
    }
    const fromUri = ownerFromUri(String(row.uri || ''));
    if (!fromUri) return undefined;
    const parentRow = byUri.get(fromUri.objectUrl);
    return {
      name: fromUri.name,
      type: String(parentRow?.['adtcore:type'] || fromUri.type),
      objectUrl: fromUri.objectUrl,
      row: parentRow
    };
  };

  for (const row of rows) {
    const type = String(row['adtcore:type'] || '');
    if (PACKAGE_TYPE.test(type)) continue;

    const isObjectRow = isObjectType(type);
    const owner = isObjectRow
      ? {
        name: String(row['adtcore:name'] || '').toUpperCase(),
        type,
        objectUrl: String(row.uri || '').split('#')[0],
        row
      }
      : ownerOf(row);
    if (!owner || !owner.name) continue;

    const packageName = String(
      owner.row?.packageRef?.['adtcore:name'] || row.packageRef?.['adtcore:name'] || ''
    ).toUpperCase();
    if (wantedPackage && packageName !== wantedPackage) continue;
    if (onlyCustom && !CUSTOM_NAME.test(owner.name)) { standardObjectsHidden++; continue; }

    const key = `${owner.type}|${owner.name}`;
    let entry = objects.get(key);
    if (!entry) {
      entry = {
        name: owner.name,
        type: owner.type,
        ...(packageName ? { package: packageName } : {}),
        ...(owner.row?.['adtcore:description'] ? { description: owner.row['adtcore:description'] } : {}),
        ...(owner.objectUrl ? { objectUrl: owner.objectUrl } : {}),
        places: []
      };
      objects.set(key, entry);
    }

    if (isObjectRow) continue;

    const placeName = String(row['adtcore:name'] || '').trim();
    if (!placeName) continue;
    const kind = placeKind(type);
    // A class include row repeats the class name and says nothing about where
    // the call is; it is only noise next to the method rows.
    if (kind === 'class include') continue;
    // A standalone include is its own object here, because the program that
    // includes it is not in the answer - so listing it as a place inside
    // itself says nothing twice.
    if (placeName.toUpperCase() === owner.name && kind === 'include') continue;
    const placeKey = `${key}|${kind}|${placeName.toUpperCase()}`;
    if (placesSeen.has(placeKey)) continue;
    placesSeen.add(placeKey);
    entry.places.push({
      name: placeName.toUpperCase(),
      kind,
      ...(isTestUsage(row) ? { test: true } : {}),
      ...(row.objectIdentifier ? { objectIdentifier: row.objectIdentifier } : {})
    });
  }

  let all = [...objects.values()];
  for (const entry of all) {
    if (entry.places.length > 0 && entry.places.every(place => place.test)) entry.testOnly = true;
  }
  if (!includeTests) {
    all = all.filter(entry => !entry.testOnly);
    for (const entry of all) entry.places = entry.places.filter(place => !place.test);
  }

  // Most affected first, then by package and name, so the answer reads as a
  // work list rather than in the order the backend happened to walk the tree.
  all.sort((a, b) =>
    b.places.length - a.places.length
    || (a.package || '').localeCompare(b.package || '')
    || a.name.localeCompare(b.name));

  const kept = all.slice(0, maxObjects);
  for (const entry of kept) {
    if (entry.places.length > maxPlaces) {
      entry.morePlaces = entry.places.length - maxPlaces;
      entry.places = entry.places.slice(0, maxPlaces);
    }
  }

  const byType: Record<string, number> = {};
  const allPackages: Record<string, number> = {};
  let places = 0;
  for (const entry of all) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    if (entry.package) allPackages[entry.package] = (allPackages[entry.package] || 0) + 1;
    places += entry.places.length + (entry.morePlaces || 0);
  }

  // An interface used across the whole system touches over a hundred packages,
  // and a hundred-line histogram is not a summary. The heaviest few are, and
  // the total count is right next to them.
  const ranked = Object.entries(allPackages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const listedPackages = Math.max(1, Number(options.maxPackagesInSummary) || 20);
  const byPackage = Object.fromEntries(ranked.slice(0, listedPackages));

  return {
    objects: kept,
    summary: {
      objects: all.length,
      packages: ranked.length,
      places,
      byType,
      byPackage,
      ...(ranked.length > listedPackages
        ? { packagesNotListed: ranked.length - listedPackages }
        : {}),
      testOnlyObjects: all.filter(entry => entry.testOnly).length
    },
    standardObjectsHidden,
    objectsHidden: Math.max(0, all.length - kept.length)
  };
}
