import { walkPackage, countByType, sourceUrlFor, objectUrlFor } from '../lib/packageWalk';

/** Node lists shaped exactly like the ones a live package answers with. */
const TREE: Record<string, any[]> = {
  ZMM: [
    { OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'ZMM_BASE' },
    { OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'ZMM_UTILS' }
  ],
  ZMM_BASE: [
    { OBJECT_TYPE: 'CLAS/OC', OBJECT_NAME: 'ZCL_MM', DESCRIPTION: 'MM helpers' },
    { OBJECT_TYPE: 'PROG/P', OBJECT_NAME: 'ZR_MM_FOO' },
    { OBJECT_TYPE: 'DTEL/DE', OBJECT_NAME: 'ZMM_STATUS' },
    { OBJECT_TYPE: 'DEVC/K', OBJECT_NAME: 'ZMM_BASE_SUB' }
  ],
  ZMM_UTILS: [
    { OBJECT_TYPE: 'CLAS/OC', OBJECT_NAME: 'ZCL_MM_UTILS' },
    { OBJECT_TYPE: 'TABL/DT', OBJECT_NAME: 'ZALV_HIDE_BUTTON' }
  ],
  ZMM_BASE_SUB: [{ OBJECT_TYPE: 'PROG/P', OBJECT_NAME: 'ZR_DEEP' }]
};

const reader = (log?: string[]) => async (name: string) => {
  log?.push(name);
  return TREE[name] || [];
};

describe('walkPackage', () => {
  it('walks only the named package at depth 1', async () => {
    const result = await walkPackage('ZMM_BASE', reader(), { maxDepth: 1 });
    expect(result.objects.map(o => o.name)).toEqual(['ZCL_MM', 'ZR_MM_FOO', 'ZMM_STATUS']);
    expect(result.notWalked).toEqual(['ZMM_BASE_SUB']);
    expect(result.deepestLevel).toBe(1);
  });

  // Breadth-first: a limit reached half-way leaves a complete picture of the
  // upper levels rather than one deep branch.
  it('goes level by level and names what it did not open', async () => {
    const visited: string[] = [];
    const result = await walkPackage('ZMM', reader(visited), { maxDepth: 2 });
    expect(visited).toEqual(['ZMM', 'ZMM_BASE', 'ZMM_UTILS']);
    expect(result.packages).toEqual(['ZMM', 'ZMM_BASE', 'ZMM_UTILS']);
    expect(result.notWalked).toEqual(['ZMM_BASE_SUB']);
    expect(result.objects.map(o => o.name))
      .toEqual(['ZCL_MM', 'ZR_MM_FOO', 'ZMM_STATUS', 'ZCL_MM_UTILS', 'ZALV_HIDE_BUTTON']);
  });

  it('reaches the deepest level when allowed to', async () => {
    const result = await walkPackage('ZMM', reader(), { maxDepth: 3 });
    expect(result.objects.map(o => o.name)).toContain('ZR_DEEP');
    expect(result.notWalked).toEqual([]);
    expect(result.deepestLevel).toBe(3);
  });

  it('records which package each object came from', async () => {
    const result = await walkPackage('ZMM', reader(), { maxDepth: 2 });
    expect(result.objects.find(o => o.name === 'ZCL_MM_UTILS')!.packageName).toBe('ZMM_UTILS');
  });

  it('filters by type', async () => {
    const result = await walkPackage('ZMM', reader(), { maxDepth: 2, objectTypes: ['clas/oc'] as any });
    expect(result.objects.map(o => o.name)).toEqual(['ZCL_MM', 'ZCL_MM_UTILS']);
  });

  it('keeps only what has readable text when asked', async () => {
    const result = await walkPackage('ZMM_BASE', reader(), { maxDepth: 1, readableOnly: true });
    // The data element has no source, so a search would only fail on it.
    expect(result.objects.map(o => o.name)).toEqual(['ZCL_MM', 'ZR_MM_FOO']);
  });

  it('stops at the object limit and says so', async () => {
    const result = await walkPackage('ZMM', reader(), { maxDepth: 2, maxObjects: 2 });
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
    const result = await walkPackage('ZMM_BASE', reader(), { maxDepth: 1 });
    const clas = result.objects.find(o => o.name === 'ZCL_MM')!;
    expect(clas.sourceUrl).toBe('/sap/bc/adt/oo/classes/zcl_mm/source/main');
    expect(clas.objectUrl).toBe('/sap/bc/adt/oo/classes/zcl_mm');
    expect(clas.description).toBe('MM helpers');
    // No source collection for a data element, so no URL is invented.
    expect(result.objects.find(o => o.name === 'ZMM_STATUS')!.sourceUrl).toBeUndefined();
  });

  it('answers an unknown package the way the backend does - empty', async () => {
    const result = await walkPackage('ZKRI_NOTHING', reader(), { maxDepth: 3 });
    expect(result).toMatchObject({ objects: [], notWalked: [], truncated: false });
    expect(result.packages).toEqual(['ZKRI_NOTHING']);
  });
});

describe('source locations', () => {
  it('knows the collections that serve text', () => {
    expect(sourceUrlFor('PROG/I', 'ZR_MM_FOO_F01'))
      .toBe('/sap/bc/adt/programs/includes/zr_mm_foo_f01/source/main');
    expect(sourceUrlFor('DDLS/DF', 'ZI_VIEW'))
      .toBe('/sap/bc/adt/ddic/ddl/sources/zi_view/source/main');
    // Tables and structures come from the same one.
    expect(sourceUrlFor('TABL/DT', 'ZMMSTEP')).toBe(sourceUrlFor('TABL/DS', 'ZMMSTEP'));
    expect(sourceUrlFor('INTF/OI', 'ZIF_MM_C'))
      .toBe('/sap/bc/adt/oo/interfaces/zif_mm_c/source/main');
    // A function group's own text - its includes are PROG/I under the group.
    expect(sourceUrlFor('FUGR/F', 'ZMM_UTILS'))
      .toBe('/sap/bc/adt/functions/groups/zmm_utils/source/main');
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
    expect(sourceUrlFor('XSLT/VT', 'ZMM_NO_SPOTDOPP'))
      .toBe('/sap/bc/adt/xslt/transformations/zmm_no_spotdopp/source/main');
  });

  it('has no location for a type ADT serves no source for', () => {
    expect(sourceUrlFor('DTEL/DE', 'ZMM_STATUS')).toBeUndefined();
    expect(objectUrlFor('DOMA/DD', 'ZMM_DOM')).toBeUndefined();
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
