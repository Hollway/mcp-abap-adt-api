import {
  locateType,
  locateMethod,
  classSourceUrl,
  interfaceSourceUrl,
  objectUrlOf
} from '../lib/symbolPosition';

const CLASS_SOURCE = [
  '*&---------------------------------------------------------------------*',
  '* CLASS zcl_app_old DEFINITION - the predecessor, in a comment',
  'CLASS zcl_app_pck_plan DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    INTERFACES zif_app_c.',
  '    METHODS constructor IMPORTING iv_werks TYPE werks_d.',
  '    CLASS-METHODS check_plan',
  '      IMPORTING iv_vbeln TYPE vbeln',
  '      RETURNING VALUE(rv_ok) TYPE abap_bool.',
  '    METHODS:',
  '      plan_route,',
  '      plan_route_undo.',
  'ENDCLASS.',
  '',
  'CLASS zcl_app_pck_plan IMPLEMENTATION.',
  '  METHOD constructor.',
  '    RETURN.',
  '  ENDMETHOD.',
  '  METHOD check_plan.',
  '    RETURN.',
  '  ENDMETHOD.',
  '  METHOD plan_route.',
  '    RETURN.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\r\n');

describe('locateType', () => {
  it('finds the class declaration and points at the name', () => {
    const at = locateType(CLASS_SOURCE, 'ZCL_APP_PCK_PLAN');
    expect(at).toBeDefined();
    expect(at!.line).toBe(3);
    expect(at!.kind).toBe('definition');
    expect(CLASS_SOURCE.split('\r\n')[at!.line - 1].slice(at!.column, at!.endColumn))
      .toBe('zcl_app_pck_plan');
  });

  it('skips a commented-out declaration', () => {
    expect(locateType(CLASS_SOURCE, 'zcl_app_old')).toBeUndefined();
  });

  it('finds an interface declaration', () => {
    expect(locateType('INTERFACE zif_app_c PUBLIC.', 'ZIF_APP_C')).toMatchObject({
      line: 1,
      column: 10,
      kind: 'definition'
    });
  });

  it('is undefined for a name that is only used, never declared', () => {
    expect(locateType(CLASS_SOURCE, 'zif_app_c')).toBeUndefined();
  });
});

describe('locateMethod', () => {
  it('prefers the declaration over the implementation', () => {
    const at = locateMethod(CLASS_SOURCE, 'check_plan');
    expect(at).toMatchObject({ line: 7, kind: 'declaration' });
    expect(CLASS_SOURCE.split('\r\n')[at!.line - 1].slice(at!.column, at!.endColumn))
      .toBe('check_plan');
  });

  it('finds a plain METHODS declaration', () => {
    expect(locateMethod(CLASS_SOURCE, 'constructor')).toMatchObject({ line: 6, kind: 'declaration' });
  });

  it('finds a name listed under a chained METHODS:', () => {
    expect(locateMethod(CLASS_SOURCE, 'plan_route')).toMatchObject({ line: 11, kind: 'declaration' });
    expect(locateMethod(CLASS_SOURCE, 'plan_route_undo')).toMatchObject({ line: 12, kind: 'declaration' });
  });

  it('falls back to the implementation when there is no declaration', () => {
    const implOnly = [
      'CLASS zcl_x IMPLEMENTATION.',
      '  METHOD only_here.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n');
    expect(locateMethod(implOnly, 'only_here')).toMatchObject({ line: 2, kind: 'implementation' });
  });

  it('matches whole words, not fragments of a longer name', () => {
    const at = locateMethod(CLASS_SOURCE, 'plan_route');
    expect(at!.line).toBe(11);
    expect(locateMethod('    METHODS plan_route_undo.', 'plan_route')).toBeUndefined();
  });

  it('is undefined for a method the source does not have', () => {
    expect(locateMethod(CLASS_SOURCE, 'no_such_method')).toBeUndefined();
  });
});

describe('urls', () => {
  it('builds class and interface source urls', () => {
    expect(classSourceUrl('ZCL_APP')).toBe('/sap/bc/adt/oo/classes/zcl_app/source/main');
    expect(interfaceSourceUrl(' ZIF_APP_C ')).toBe('/sap/bc/adt/oo/interfaces/zif_app_c/source/main');
  });

  it('strips the source part to get the object url', () => {
    expect(objectUrlOf('/sap/bc/adt/oo/classes/zcl_app/source/main'))
      .toBe('/sap/bc/adt/oo/classes/zcl_app');
    expect(objectUrlOf('/sap/bc/adt/oo/classes/zcl_app/source/main#start=1,0'))
      .toBe('/sap/bc/adt/oo/classes/zcl_app');
    expect(objectUrlOf('/sap/bc/adt/ddic/domains/zd')).toBe('/sap/bc/adt/ddic/domains/zd');
  });
});
