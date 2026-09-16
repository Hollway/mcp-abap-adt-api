import { packageUriOf } from '../lib/activation';

/**
 * Two ways of naming a thing that both used to go wrong.
 *
 * packageUriOf read the FIRST package out of the workbench path, which on a
 * nested tree is the superpackage: ZCL_MM answered ZMM although the class sits
 * in ZMM_BASE. A package move built on that was refused by the backend with
 * "Package assignment of object changed since the refactoring started", and an
 * activation that needed a parentUri was handed the wrong package.
 */
const path = (steps: any[]) => ({ findObjectPath: async () => steps }) as any;

const CLASS_URL = '/sap/bc/adt/oo/classes/zcl_mm';
const nested = [
  { 'adtcore:uri': '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZMM', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'ZMM' },
  {
    'adtcore:uri': '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZMM_BASE',
    'adtcore:type': 'DEVC/K',
    'adtcore:name': 'ZMM_BASE',
    'adtcore:parentUri': '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZMM'
  },
  {
    'adtcore:uri': CLASS_URL,
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'ZCL_MM',
    'adtcore:parentUri': '/sap/bc/adt/vit/wb/object_type/devck/object_name/ZMM_BASE'
  }
];

describe('packageUriOf', () => {
  it('answers the package the object is in, not the top of the tree', async () => {
    expect(await packageUriOf(path(nested), CLASS_URL)).toBe('/sap/bc/adt/packages/zmm_base');
  });

  it('reads the package from the object step even when the chain is deeper', async () => {
    const deeper = [
      { 'adtcore:uri': '/x/ZMM', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'ZMM' },
      { 'adtcore:uri': '/x/ZMM_BASE', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'ZMM_BASE' },
      { 'adtcore:uri': '/x/ZMM_BASE_UI', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'ZMM_BASE_UI' },
      {
        'adtcore:uri': CLASS_URL,
        'adtcore:type': 'CLAS/OC',
        'adtcore:name': 'ZCL_MM',
        'adtcore:parentUri': '/x/ZMM_BASE_UI'
      }
    ];
    expect(await packageUriOf(path(deeper), CLASS_URL)).toBe('/sap/bc/adt/packages/zmm_base_ui');
  });

  it('falls back to the innermost package when the object step carries no parent', async () => {
    const noParent = nested.map(step =>
      step['adtcore:uri'] === CLASS_URL ? { ...step, 'adtcore:parentUri': '' } : step);
    expect(await packageUriOf(path(noParent), CLASS_URL)).toBe('/sap/bc/adt/packages/zmm_base');
  });

  it('still answers for an object sitting directly in one package', async () => {
    const flat = [
      { 'adtcore:uri': '/x/$TMP', 'adtcore:type': 'DEVC/K', 'adtcore:name': '$TMP' },
      { 'adtcore:uri': CLASS_URL, 'adtcore:type': 'CLAS/OC', 'adtcore:name': 'ZCL_MM', 'adtcore:parentUri': '/x/$TMP' }
    ];
    expect(await packageUriOf(path(flat), CLASS_URL)).toBe('/sap/bc/adt/packages/%24tmp');
  });

  it('answers undefined rather than throwing when the path cannot be read', async () => {
    const broken = { findObjectPath: async () => { throw new Error('no such object'); } } as any;
    expect(await packageUriOf(broken, CLASS_URL)).toBeUndefined();
  });

  it('answers undefined when the path holds no package at all', async () => {
    expect(await packageUriOf(path([{ 'adtcore:uri': CLASS_URL, 'adtcore:type': 'CLAS/OC' }]), CLASS_URL))
      .toBeUndefined();
  });
});
