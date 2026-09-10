import { walkPackage, countByType, sourceUrlFor, objectUrlFor } from '../lib/packageWalk';

/** Node lists shaped exactly like the ones a live package answers with. */
const TREE: Record<string, any[]> = {
  ZAPP: [
    { OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'ZAPP_BASE' },
    { OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'ZAPP_UTILS' }
  ],
  ZAPP_BASE: [
    { OBJECT_TYPE: 'CLAS/OC', OBJECT_NAME: 'ZCL_APP', DESCRIPTION: 'MM helpers' },
    { OBJECT_TYPE: 'PROG/P', OBJECT_NAME: 'ZR_APP_FOO' },
    { OBJECT_TYPE: 'DTEL/DE', OBJECT_NAME: 'ZAPP_STATUS' },
    { OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'ZAPP_BASE_SUB' }
  ],
  ZAPP_UTILS: [
    { OBJECT_TYPE: 'CLAS/OC', OBJECT_NAME: 'ZCL_APP_UTILS' },
    { OBJECT_TYPE: 'TABL/DT', OBJECT_NAME: 'ZDEMO_FLAGS' }
  ],
  ZAPP_BASE_SUB: [{ OBJECT_TYPE: 'PROG/P', OBJECT_NAME: 'ZR_DEEP' }]
};

const reader = (log?: string[]) => async (name: string) => {
  log?.push(name);
  return TREE[name] || [];
};

describe('walkPackage', () => {
  it('walks only the named package at depth 1', async () => {
    const result = await walkPackage('ZAPP_BASE', reader(), { maxDepth: 1 });
    expect(result.objects.map(o => o.name)).toEqual(['ZCL_APP', 'ZR_APP_FOO', 'ZAPP_STATUS']);
    expect(result.notWalked).toEqual(['ZAPP_BASE_SUB']);
    expect(result.deepestLevel).toBe(1);
  });

  // Breadth-first: a limit reached half-way leaves a complete picture of the
  // upper levels rather than one deep branch.
  it('goes level by level and names what it did not open', async () => {
    const visited: string[] = [];
    const result = await walkPackage('ZAPP', reader(visited), { maxDepth: 2 });
    expect(visited).toEqual(['ZAPP', 'ZAPP_BASE', 'ZAPP_UTILS']);
    expect(result.packages).toEqual(['ZAPP', 'ZAPP_BASE', 'ZAPP_UTILS']);
    expect(result.notWalked).toEqual(['ZAPP_BASE_SUB']);
    expect(result.objects.map(o => o.name))
      .toEqual(['ZCL_APP', 'ZR_APP_FOO', 'ZAPP_STATUS', 'ZCL_APP_UTILS', 'ZDEMO_FLAGS']);
  });

  it('reaches the deepest level when allowed to', async () => {
    const result = await walkPackage('ZAPP', reader(), { maxDepth: 3 });
    expect(result.objects.map(o => o.name)).toContain('ZR_DEEP');
    expect(result.notWalked).toEqual([]);
    expect(result.deepestLevel).toBe(3);
  });

  it('records which package each object came from', async () => {
    const result = await walkPackage('ZAPP', reader(), { maxDepth: 2 });
    expect(result.objects.find(o => o.name === 'ZCL_APP_UTILS')!.packageName).toBe('ZAPP_UTILS');
  });

  it('filters by type', async () => {
    const result = await walkPackage('ZAPP', reader(), { maxDepth: 2, objectTypes: ['clas/oc'] as any });
    expect(result.objects.map(o => o.name)).toEqual(['ZCL_APP', 'ZCL_APP_UTILS']);
  });

  it('keeps only what has readable text when asked', async () => {
    const result = await walkPackage('ZAPP_BASE', reader(), { maxDepth: 1, readableOnly: true });
    // The data element has no source, so a search would only fail on it.
    expect(result.objects.map(o => o.name)).toEqual(['ZCL_APP', 'ZR_APP_FOO']);
  });

  it('stops at the object limit and says so', async () => {
    const result = await walkPackage('ZAPP', reader(), { maxDepth: 2, maxObjects: 2 });
    expect(result.objects).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not walk the same package twice', async () => {
    const visited: string[] = [];
    const cyclic = async (name: string) => {
      visited.push(name);
      return name === 'A'
        ? [{ OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'B' }]
        : [{ OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'A' }];
    };
    await walkPackage('A', cyclic, { maxDepth: 5 });
    expect(visited).toEqual(['A', 'B']);
  });

  it('attaches the object and source urls it can resolve', async () => {
    const result = await walkPackage('ZAPP_BASE', reader(), { maxDepth: 1 });
    const clas = result.objects.find(o => o.name === 'ZCL_APP')!;
    expect(clas.sourceUrl).toBe('/sap/bc/adt/oo/classes/zcl_app/source/main');
    expect(clas.objectUrl).toBe('/sap/bc/adt/oo/classes/zcl_app');
    expect(clas.description).toBe('MM helpers');
    // No source collection for a data element, so no URL is invented.
    expect(result.objects.find(o => o.name === 'ZAPP_STATUS')!.sourceUrl).toBeUndefined();
  });

  it('answers an unknown package the way the backend does - empty', async () => {
    const result = await walkPackage('ZDEV_NOTHING', reader(), { maxDepth: 3 });
    expect(result).toMatchObject({ objects: [], notWalked: [], truncated: false });
    expect(result.packages).toEqual(['ZDEV_NOTHING']);
  });
});

describe('source locations', () => {
  it('knows the collections that serve text', () => {
    expect(sourceUrlFor('PROG/I', 'ZR_APP_FOO_F01'))
      .toBe('/sap/bc/adt/programs/includes/zr_app_foo_f01/source/main');
    expect(sourceUrlFor('DDLS/DF', 'ZI_VIEW'))
      .toBe('/sap/bc/adt/ddic/ddl/sources/zi_view/source/main');
    // Tables and structures come from the same one.
    expect(sourceUrlFor('TABL/DT', 'ZAPPSTEP')).toBe(sourceUrlFor('TABL/DS', 'ZAPPSTEP'));
    expect(sourceUrlFor('INTF/OI', 'ZIF_APP_C'))
      .toBe('/sap/bc/adt/oo/interfaces/zif_app_c/source/main');
    // A function group's own text - its includes are PROG/I under the group.
    expect(sourceUrlFor('FUGR/F', 'ZAPP_UTILS'))
      .toBe('/sap/bc/adt/functions/groups/zapp_utils/source/main');
  });

  // The one address in this map that no read has ever confirmed: no DCLS object
  // exists on any of the systems this was built against, so it comes from
  // discovery. The test pins the shape, not the behaviour of the backend.
  it('addresses an access control from the collection discovery lists', () => {
    expect(sourceUrlFor('DCLS/DL', 'ZI_VIEW_ACC'))
      .toBe('/sap/bc/adt/acm/dcl/sources/zi_view_acc/source/main');
  });

  it('encodes a namespaced name', () => {
    expect(sourceUrlFor('CLAS/OC', '/ARM/CL_FOO'))
      .toBe('/sap/bc/adt/oo/classes/%2Farm%2Fcl_foo/source/main');
  });

  // xslt/sources answers 404; the collection discovery lists is
  // xslt/transformations, and that one serves the text.
  it('reads a transformation from xslt/transformations', () => {
    expect(sourceUrlFor('XSLT/VT', 'ZAPP_NO_SPLIT'))
      .toBe('/sap/bc/adt/xslt/transformations/zapp_no_split/source/main');
  });

  it('has no location for a type ADT serves no source for', () => {
    expect(sourceUrlFor('DTEL/DE', 'ZAPP_STATUS')).toBeUndefined();
    expect(objectUrlFor('DOMA/DD', 'ZAPP_DOM')).toBeUndefined();
    // This backend serves no collection for metadata extensions at all, so a
    // URL for one would only ever 404.
    expect(sourceUrlFor('DDLX/EX', 'ZI_EXT')).toBeUndefined();
  });
});

describe('countByType', () => {
  it('says what a package is made of', () => {
    expect(countByType([
      { objectType: 'CLAS/OC', name: 'A', packageName: 'P' },
      { objectType: 'CLAS/OC', name: 'B', packageName: 'P' },
      { objectType: 'PROG/P', name: 'C', packageName: 'P' }
    ])).toEqual({ 'CLAS/OC': 2, 'PROG/P': 1 });
  });
});
