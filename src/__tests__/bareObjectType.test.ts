import { fullObjectType, sourceUrlFor, objectUrlFor } from '../lib/packageWalk';

/**
 * A caller naming an object by hand writes CLAS, not CLAS/OC.
 *
 * The URL map is keyed by the full ADT type, because that is what a repository
 * node carries - so every tool resolving a URL through it refused the bare
 * type, atcCheck with "does not know the ADT URI of a CLAS". That is a refusal
 * of the spelling, not of the object.
 */
describe('fullObjectType', () => {
  it('completes the bare transport type', () => {
    expect(fullObjectType('CLAS')).toBe('CLAS/OC');
    expect(fullObjectType('intf')).toBe('INTF/OI');
    expect(fullObjectType('PROG')).toBe('PROG/P');
    expect(fullObjectType('FUGR')).toBe('FUGR/F');
  });

  it('leaves a complete type as it is', () => {
    expect(fullObjectType('CLAS/OC')).toBe('CLAS/OC');
    expect(fullObjectType('TABL/DS')).toBe('TABL/DS');
  });

  it('leaves a type it does not know alone, so the caller still gets its own refusal', () => {
    expect(fullObjectType('SRVB')).toBe('SRVB');
  });
});

describe('sourceUrlFor with a bare type', () => {
  it('resolves CLAS the same as CLAS/OC', () => {
    expect(sourceUrlFor('CLAS', 'ZCL_APP')).toBe(sourceUrlFor('CLAS/OC', 'ZCL_APP'));
    expect(objectUrlFor('CLAS', 'ZCL_APP')).toBe('/sap/bc/adt/oo/classes/zcl_app');
  });

  it('resolves the other bare types callers write by hand', () => {
    expect(objectUrlFor('PROG', 'ZR_APP')).toBe('/sap/bc/adt/programs/programs/zr_app');
    expect(objectUrlFor('TABL', 'ZSTRUCT')).toBe('/sap/bc/adt/ddic/structures/zstruct');
  });

  it('still answers nothing for a type with no source collection', () => {
    expect(sourceUrlFor('SRVB', 'ZUI_SRVB')).toBeUndefined();
  });
});
