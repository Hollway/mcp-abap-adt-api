import { parseMethodSignature, listMethods, MethodSignatureError } from '../lib/methodSignature';

const classSource = (...definition: string[]) => [
  'CLASS zcl_mm DEFINITION',
  '  PUBLIC',
  '  FINAL',
  '  CREATE PUBLIC .',
  '',
  '  PUBLIC SECTION.',
  ...definition.map(line => `    ${line}`),
  'ENDCLASS.',
  '',
  'CLASS zcl_mm IMPLEMENTATION.',
  'ENDCLASS.'
].join('\n');

describe('parseMethodSignature', () => {
  it('reads a static method spread over several lines', () => {
    const source = classSource(
      'CLASS-METHODS get_stawn',
      '  IMPORTING !iv_matnr TYPE matnr',
      '            iv_werks  TYPE werks_d OPTIONAL',
      '  RETURNING VALUE(rv_stawn) TYPE stawn',
      '  RAISING   cx_mm_error.'
    );
    const signature = parseMethodSignature(source, 'GET_STAWN');
    expect(signature).toMatchObject({
      name: 'GET_STAWN',
      isStatic: true,
      visibility: 'public',
      raising: ['CX_MM_ERROR'],
      exceptions: []
    });
    expect(signature.importing).toEqual([
      { name: 'IV_MATNR', type: 'matnr' },
      { name: 'IV_WERKS', type: 'werks_d', optional: true }
    ]);
    expect(signature.returning).toEqual({ name: 'RV_STAWN', type: 'stawn', byValue: true });
  });

  it('reads a method whose name is given in lower case', () => {
    const source = classSource('CLASS-METHODS get_stawn RETURNING VALUE(rv) TYPE stawn.');
    expect(parseMethodSignature(source, 'get_stawn').name).toBe('GET_STAWN');
  });

  it('tells a static method from an instance one', () => {
    const source = classSource(
      'METHODS do_it IMPORTING iv_a TYPE c.',
      'CLASS-METHODS do_it_static IMPORTING iv_a TYPE c.'
    );
    expect(parseMethodSignature(source, 'DO_IT').isStatic).toBe(false);
    expect(parseMethodSignature(source, 'DO_IT_STATIC').isStatic).toBe(true);
  });

  it('reads every section of a full signature', () => {
    const source = classSource(
      'CLASS-METHODS everything',
      '  IMPORTING iv_in    TYPE string',
      '  EXPORTING ev_out   TYPE i',
      '  CHANGING  cv_both  TYPE flag',
      '  RETURNING VALUE(rv_result) TYPE abap_bool',
      '  EXCEPTIONS not_found no_authority.'
    );
    const signature = parseMethodSignature(source, 'EVERYTHING');
    expect(signature.importing.map(p => p.name)).toEqual(['IV_IN']);
    expect(signature.exporting.map(p => p.name)).toEqual(['EV_OUT']);
    expect(signature.changing.map(p => p.name)).toEqual(['CV_BOTH']);
    expect(signature.returning?.name).toBe('RV_RESULT');
    expect(signature.exceptions).toEqual(['NOT_FOUND', 'NO_AUTHORITY']);
  });

  it('reads several parameters written on one line', () => {
    const source = classSource('CLASS-METHODS m IMPORTING iv_a TYPE c iv_b TYPE i iv_c TYPE string.');
    expect(parseMethodSignature(source, 'M').importing.map(p => p.name)).toEqual(['IV_A', 'IV_B', 'IV_C']);
  });

  it('keeps a composite type expression whole', () => {
    const source = classSource(
      'CLASS-METHODS m',
      '  IMPORTING io_object TYPE REF TO cl_abap_typedescr',
      '            it_rows   TYPE STANDARD TABLE',
      '            iv_like   LIKE sy-datum.'
    );
    const importing = parseMethodSignature(source, 'M').importing;
    expect(importing[0]).toEqual({ name: 'IO_OBJECT', type: 'REF TO cl_abap_typedescr' });
    expect(importing[1]).toEqual({ name: 'IT_ROWS', type: 'STANDARD TABLE' });
    expect(importing[2]).toEqual({ name: 'IV_LIKE', like: 'sy-datum' });
  });

  it('reads a DEFAULT and an OPTIONAL', () => {
    const source = classSource(
      "CLASS-METHODS m IMPORTING iv_a TYPE c DEFAULT 'X' iv_b TYPE i OPTIONAL."
    );
    const importing = parseMethodSignature(source, 'M').importing;
    expect(importing[0]).toMatchObject({ name: 'IV_A', default: "'X'" });
    expect(importing[1]).toMatchObject({ name: 'IV_B', optional: true });
  });

  it('reads one method out of a chained declaration', () => {
    const source = classSource(
      'CLASS-METHODS: first  IMPORTING iv_a TYPE c,',
      '               second RETURNING VALUE(rv) TYPE i,',
      '               third  IMPORTING iv_x TYPE i EXPORTING ev_y TYPE i.'
    );
    expect(parseMethodSignature(source, 'FIRST').importing.map(p => p.name)).toEqual(['IV_A']);
    expect(parseMethodSignature(source, 'SECOND').returning?.name).toBe('RV');
    expect(parseMethodSignature(source, 'THIRD').exporting.map(p => p.name)).toEqual(['EV_Y']);
  });

  it('does not let a chain entry take the next one parameters', () => {
    const source = classSource(
      'CLASS-METHODS: first IMPORTING iv_a TYPE c,',
      '               second IMPORTING iv_b TYPE c.'
    );
    expect(parseMethodSignature(source, 'FIRST').importing.map(p => p.name)).toEqual(['IV_A']);
  });

  it('says which visibility section a method sits in', () => {
    const source = [
      'CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC .',
      '  PUBLIC SECTION.',
      '    CLASS-METHODS open IMPORTING iv_a TYPE c.',
      '  PROTECTED SECTION.',
      '    CLASS-METHODS middle IMPORTING iv_a TYPE c.',
      '  PRIVATE SECTION.',
      '    CLASS-METHODS hidden IMPORTING iv_a TYPE c.',
      'ENDCLASS.',
      'CLASS zcl_x IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n');
    expect(parseMethodSignature(source, 'OPEN').visibility).toBe('public');
    expect(parseMethodSignature(source, 'MIDDLE').visibility).toBe('protected');
    expect(parseMethodSignature(source, 'HIDDEN').visibility).toBe('private');
  });

  it('ignores a comment inside the declaration', () => {
    const source = classSource(
      'CLASS-METHODS m " the one that matters',
      '  IMPORTING iv_a TYPE c. " and its parameter'
    );
    expect(parseMethodSignature(source, 'M').importing.map(p => p.name)).toEqual(['IV_A']);
  });

  it('reads a method with no parameters at all', () => {
    const source = classSource('CLASS-METHODS reset.');
    const signature = parseMethodSignature(source, 'RESET');
    expect(signature.importing).toEqual([]);
    expect(signature.returning).toBeUndefined();
  });

  it('takes the RESUMABLE wrapper off a raised exception', () => {
    const source = classSource('CLASS-METHODS m RAISING RESUMABLE(cx_a) cx_b.');
    expect(parseMethodSignature(source, 'M').raising).toEqual(['CX_A', 'CX_B']);
  });

  it('marks a redefinition, whose parameters belong to the parent', () => {
    const source = classSource('METHODS if_x~do_it REDEFINITION.');
    expect(parseMethodSignature(source, 'IF_X~DO_IT')).toMatchObject({
      name: 'IF_X~DO_IT',
      redefinition: true,
      importing: []
    });
  });

  it('answers a name that is not there with the names that are', () => {
    const source = classSource(
      'CLASS-METHODS get_stawn RETURNING VALUE(rv) TYPE stawn.',
      'METHODS do_it.'
    );
    expect(() => parseMethodSignature(source, 'GET_STAWNN'))
      .toThrow(/does not declare GET_STAWNN[\s\S]*GET_STAWN \(static\), DO_IT/);
  });

  it('refuses an empty name', () => {
    expect(() => parseMethodSignature(classSource('CLASS-METHODS m.'), '')).toThrow(MethodSignatureError);
  });

  it('does not mistake a DATA or a TYPES declaration for a method', () => {
    const source = classSource(
      'DATA mv_x TYPE i.',
      'TYPES ty_t TYPE STANDARD TABLE OF mara WITH DEFAULT KEY.',
      'CLASS-METHODS m IMPORTING iv_a TYPE c.'
    );
    expect(listMethods(source).map(entry => entry.name)).toEqual(['M']);
  });
});

describe('listMethods', () => {
  it('lists every declared method with its kind', () => {
    const source = classSource(
      'CLASS-METHODS: a IMPORTING iv_a TYPE c,',
      '               b RETURNING VALUE(rv) TYPE i.',
      'METHODS c.'
    );
    expect(listMethods(source)).toEqual([
      { name: 'A', isStatic: true, visibility: 'public' },
      { name: 'B', isStatic: true, visibility: 'public' },
      { name: 'C', isStatic: false, visibility: 'public' }
    ]);
  });

  it('lists nothing for a class that declares nothing', () => {
    expect(listMethods(classSource())).toEqual([]);
  });
});
