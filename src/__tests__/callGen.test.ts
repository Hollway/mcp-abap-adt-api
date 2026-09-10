import {
  abapValue,
  buildFunctionCall,
  buildMethodCall,
  interpretCall,
  variableFor,
  checkObjectName,
  concreteType,
  CallGenError,
  OTHERS_SUBRC
} from '../lib/callGen';
import type { FunctionSignature } from '../lib/functionModule';

const signature = (over: Partial<FunctionSignature> = {}): FunctionSignature => ({
  name: 'Z_APP_GET_INVOICE',
  importing: [],
  exporting: [],
  changing: [],
  tables: [],
  exceptions: [],
  ...over
});

const body = (lines: string[]) => lines.join('\n');

describe('abapValue', () => {
  it('writes a string as a backtick literal so trailing blanks survive', () => {
    expect(abapValue('1000 ', 'IV_X')).toBe('`1000 `');
  });

  it('doubles a backtick inside a string', () => {
    expect(abapValue('a`b', 'IV_X')).toBe('`a``b`');
  });

  it('leaves a number unquoted and turns a boolean into the ABAP constant', () => {
    expect(abapValue(42, 'IV_X')).toBe('42');
    expect(abapValue(-1.5, 'IV_X')).toBe('-1.5');
    expect(abapValue(true, 'IV_X')).toBe('abap_true');
    expect(abapValue(false, 'IV_X')).toBe('abap_false');
  });

  it('writes a structure as a VALUE expression', () => {
    expect(abapValue({ werks: '1000', menge: 5 }, 'IS_X')).toBe('VALUE #( werks = `1000` menge = 5 )');
  });

  it('writes a table of structures as rows', () => {
    expect(abapValue([{ matnr: '1' }, { matnr: '2' }], 'IT_X'))
      .toBe('VALUE #( ( matnr = `1` ) ( matnr = `2` ) )');
  });

  it('writes a table of elementary rows, and an empty one', () => {
    expect(abapValue(['a', 'b'], 'IT_X')).toBe('VALUE #( ( `a` ) ( `b` ) )');
    expect(abapValue([], 'IT_X')).toBe('VALUE #( )');
  });

  it('writes a table nested in a structure', () => {
    expect(abapValue({ id: 7, items: [{ pos: 10 }] }, 'IS_X'))
      .toBe('VALUE #( id = 7 items = VALUE #( ( pos = 10 ) ) )');
  });

  it('skips a component whose value is null rather than passing something wrong', () => {
    expect(abapValue({ a: '1', b: null }, 'IS_X')).toBe('VALUE #( a = `1` )');
  });

  it('refuses a component name that is not a name', () => {
    expect(() => abapValue({ 'x = 1. DELETE FROM ekpo. y': '1' }, 'IS_X')).toThrow(CallGenError);
    expect(() => abapValue({ "a' ": '1' }, 'IS_X')).toThrow(/not a valid component name/);
  });

  it('refuses a number ABAP has no form for', () => {
    expect(() => abapValue(Number.POSITIVE_INFINITY, 'IV_X')).toThrow(/Infinity/);
    expect(() => abapValue(Number.NaN, 'IV_X')).toThrow(CallGenError);
  });
});

describe('checkObjectName', () => {
  it('accepts a plain and a namespaced name', () => {
    expect(checkObjectName('Z_APP_GET_INVOICE', 'x')).toBe('Z_APP_GET_INVOICE');
    expect(checkObjectName('/SAPAPO/DM_ORDER', 'x')).toBe('/SAPAPO/DM_ORDER');
  });

  it('refuses anything that could carry code', () => {
    expect(() => checkObjectName("Z'. DELETE FROM ekpo. \"", 'function module name')).toThrow(CallGenError);
    expect(() => checkObjectName('', 'function module name')).toThrow(CallGenError);
  });
});

describe('variableFor', () => {
  it('names a variable after the parameter', () => {
    expect(variableFor('IV_LGNUM', 1)).toBe('p_iv_lgnum');
  });

  it('falls back to a numbered name when that would be too long for ABAP', () => {
    expect(variableFor('IV_A_VERY_LONG_PARAMETER_NAME_X', 3)).toBe('p_3');
  });
});

describe('buildFunctionCall', () => {
  it('passes an importing parameter in the EXPORTING block and reads an exporting one back', () => {
    const call = buildFunctionCall(
      signature({
        importing: [{ name: 'IV_LGNUM', type: 'LGNUM' }],
        exporting: [{ name: 'ET_INVOICE', type: 'ZAPP_INVOICE_LIST_TT' }]
      }),
      { IV_LGNUM: '101' }
    );
    const text = body(call.code);
    expect(text).toContain('DATA p_iv_lgnum TYPE LGNUM.');
    expect(text).toContain('DATA p_et_invoice TYPE ZAPP_INVOICE_LIST_TT.');
    expect(text).toContain('p_iv_lgnum = `101`.');
    expect(text).toContain("CALL FUNCTION 'Z_APP_GET_INVOICE'");
    expect(text).toContain('      EXPORTING\n        iv_lgnum = p_iv_lgnum');
    expect(text).toContain('      IMPORTING\n        et_invoice = p_et_invoice');
    expect(call.results).toEqual([
      { binding: 'ET_INVOICE', parameter: 'ET_INVOICE', kind: 'exporting' }
    ]);
    expect(call.supplied).toEqual(['IV_LGNUM']);
  });

  it('leaves out an optional parameter nobody passed, so the callee uses its own default', () => {
    const call = buildFunctionCall(
      signature({ importing: [{ name: 'IV_A', type: 'CHAR1' }, { name: 'IV_B', type: 'CHAR1', optional: true }] }),
      { IV_A: 'X' }
    );
    const text = body(call.code);
    expect(text).toContain('iv_a = p_iv_a');
    expect(text).not.toContain('iv_b = p_iv_b');
  });

  it('refuses a call that leaves a mandatory parameter empty', () => {
    expect(() => buildFunctionCall(
      signature({ importing: [{ name: 'IS_HEADER51', type: 'V51PS_HEADER' }] }),
      {}
    )).toThrow(/needs a value for IS_HEADER51/);
  });

  it('counts a parameter with a DEFAULT as supplied by the interface', () => {
    expect(() => buildFunctionCall(
      signature({ importing: [{ name: 'IV_A', type: 'CHAR1', default: "'X'" }] }),
      {}
    )).not.toThrow();
  });

  it('names the parameters it does take when one is misspelled', () => {
    expect(() => buildFunctionCall(
      signature({ importing: [{ name: 'IV_LGNUM', type: 'LGNUM' }] }),
      { IV_LGNUMM: '1' }
    )).toThrow(/no parameter IV_LGNUMM[\s\S]*IV_LGNUM \(importing\)/);
  });

  it('refuses a value passed for something that only comes back', () => {
    expect(() => buildFunctionCall(
      signature({ exporting: [{ name: 'EV_X', type: 'CHAR1' }] }),
      { EV_X: '1' }
    )).toThrow(/comes back, it is not supplied/);
  });

  it('accepts a value for a CHANGING or TABLES parameter, which go both ways', () => {
    const call = buildFunctionCall(
      signature({
        changing: [{ name: 'CV_X', type: 'CHAR1' }],
        tables: [{ name: 'IT_ROWS', structure: 'MARA' }]
      }),
      { CV_X: 'A', IT_ROWS: [{ matnr: '1' }] }
    );
    const text = body(call.code);
    expect(text).toContain('DATA p_it_rows TYPE STANDARD TABLE OF MARA WITH DEFAULT KEY.');
    expect(text).toContain('p_it_rows = VALUE #( ( matnr = `1` ) ).');
    expect(text).toContain('      TABLES\n        it_rows = p_it_rows');
    expect(text).toContain('      CHANGING\n        cv_x = p_cv_x');
  });

  it('refuses a parameter the interface never typed', () => {
    expect(() => buildFunctionCall(
      signature({ exporting: [{ name: 'EV_ANY' }] }),
      {}
    )).toThrow(/has no type in the interface/);
  });

  it('numbers the classic exceptions and adds OTHERS', () => {
    const call = buildFunctionCall(
      signature({ exceptions: ['NOT_FOUND', 'NO_AUTHORITY'] }),
      {}
    );
    const text = body(call.code);
    expect(text).toContain(
      '      EXCEPTIONS\n        not_found    = 1\n        no_authority = 2\n        OTHERS       = 99.'
    );
    expect(call.exceptions).toEqual({ 1: 'NOT_FOUND', 2: 'NO_AUTHORITY' });
  });

  it('captures sy-subrc in the statement right after the call', () => {
    const call = buildFunctionCall(signature({ exceptions: ['NOT_FOUND'] }), {});
    const lines = call.code.map(line => line.trim());
    const callEnd = lines.findIndex(line => line.startsWith('OTHERS'));
    expect(lines[callEnd + 1]).toBe('lv_mcp_subrc = sy-subrc.');
  });

  it('rolls the call back by default and commits only when told to', () => {
    expect(body(buildFunctionCall(signature(), {}).code)).toContain('ROLLBACK WORK.');
    expect(buildFunctionCall(signature(), {}).rolledBack).toBe(true);

    const committed = buildFunctionCall(signature(), {}, { rollback: false });
    expect(body(committed.code)).toContain('COMMIT WORK AND WAIT.');
    expect(body(committed.code)).not.toContain('ROLLBACK WORK.');
    expect(committed.rolledBack).toBe(false);
  });

  it('catches a class-based exception around the call', () => {
    const text = body(buildFunctionCall(signature(), {}).code);
    expect(text).toContain('CATCH cx_root INTO lo_mcp_error.');
    expect(text).toContain('lv_mcp_exception = cl_abap_classdescr=>get_class_name( lo_mcp_error ).');
  });

  it('counts and cuts a TABLES result in ABAP, and leaves anything else alone', () => {
    const call = buildFunctionCall(
      signature({
        tables: [{ name: 'ET_ROWS', structure: 'MARA' }],
        exporting: [{ name: 'ET_OTHER', type: 'ZTT' }]
      }),
      {},
      { maxRows: 5 }
    );
    const text = body(call.code);
    expect(text).toContain('APPEND VALUE #( name = `ET_ROWS` rows = lines( p_et_rows ) ) TO lt_mcp_rows.');
    expect(text).toContain('DELETE p_et_rows FROM 6.');
    // An exporting parameter cannot be asked whether it is a table: lines( )
    // on a non-table is a syntax error, and so is ASSIGN of one to a field
    // symbol typed ANY TABLE. It arrives whole and is capped in the answer.
    expect(text).not.toContain('p_et_other TO <mcp_tab>');
    expect(text).not.toContain('lines( p_et_other )');
    expect(text).not.toContain('DELETE p_et_other');
    expect(call.maxRows).toBe(5);
  });

  it('binds every result and the control values for the serialiser', () => {
    const call = buildFunctionCall(
      signature({ exporting: [{ name: 'EV_A', type: 'CHAR1' }] }),
      {}
    );
    const text = body(call.code);
    expect(text).toContain('( name = `MCP_SUBRC` value = REF #( lv_mcp_subrc ) )');
    expect(text).toContain('( name = `MCP_ROWS` value = REF #( lt_mcp_rows ) )');
    expect(text).toContain('( name = `EV_A` value = REF #( p_ev_a ) )');
    expect(text).toContain('CALL TRANSFORMATION id SOURCE (lt_mcp_bind) RESULT XML lv_mcp_xml.');
    expect(text).toContain("out->write_text( '<<<MCP-RESULT>>>' ).");
  });

  it('refuses a function module name that could carry code', () => {
    expect(() => buildFunctionCall(signature({ name: "X'. LEAVE PROGRAM. \"" }), {})).toThrow(CallGenError);
  });

  it('declares the row type at class level', () => {
    expect(buildFunctionCall(signature(), {}).declarations.join('\n')).toContain('TYPES tt_mcp_rows TYPE STANDARD TABLE OF ts_mcp_rows');
  });
});

describe('buildMethodCall', () => {
  const method = {
    importing: [{ name: 'IV_MATNR', type: 'MATNR' }],
    exporting: [],
    changing: [],
    returning: { name: 'RV_STAWN', type: 'STAWN' },
    exceptions: []
  };

  it('calls a static method and receives its returning parameter', () => {
    const call = buildMethodCall({ className: 'ZCL_APP', methodName: 'GET_STAWN' }, method, { IV_MATNR: '4711' });
    const text = body(call.code);
    expect(text).toContain('CALL METHOD zcl_app=>get_stawn');
    expect(text).toContain('      EXPORTING\n        iv_matnr = p_iv_matnr');
    expect(text).toContain('      RECEIVING\n        rv_stawn = p_rv_stawn');
    expect(call.results).toEqual([
      { binding: 'RV_STAWN', parameter: 'RV_STAWN', kind: 'returning' }
    ]);
  });

  it('refuses a value passed for the returning parameter', () => {
    expect(() => buildMethodCall(
      { className: 'ZCL_APP', methodName: 'GET_STAWN' },
      method,
      { RV_STAWN: 'X' }
    )).toThrow(/the returning parameter/);
  });

  it('refuses a class or method name that could carry code', () => {
    expect(() => buildMethodCall({ className: 'ZCL_APP', methodName: 'x. LEAVE PROGRAM' }, method, { IV_MATNR: '1' }))
      .toThrow(CallGenError);
  });
});

describe('interpretCall', () => {
  const generated = buildFunctionCall(
    signature({
      exporting: [{ name: 'EV_A', type: 'CHAR1' }],
      tables: [{ name: 'ET_ROWS', structure: 'MARA' }],
      exceptions: ['NOT_FOUND', 'NO_AUTHORITY']
    }),
    {},
    { maxRows: 2 }
  );

  it('reads the values back under their parameter names', () => {
    const outcome = interpretCall(
      { MCP_SUBRC: '0', MCP_EXCEPTION: '', MCP_MESSAGE: '', MCP_ROWS: '', EV_A: 'X', ET_ROWS: [{ MATNR: '1' }] },
      generated
    );
    expect(outcome).toMatchObject({ subrc: 0, values: { EV_A: 'X', ET_ROWS: [{ MATNR: '1' }] } });
    expect(outcome.exceptionRaised).toBeUndefined();
  });

  it('turns sy-subrc back into the name of the exception it stood for', () => {
    expect(interpretCall({ MCP_SUBRC: '2' }, generated).exceptionRaised).toBe('NO_AUTHORITY');
    expect(interpretCall({ MCP_SUBRC: String(OTHERS_SUBRC) }, generated).exceptionRaised).toBe('OTHERS');
  });

  it('reports a class-based exception with its text', () => {
    const outcome = interpretCall(
      { MCP_SUBRC: '0', MCP_EXCEPTION: 'CX_SY_ZERODIVIDE', MCP_MESSAGE: 'Division by zero' },
      generated
    );
    expect(outcome).toMatchObject({ exceptionClass: 'CX_SY_ZERODIVIDE', message: 'Division by zero' });
  });

  it('reports the true row count and says the answer is short of it', () => {
    const outcome = interpretCall(
      {
        MCP_SUBRC: '0',
        MCP_ROWS: [{ NAME: 'ET_ROWS', ROWS: '500' }],
        ET_ROWS: [{ MATNR: '1' }, { MATNR: '2' }]
      },
      generated
    );
    expect(outcome.rows).toEqual({ ET_ROWS: 500 });
    expect(outcome.truncated).toEqual(['ET_ROWS']);
    expect(outcome.values.ET_ROWS).toHaveLength(2);
  });

  it('cuts a table the backend did not cut for it', () => {
    const outcome = interpretCall(
      { MCP_SUBRC: '0', EV_A: 'X', ET_ROWS: [{ M: '1' }, { M: '2' }, { M: '3' }, { M: '4' }] },
      generated
    );
    expect(outcome.values.ET_ROWS).toHaveLength(2);
    expect(outcome.truncated).toEqual(['ET_ROWS']);
  });

  it('says nothing about rows when a table came back whole', () => {
    const outcome = interpretCall({ MCP_SUBRC: '0', ET_ROWS: [{ M: '1' }] }, generated);
    expect(outcome.truncated).toBeUndefined();
  });
});

describe('concreteType', () => {
  it('puts a concrete type in place of a generic one', () => {
    expect(concreteType('CLIKE', 'INPUT')).toEqual({ type: 'string', substituted: 'CLIKE -> string' });
    expect(concreteType('any', 'IV_X')).toMatchObject({ type: 'string' });
    expect(concreteType('XSEQUENCE', 'IV_X')).toMatchObject({ type: 'xstring' });
    expect(concreteType('NUMERIC', 'IV_X')).toMatchObject({ type: 'decfloat34' });
    expect(concreteType('OBJECT', 'IO_X')).toMatchObject({ type: 'REF TO object' });
  });

  it('widens a character type with no length, which would otherwise cut the value down', () => {
    expect(concreteType('C', 'IV_X')).toEqual({ type: 'c LENGTH 255', substituted: 'C -> c LENGTH 255' });
    expect(concreteType('n', 'IV_X')).toMatchObject({ type: 'n LENGTH 255' });
    expect(concreteType('x', 'IV_X')).toMatchObject({ type: 'x LENGTH 255' });
  });

  it('leaves TYPE p alone, because widening it needs a guess about the decimals', () => {
    // DECIMALS 4 made CL_ABAP_TSTMP=>ADD refuse a timestamp as an invalid
    // type; DECIMALS 0 would silently drop the fraction of a quantity. ABAP
    // own default is at least the documented one.
    expect(concreteType('P', 'IV_X')).toEqual({ type: 'P' });
  });

  it('leaves a concrete type exactly as the interface wrote it', () => {
    expect(concreteType('MATNR', 'IV_X')).toEqual({ type: 'MATNR' });
    expect(concreteType('DFIES-FIELDNAME', 'IV_X')).toEqual({ type: 'DFIES-FIELDNAME' });
    expect(concreteType('REF TO cl_x', 'IO_X')).toEqual({ type: 'REF TO cl_x' });
    expect(concreteType('string', 'IV_X')).toEqual({ type: 'string' });
  });

  it('refuses a generic table type, which says nothing about its rows', () => {
    expect(() => concreteType('STANDARD TABLE', 'IT_X')).toThrow(/generic table type/);
    expect(() => concreteType('any  table', 'IT_X')).toThrow(CallGenError);
  });
});

describe('declaring a parameter the interface typed awkwardly', () => {
  it('declares a generic parameter concretely and reports the substitution', () => {
    const call = buildFunctionCall(
      signature({
        name: 'CONVERSION_EXIT_ALPHA_INPUT',
        importing: [{ name: 'INPUT', type: 'CLIKE', byValue: true }],
        exporting: [{ name: 'OUTPUT', type: 'CLIKE', byValue: true }]
      }),
      { INPUT: '123' }
    );
    expect(body(call.code)).toContain('DATA p_input TYPE string.');
    expect(call.substitutions).toEqual({
      INPUT: 'CLIKE -> string',
      OUTPUT: 'CLIKE -> string'
    });
  });

  it('makes a TABLES parameter a table of the row the interface names', () => {
    const call = buildFunctionCall(
      signature({
        name: 'DDIF_FIELDINFO_GET',
        importing: [{ name: 'TABNAME', type: 'DDOBJNAME' }],
        tables: [
          { name: 'DFIES_TAB', like: 'DFIES', optional: true },
          { name: 'FIXED_VALUES', type: 'DDFIXVALUES', optional: true }
        ]
      }),
      { TABNAME: 'T000' }
    );
    const text = body(call.code);
    // LIKE DFIES names the row: a dictionary type cannot be reached with LIKE,
    // and a TABLES parameter needs the table rather than the structure.
    expect(text).toContain('DATA p_dfies_tab TYPE STANDARD TABLE OF DFIES WITH DEFAULT KEY.');
    // TYPE there already names a table type, so it stands as written.
    expect(text).toContain('DATA p_fixed_values TYPE DDFIXVALUES.');
    expect(text).not.toContain('LIKE');
  });

  it('turns a LIKE outside TABLES into TYPE', () => {
    const call = buildFunctionCall(
      signature({ importing: [{ name: 'IV_D', like: 'sy-datum' }] }),
      { IV_D: '20260909' }
    );
    expect(body(call.code)).toContain('DATA p_iv_d TYPE sy-datum.');
  });

  it('says which parameter it cannot declare at all', () => {
    expect(() => buildFunctionCall(
      signature({ tables: [{ name: 'IT_ANY' }] }),
      {}
    )).toThrow(/IT_ANY \(tables\) has no type/);
  });
});

describe('counting the rows of a TABLES parameter', () => {
  it('counts and cuts one declared with LIKE, the way DDIF_FIELDINFO_GET writes it', () => {
    const call = buildFunctionCall(
      signature({ tables: [{ name: 'DFIES_TAB', like: 'DFIES', optional: true }] }),
      {},
      { maxRows: 3 }
    );
    const text = body(call.code);
    expect(text).toContain('APPEND VALUE #( name = `DFIES_TAB` rows = lines( p_dfies_tab ) ) TO lt_mcp_rows.');
    expect(text).toContain('DELETE p_dfies_tab FROM 4.');
  });

  it('counts every form a TABLES parameter can be declared in', () => {
    const call = buildFunctionCall(
      signature({
        tables: [
          { name: 'BY_TYPE', type: 'DDFIXVALUES' },
          { name: 'BY_STRUCTURE', structure: 'MARA' },
          { name: 'BY_LIKE', like: 'DFIES' }
        ]
      }),
      {}
    );
    const text = body(call.code);
    for (const name of ['p_by_type', 'p_by_structure', 'p_by_like']) {
      expect(text).toContain(`rows = lines( ${name} )`);
    }
  });
});

describe('telling a table from a structure', () => {
  const generated = buildFunctionCall(
    signature({
      exporting: [{ name: 'ET_ROWS', type: 'ZTT' }, { name: 'ES_HEAD', type: 'ZS_HEAD' }],
      tables: [{ name: 'DFIES_TAB', like: 'DFIES' }]
    }),
    {},
    { maxRows: 5 }
  );

  it('asks RTTI about every result that is not a TABLES parameter', () => {
    const text = body(generated.code);
    expect(text).toContain('lo_mcp_type = cl_abap_typedescr=>describe_by_data( p_et_rows ).');
    expect(text).toContain('IF lo_mcp_type->kind = cl_abap_typedescr=>kind_table.');
    expect(text).toContain('APPEND `ET_ROWS` TO lt_mcp_tables.');
    expect(text).toContain('( name = `MCP_TABLES` value = REF #( lt_mcp_tables ) )');
    // A TABLES parameter is known to be one and is counted instead.
    expect(text).not.toContain('describe_by_data( p_dfies_tab )');
  });

  it('puts a named row type back into rows', () => {
    // asXML writes <DFIES_TAB><DFIES>..</DFIES><DFIES>..</DFIES>, which the
    // reader can only give back as one component holding two values.
    const outcome = interpretCall(
      {
        MCP_SUBRC: '0',
        MCP_ROWS: [{ NAME: 'DFIES_TAB', ROWS: '19' }],
        DFIES_TAB: { DFIES: [{ FIELDNAME: 'A' }, { FIELDNAME: 'B' }] }
      },
      generated
    );
    expect(outcome.values.DFIES_TAB).toEqual([{ FIELDNAME: 'A' }, { FIELDNAME: 'B' }]);
    expect(outcome.rows).toMatchObject({ DFIES_TAB: 19 });
    expect(outcome.truncated).toEqual(['DFIES_TAB']);
  });

  it('reads a one-row table of a named type as a table of one', () => {
    const outcome = interpretCall(
      { MCP_SUBRC: '0', MCP_TABLES: ['ET_ROWS'], ET_ROWS: { ZAPP_ROW: { MATNR: '1' } } },
      generated
    );
    expect(outcome.values.ET_ROWS).toEqual([{ MATNR: '1' }]);
    expect(outcome.rows).toMatchObject({ ET_ROWS: 1 });
  });

  it('reads an empty table as no rows', () => {
    const outcome = interpretCall(
      { MCP_SUBRC: '0', MCP_TABLES: ['ET_ROWS'], ET_ROWS: '' },
      generated
    );
    expect(outcome.values.ET_ROWS).toEqual([]);
    expect(outcome.rows).toMatchObject({ ET_ROWS: 0 });
  });

  it('leaves a structure a structure when nothing called it a table', () => {
    const outcome = interpretCall(
      { MCP_SUBRC: '0', MCP_TABLES: ['ET_ROWS'], ES_HEAD: { WERKS: '1000', MATNR: '1' } },
      generated
    );
    expect(outcome.values.ES_HEAD).toEqual({ WERKS: '1000', MATNR: '1' });
  });

  it('reads the table list whether it arrived as one name or several', () => {
    const single = interpretCall(
      { MCP_SUBRC: '0', MCP_TABLES: 'ET_ROWS', ET_ROWS: { ZAPP_ROW: { MATNR: '1' } } },
      generated
    );
    expect(single.values.ET_ROWS).toEqual([{ MATNR: '1' }]);
  });
});
