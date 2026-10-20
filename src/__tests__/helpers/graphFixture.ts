import type { Tables } from './fakeSql';

/** An include name of a class pool: the class padded to 30 with '=' and the suffix. */
export const classInclude = (className: string, suffix: string): string => `${className.padEnd(30, '=')}${suffix}`;

const stamp = { UDAT: '20261001', UTIME: '120000' };

/**
 * A small system: two classes and an interface, a report with an include, a
 * function group with one module, a table - and references between them that
 * cover every way the index writes one.
 */
export function graphTables(): Tables {
  return {
    tadir: [
      { PGMID: 'R3TR', OBJECT: 'CLAS', OBJ_NAME: 'ZCL_A', DEVCLASS: 'ZPK1' },
      { PGMID: 'R3TR', OBJECT: 'CLAS', OBJ_NAME: 'ZCL_B', DEVCLASS: 'ZPK1' },
      { PGMID: 'R3TR', OBJECT: 'INTF', OBJ_NAME: 'ZIF_C', DEVCLASS: 'ZPK2' },
      { PGMID: 'R3TR', OBJECT: 'PROG', OBJ_NAME: 'ZR_REP', DEVCLASS: 'ZPK2' },
      { PGMID: 'R3TR', OBJECT: 'PROG', OBJ_NAME: 'ZR_REP_F01', DEVCLASS: 'ZPK2' },
      { PGMID: 'R3TR', OBJECT: 'FUGR', OBJ_NAME: 'ZFG', DEVCLASS: 'ZPK3' },
      { PGMID: 'R3TR', OBJECT: 'TABL', OBJ_NAME: 'ZTAB', DEVCLASS: 'ZPK3' },
      { PGMID: 'R3TR', OBJECT: 'CLAS', OBJ_NAME: 'CL_STANDARD', DEVCLASS: 'SABP' }
    ],
    tmdir: [
      { CLASSNAME: 'ZCL_A', METHODINDX: '0', METHODNAME: '' },
      { CLASSNAME: 'ZCL_A', METHODINDX: '1', METHODNAME: 'GET_BUKRS' },
      { CLASSNAME: 'ZCL_A', METHODINDX: '2', METHODNAME: 'RUN' },
      { CLASSNAME: 'ZCL_A', METHODINDX: '10', METHODNAME: 'HELPER' },
      { CLASSNAME: 'ZCL_B', METHODINDX: '1', METHODNAME: 'EXECUTE' },
      { CLASSNAME: 'ZCL_B', METHODINDX: '2', METHODNAME: 'ZIF_C~DO' }
    ],
    tfdir: [
      { FUNCNAME: 'Z_FM_READ', PNAME: 'SAPLZFG', INCLUDE: '01' }
    ],
    reposrc: [
      { PROGNAME: classInclude('ZCL_A', 'CM001'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZCL_A', 'CM002'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZCL_A', 'CM00A'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZCL_A', 'CU'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZCL_B', 'CM001'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZCL_B', 'CM002'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZCL_B', 'CU'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: classInclude('ZIF_C', 'IU'), R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: 'ZR_REP', R3STATE: 'A', SUBC: '1', ...stamp },
      { PROGNAME: 'ZR_REP_F01', R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: 'LZFGU01', R3STATE: 'A', SUBC: 'I', ...stamp },
      { PROGNAME: 'SAPLZFG', R3STATE: 'A', SUBC: 'F', ...stamp },
      // An inactive version must not count.
      { PROGNAME: classInclude('ZCL_A', 'CM001'), R3STATE: 'I', SUBC: 'I', UDAT: '20261005', UTIME: '090000' }
    ],
    d010inc: [
      { MASTER: 'ZR_REP', INCLUDE: 'ZR_REP_F01' },
      { MASTER: 'ZR_REP', INCLUDE: '<ICON>' },
      { MASTER: classInclude('ZCL_A', 'CP'), INCLUDE: classInclude('ZCL_A', 'CM001') }
    ],
    wbcrossgt: [
      { OTYPE: 'ME', NAME: 'ZCL_A\\ME:GET_BUKRS', INCLUDE: classInclude('ZCL_B', 'CM001') },
      { OTYPE: 'ME', NAME: 'ZCL_A\\ME:HELPER', INCLUDE: classInclude('ZCL_A', 'CM002') },
      { OTYPE: 'ME', NAME: 'ZCL_A\\ME:GET_BUKRS', INCLUDE: classInclude('ZCL_A', 'CM002') },
      { OTYPE: 'ME', NAME: 'CL_ABAP_TYPEDESCR\\ME:DESCRIBE_BY_NAME', INCLUDE: classInclude('ZCL_A', 'CM00A') },
      { OTYPE: 'ME', NAME: 'ZCL_A\\ME:GET_BUKRS', INCLUDE: 'ZR_REP_F01' },
      { OTYPE: 'TY', NAME: 'ZTAB', INCLUDE: 'ZR_REP_F01' },
      { OTYPE: 'ME', NAME: 'ZCL_B\\ME:EXECUTE', INCLUDE: 'LZFGU01' },
      { OTYPE: 'TY', NAME: 'ZTAB', INCLUDE: classInclude('ZCL_B', 'CM002') },
      { OTYPE: 'TY', NAME: 'ZTAB', INCLUDE: classInclude('ZCL_B', 'CU') },
      { OTYPE: 'DA', NAME: 'ZCL_A\\ME:GET_BUKRS\\DA:IV_WERKS', INCLUDE: classInclude('ZCL_A', 'CM001') },
      { OTYPE: 'DA', NAME: 'ZCL_A\\DA:GC_PLANT', INCLUDE: classInclude('ZCL_B', 'CM001') },
      { OTYPE: 'ME', NAME: 'ZIF_C\\ME:DO', INCLUDE: classInclude('ZCL_B', 'CU') },
      { OTYPE: 'ME', NAME: 'ZIF_C\\ME:DO', INCLUDE: classInclude('ZCL_A', 'CM002') },
      { OTYPE: 'TY', NAME: 'MARA', INCLUDE: classInclude('ZCL_A', 'CM001') },
      { OTYPE: 'TY', NAME: '\\PR:ZR_REP\\TY:LTY_ROW', INCLUDE: 'ZR_REP' },
      // Standard code is not loaded.
      { OTYPE: 'ME', NAME: 'ZCL_A\\ME:RUN', INCLUDE: 'SAPMV45A' }
    ],
    cross: [
      { TYPE: 'F', NAME: 'Z_FM_READ', PROG: '', INCLUDE: 'ZR_REP' },
      { TYPE: 'F', NAME: 'BAPI_PO_CREATE1', PROG: '', INCLUDE: 'ZR_REP_F01' },
      { TYPE: 'F', NAME: 'BAPI_PO_CREATE1', PROG: '', INCLUDE: classInclude('ZCL_A', 'CM002') },
      { TYPE: 'U', NAME: 'READ_DATA', PROG: '', INCLUDE: 'ZR_REP' },
      { TYPE: 'R', NAME: 'ZR_OTHER', PROG: '', INCLUDE: 'ZR_REP_F01' },
      { TYPE: 'N', NAME: 'ZMSG                001', PROG: '', INCLUDE: classInclude('ZCL_A', 'CM001') }
    ],
    seoclasstx: [
      { CLSNAME: 'ZCL_A', LANGU: 'R', DESCRIPT: 'Утилиты завода' },
      { CLSNAME: 'ZCL_A', LANGU: 'E', DESCRIPT: 'Plant utilities' },
      { CLSNAME: 'ZCL_B', LANGU: 'R', DESCRIPT: 'Обработка заказов' }
    ],
    seocompotx: [
      { CLSNAME: 'ZCL_A', CMPNAME: 'GET_BUKRS', LANGU: 'R', DESCRIPT: 'Балансовая единица по заводу' },
      { CLSNAME: 'ZIF_C', CMPNAME: 'DO', LANGU: 'R', DESCRIPT: 'Выполнить расчёт' },
      { CLSNAME: 'ZCL_A', CMPNAME: 'GC_PLANT', LANGU: 'R', DESCRIPT: 'Завод по умолчанию' }
    ],
    tftit: [
      { FUNCNAME: 'Z_FM_READ', SPRAS: 'R', STEXT: 'Чтение цены материала' }
    ],
    trdirt: [
      { NAME: 'ZR_REP', SPRSL: 'R', TEXT: 'Отчёт по ценам' }
    ],
    tlibt: [
      { AREA: 'ZFG', SPRAS: 'R', AREAT: 'Группа цен' }
    ],
    dd02t: [
      { TABNAME: 'ZTAB', DDLANGUAGE: 'R', AS4LOCAL: 'A', DDTEXT: 'Таблица цен' }
    ]
  };
}

/** Sources of the fixture objects, by ADT address. */
export const graphSources: Record<string, string> = {
  '/sap/bc/adt/oo/classes/zcl_a/source/main': [
    'CLASS zcl_a DEFINITION PUBLIC.',
    '  PUBLIC SECTION.',
    '    CLASS-METHODS get_bukrs IMPORTING iv_werks TYPE werks_d RETURNING VALUE(rv_bukrs) TYPE bukrs.',
    'ENDCLASS.',
    'CLASS zcl_a IMPLEMENTATION.',
    '  METHOD get_bukrs.',
    '    SELECT SINGLE bukrs FROM t001k INTO rv_bukrs WHERE bwkey = iv_werks.',
    '  ENDMETHOD.',
    '  METHOD run.',
    '    helper( ).',
    '    DATA(lv_bukrs) = get_bukrs( \'1000\' ).',
    '  ENDMETHOD.',
    'ENDCLASS.'
  ].join('\r\n'),
  '/sap/bc/adt/oo/classes/zcl_b/source/main': [
    'CLASS zcl_b IMPLEMENTATION.',
    '  METHOD execute.',
    '    " get_bukrs in a comment is not a hit',
    '    DATA(lv_bukrs) = zcl_a=>get_bukrs( iv_werks = \'1000\' ).',
    '  ENDMETHOD.',
    '  METHOD zif_c~do.',
    '    DATA lt_rows TYPE STANDARD TABLE OF ztab.',
    '    DELETE lt_rows WHERE kbetr = 0.',
    '    MODIFY ztab FROM TABLE lt_rows.',
    '  ENDMETHOD.',
    'ENDCLASS.'
  ].join('\n'),
  '/sap/bc/adt/programs/includes/zr_rep_f01/source/main': [
    '*&---- forms',
    'FORM read_data.',
    '  DATA(lv_bukrs) = zcl_a=>get_bukrs( p_werks ).',
    'ENDFORM.',
    'FORM read_prices.',
    '  SELECT * FROM ztab INTO TABLE @DATA(lt_prices).',
    'ENDFORM.'
  ].join('\n')
};
