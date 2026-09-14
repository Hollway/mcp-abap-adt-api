import { statementsOf, localNames, extractCalls, extractCallsAcross, groupCalls } from '../lib/abapCalls';

/**
 * A class written the way the ones on a real system are: a chain declaration,
 * a call over three lines, a literal with a period in it, an interface call
 * through a parameter, a commented-out call, and the two dynamic forms that no
 * scan can resolve.
 */
const CLASS_SOURCE = [
  'CLASS zcl_app_order DEFINITION PUBLIC INHERITING FROM zcl_app_base.',
  '  PUBLIC SECTION.',
  '    INTERFACES: zif_app_log, if_serializable_object.',
  '    METHODS save IMPORTING io_ctx TYPE REF TO zcl_app_ctx.',
  '  PRIVATE SECTION.',
  '    DATA mo_helper TYPE REF TO zcl_app_helper.',
  'ENDCLASS.',
  '',
  'CLASS zcl_app_order IMPLEMENTATION.',
  '  METHOD save.',
  '    DATA: lt_orders TYPE STANDARD TABLE OF zorders,',
  '          lv_text   TYPE string.',
  '',
  '    lv_text = zcl_app_helper=>co_prefix && \'one. two\'.',
  '    mo_helper->add( iv_text = lv_text ).',
  '    io_ctx->zif_app_log~write( lv_text ).',
  '    CALL METHOD zcl_app_helper=>check',
  '      EXPORTING iv_id = zcl_app_const=>co_id.',
  '    CALL METHOD (lv_class)=>(lv_meth).',
  '    DATA(lo_writer) = NEW zcl_app_writer( ).',
  '    CREATE OBJECT mo_helper TYPE zcl_app_helper_v2.',
  '    CREATE OBJECT lo_unknown.',
  '    CALL FUNCTION \'Z_APP_SAVE\'',
  '      EXPORTING',
  '        iv_id = lv_text.',
  '    CALL FUNCTION lv_fm.',
  '    SELECT * FROM zorders INTO TABLE @lt_orders.',
  '    UPDATE zorders SET flag = \'X\' WHERE id = lv_text.',
  '    DELETE lt_orders WHERE id IS INITIAL.',
  '    MODIFY zorders FROM TABLE lt_orders.',
  '    RAISE EXCEPTION TYPE zcx_app_error.',
  '*   zcl_ghost=>never( ).',
  '    lo_built = zcl_app_factory=>create( )->build( ).',
  '    lo_other->run( ).',
  '    cl_gui_frontend_services=>file_exist( ).',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\n');

const REPORT_SOURCE = [
  'REPORT zr_app_daily.',
  '',
  'INCLUDE zr_app_daily_f01.',
  'TABLES zorders.',
  '',
  'START-OF-SELECTION.',
  '  PERFORM fill_list IN PROGRAM zr_app_forms.',
  '  PERFORM (lv_form) IN PROGRAM (lv_prog).',
  '  SUBMIT zr_app_report AND RETURN.',
  '  SUBMIT (lv_report) AND RETURN.',
  '  CALL TRANSACTION \'ZAPP01\'.',
  '  SELECT * FROM (lv_table) INTO TABLE @DATA(lt_any).'
].join('\n');

const calls = extractCalls(CLASS_SOURCE);
const find = (kind: string, target: string) =>
  calls.calls.filter(call => call.kind === kind && call.target === target);

describe('statementsOf', () => {
  it('joins a statement written over several lines, and keeps the line it starts on', () => {
    const statements = statementsOf(CLASS_SOURCE);
    const callFunction = statements.find(s => /^CALL FUNCTION 'Z_APP_SAVE'/i.test(s.text));
    expect(callFunction?.text).toBe("CALL FUNCTION 'Z_APP_SAVE' EXPORTING iv_id = lv_text");
    expect(callFunction?.line).toBe(23);
  });

  it('does not end a statement on a period inside a literal', () => {
    const statements = statementsOf("    lv_text = 'one. two'.\n    lv_next = 1.");
    expect(statements.map(s => s.text)).toEqual([
      "lv_text = 'one. two'",
      'lv_next = 1'
    ]);
  });

  it('leaves a comment out, whether it is a whole line or the end of one', () => {
    const statements = statementsOf([
      '* zcl_ghost=>never( ).',
      '  lv_a = 1. " zcl_ghost=>never( ).',
      '  lv_b = |a "quoted" thing|.'
    ].join('\n'));
    expect(statements.map(s => s.text)).toEqual(['lv_a = 1', 'lv_b = |a "quoted" thing|']);
  });

  it('splits a chain statement into one statement per part, each on its own line', () => {
    const statements = statementsOf(CLASS_SOURCE).filter(s => /^DATA /i.test(s.text));
    expect(statements).toEqual([
      { text: 'DATA mo_helper TYPE REF TO zcl_app_helper', line: 6 },
      { text: 'DATA lt_orders TYPE STANDARD TABLE OF zorders', line: 11 },
      { text: 'DATA lv_text TYPE string', line: 12 }
    ]);
  });

  it('does not mistake a colon inside a literal for a chain', () => {
    const statements = statementsOf("  lv_time = 'at 12:00 sharp'.");
    expect(statements).toEqual([{ text: "lv_time = 'at 12:00 sharp'", line: 1 }]);
  });

  it('keeps a last statement that was never ended with a period', () => {
    expect(statementsOf('  lv_a = 1').map(s => s.text)).toEqual(['lv_a = 1']);
  });
});

describe('localNames', () => {
  const locals = localNames(statementsOf(CLASS_SOURCE));

  it('reads the class behind a reference, wherever it was declared', () => {
    expect(locals.refTypes.get('MO_HELPER')).toBe('ZCL_APP_HELPER_V2');
    expect(locals.refTypes.get('IO_CTX')).toBe('ZCL_APP_CTX');
    expect(locals.refTypes.get('LO_WRITER')).toBe('ZCL_APP_WRITER');
  });

  it('collects the names this source declares, so an internal table is not read as a table', () => {
    expect(locals.declared.has('LT_ORDERS')).toBe(true);
    expect(locals.declared.has('LV_TEXT')).toBe(true);
    expect(locals.declared.has('ZORDERS')).toBe(false);
  });
});

describe('extractCalls', () => {
  it('finds a static method call, and keeps a constant of the same class apart from it', () => {
    expect(find('method', 'ZCL_APP_HELPER').map(call => call.member).sort()).toEqual(['CHECK']);
    expect(find('reference', 'ZCL_APP_HELPER')[0]?.member).toBe('CO_PREFIX');
    expect(find('reference', 'ZCL_APP_CONST')[0]?.member).toBe('CO_ID');
  });

  it('does not read a constructor expression over a type as a call', () => {
    // VALUE zcl_x=>tt_row( ) wears the parentheses of a method call and is a
    // type of that class - found live on ZCL_YTRACKER_ZB_NOTIFIER.
    const found = extractCalls([
      '  DATA(lt_return) = VALUE zcl_mm_return=>tt_return( ).',
      '  DATA(lv_one) = zcl_mm_return=>build( ).'
    ].join('\n'));
    expect(found.calls.map(call => `${call.kind}/${call.member}`)).toEqual([
      'reference/TT_RETURN',
      'method/BUILD'
    ]);
  });

  it('resolves a call through a reference to the class the reference was declared with', () => {
    const added = find('method', 'ZCL_APP_HELPER_V2');
    expect(added.map(call => call.member)).toEqual(['ADD']);
    expect(added[0].line).toBe(15);
  });

  it('names the interface, not the class, when the call is interface-qualified', () => {
    expect(find('method', 'ZIF_APP_LOG').map(call => call.member)).toEqual(['WRITE']);
  });

  it('reports NEW, CREATE OBJECT with a type, and the exception that is raised', () => {
    expect(find('constructor', 'ZCL_APP_WRITER')).toHaveLength(1);
    expect(find('constructor', 'ZCL_APP_HELPER_V2')).toHaveLength(1);
    expect(find('exception', 'ZCX_APP_ERROR')).toHaveLength(1);
  });

  it('reports the function module called by name', () => {
    expect(find('function', 'Z_APP_SAVE')).toHaveLength(1);
  });

  it('reports database access and leaves internal tables out of it', () => {
    expect(find('table', 'ZORDERS')).toHaveLength(3);
    expect(find('table', 'LT_ORDERS')).toHaveLength(0);
  });

  it('reports what the class inherits from and the interfaces it implements', () => {
    expect(find('inherits', 'ZCL_APP_BASE')).toHaveLength(1);
    expect(find('implements', 'ZIF_APP_LOG')).toHaveLength(1);
  });

  it('never reports a commented-out call', () => {
    expect(calls.calls.some(call => call.target === 'ZCL_GHOST')).toBe(false);
  });

  it('counts the standard objects it left out rather than hiding that it did', () => {
    expect(calls.calls.some(call => call.target.startsWith('CL_GUI'))).toBe(false);
    expect(calls.standardTargetsHidden).toBeGreaterThan(0);
    const withStandard = extractCalls(CLASS_SOURCE, { onlyCustom: false });
    expect(withStandard.calls.some(call => call.target === 'CL_GUI_FRONTEND_SERVICES')).toBe(true);
    expect(withStandard.calls.some(call => call.target === 'IF_SERIALIZABLE_OBJECT')).toBe(true);
  });

  it('names every call it cannot resolve, with the reason it could not', () => {
    const reasons = calls.unresolved.map(entry => entry.reason);
    expect(reasons).toContain('the class and the method are both in variables');
    expect(reasons).toContain('the function module name is in a variable');
    expect(reasons).toContain('LO_OTHER is not declared as a reference in this source, so its class is unknown here');
    expect(reasons).toContain('LO_UNKNOWN is not declared as a reference in this source, so its class is unknown here');
    expect(reasons.some(reason => reason.startsWith('a chained call'))).toBe(true);
  });

  it('still finds the resolvable half of a chained call', () => {
    expect(find('method', 'ZCL_APP_FACTORY').map(call => call.member)).toEqual(['CREATE']);
  });

  it('keeps only the kinds that were asked for', () => {
    const onlyTables = extractCalls(CLASS_SOURCE, { kinds: ['table'] });
    expect(new Set(onlyTables.calls.map(call => call.kind))).toEqual(new Set(['table']));
    expect(onlyTables.calls.length).toBe(3);
  });

  it('reads a report: its include, its tables, the forms and programs it starts', () => {
    const report = extractCalls(REPORT_SOURCE);
    const kinds = report.calls.map(call => `${call.kind}:${call.target}${call.member ? `/${call.member}` : ''}`);
    expect(kinds).toContain('include:ZR_APP_DAILY_F01');
    expect(kinds).toContain('table:ZORDERS');
    expect(kinds).toContain('form:ZR_APP_FORMS/FILL_LIST');
    expect(kinds).toContain('program:ZR_APP_REPORT');
    expect(kinds).toContain('transaction:ZAPP01');
  });

  it('reports the dynamic form, program and table of a report instead of dropping them', () => {
    const report = extractCalls(REPORT_SOURCE);
    expect(report.unresolved.map(entry => entry.kind).sort()).toEqual(['form', 'program', 'table']);
  });
});

describe('types named in declarations', () => {
  const typed = (source: string) =>
    extractCalls(source).calls.filter(call => call.kind === 'type')
      .map(call => `${call.target}${call.member ? `-${call.member}` : ''}`);

  it('reads the dictionary type a declaration names, in each form it is written', () => {
    expect(typed('DATA lt_orders TYPE STANDARD TABLE OF zorders.')).toEqual(['ZORDERS']);
    expect(typed('DATA lv_id TYPE zde_order_id.')).toEqual(['ZDE_ORDER_ID']);
    expect(typed('DATA lv_id LIKE zorders-id.')).toEqual(['ZORDERS-ID']);
    expect(typed('DATA lt_r TYPE RANGE OF zorders-id.')).toEqual(['ZORDERS-ID']);
    expect(typed('METHODS save IMPORTING is_order TYPE zorders.')).toEqual(['ZORDERS']);
  });

  it('reads the table a selection screen declares its range over', () => {
    expect(typed('SELECT-OPTIONS s_id FOR zorders-id.')).toEqual(['ZORDERS-ID']);
    expect(typed('RANGES r_id FOR zorders-id.')).toEqual(['ZORDERS-ID']);
  });

  it('leaves the language and the source\'s own names out of it', () => {
    // TYPE REF TO belongs to the declaration scan, which turns it into the
    // calls made through the reference - reporting it here would say the same
    // thing twice.
    expect(typed('DATA lo_x TYPE REF TO zcl_app_helper.')).toEqual([]);
    expect(typed('DATA lv_text TYPE string.')).toEqual([]);
    expect(typed('DATA lv_flag TYPE c LENGTH 8.')).toEqual([]);
    expect(typed('DATA lv_subrc LIKE sy-subrc.')).toEqual([]);
    expect(typed('TYPES ty_row TYPE zorders.\nDATA ls_row TYPE ty_row.')).toEqual(['ZORDERS']);
  });

  it('does not read the definition of a structure as a dependency on itself', () => {
    // How this backend serves a TABL/DT source - found on ZYTRPROJ, which
    // came out of the package graph calling itself.
    expect(typed('define type zytrproj { key mandt : mandt not null; }')).toEqual([]);
  });

  it('keeps a type owned by a class a reference to that class, not a type of its own', () => {
    const found = extractCalls('DATA lt_return TYPE zcl_mm_return=>tt_return.');
    expect(found.calls.map(call => `${call.kind}/${call.target}`)).toEqual(['reference/ZCL_MM_RETURN']);
  });

  it('counts a type as its own kind, so a table read and a table typed are told apart', () => {
    const found = extractCalls(CLASS_SOURCE);
    expect(found.calls.filter(call => call.kind === 'table' && call.target === 'ZORDERS')).toHaveLength(3);
    expect(found.calls.filter(call => call.kind === 'type' && call.target === 'ZORDERS')).toHaveLength(1);
  });
});

describe('macros', () => {
  const WITH_MACRO = [
    'DEFINE add_row.',
    '  CALL FUNCTION \'Z_APP_ADD\'',
    '    EXPORTING iv_id = &1.',
    'END-OF-DEFINITION.',
    '',
    'START-OF-SELECTION.',
    '  add_row lv_id.',
    '  add_row = 5.'
  ].join('\n');

  it('reports the line that expands a macro, and still reports what the body reaches', () => {
    const found = extractCalls(WITH_MACRO);
    expect(found.calls.map(call => `${call.kind}:${call.target}`)).toEqual(['function:Z_APP_ADD']);
    const macros = found.unresolved.filter(entry => entry.kind === 'macro');
    expect(macros).toHaveLength(1);
    expect(macros[0].line).toBe(7);
    expect(macros[0].reason).toMatch(/expands the macro ADD_ROW, defined at line 1/);
  });

  it('leaves a macro out of the kinds a scan was narrowed to', () => {
    const found = extractCalls(WITH_MACRO, { kinds: ['function'] });
    expect(found.unresolved).toHaveLength(0);
  });

  it('finds a macro defined in one include of an object and expanded in another', () => {
    const top = 'DEFINE add_row.\n  WRITE &1.\nEND-OF-DEFINITION.';
    const f01 = 'FORM run.\n  add_row lv_id.\nENDFORM.';
    const together = extractCallsAcross([
      { name: 'LZAPPTOP', source: top },
      { name: 'LZAPPF01', source: f01 }
    ]);
    const macros = together.unresolved.filter(entry => entry.kind === 'macro');
    expect(macros.map(entry => entry.source)).toEqual(['LZAPPF01']);
  });
});

describe('groupCalls', () => {
  it('groups by what is called, heaviest first, and counts the places it did not list', () => {
    const grouped = groupCalls(calls.calls, { maxPlacesPerTarget: 2 });
    const orders = grouped.targets.find(entry => entry.target === 'ZORDERS');
    expect(grouped.targets[0].calls).toBeGreaterThanOrEqual(orders!.calls);
    expect(orders?.calls).toBe(3);
    expect(orders?.places).toHaveLength(2);
    expect(orders?.morePlaces).toBe(1);
  });

  it('lists the members reached on a target, and cuts a long statement to size', () => {
    const grouped = groupCalls(calls.calls, { maxStatementChars: 40 });
    const helper = grouped.targets.find(entry => entry.target === 'ZCL_APP_HELPER' && entry.kind === 'method');
    expect(helper?.members).toEqual(['CHECK']);
    const longest = grouped.targets.flatMap(entry => entry.places).map(place => place.statement);
    expect(longest.every(text => text.length <= 41)).toBe(true);
  });

  it('says how many targets it left out when there are more than asked for', () => {
    const grouped = groupCalls(calls.calls, { maxTargets: 2 });
    expect(grouped.targets).toHaveLength(2);
    expect(grouped.targetsHidden).toBeGreaterThan(0);
  });
});

describe('extractCallsAcross', () => {
  // A function group as they really are: the globals in the TOP include, the
  // code that uses them in another - found this way on a live one.
  const TOP = 'DATA go_worker TYPE REF TO zcl_app_worker.';
  const F01 = [
    'FORM run.',
    '  go_worker->start( ).',
    'ENDFORM.'
  ].join('\n');

  it('resolves a call through a reference declared in another include of the same object', () => {
    const alone = extractCalls(F01);
    expect(alone.calls).toHaveLength(0);
    expect(alone.unresolved[0].reason).toMatch(/GO_WORKER is not declared/);

    const together = extractCallsAcross([{ name: 'LZAPPTOP', source: TOP }, { name: 'LZAPPF01', source: F01 }]);
    expect(together.unresolved).toHaveLength(0);
    expect(together.calls).toEqual([{
      target: 'ZCL_APP_WORKER',
      kind: 'method',
      member: 'START',
      line: 2,
      statement: 'go_worker->start( )',
      source: 'LZAPPF01'
    }]);
  });

  it('lets a source keep its own meaning for a name another source also declares', () => {
    const other = 'DATA go_worker TYPE REF TO zcl_app_other.';
    const together = extractCallsAcross([
      { name: 'LZAPPTOP', source: TOP },
      { name: 'LZAPPF01', source: `${other}\n${F01}` }
    ]);
    expect(together.calls.map(call => call.target)).toEqual(['ZCL_APP_OTHER']);
  });

  it('names no source when there is only one, so a single object reads as before', () => {
    const one = extractCallsAcross([{ name: 'ZCL_ONE', source: 'DATA(x) = NEW zcl_app_worker( ).' }]);
    expect(one.calls[0].source).toBeUndefined();
  });
});
