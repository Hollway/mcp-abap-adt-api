import {
  readClassLayout,
  findMethod,
  definitionStatements,
  methodDeclaration,
  methodImplementation,
  planAddMethod,
  planAddAttribute,
  planDeleteMethod,
  ClassEditError
} from '../lib/classEdit';

/**
 * Shaped like what ADT serves for a class: the definition part is lower case
 * with `public section.` headers, the implementation part follows in the same
 * document, and both end with an ENDCLASS.
 */
const CLASS = [
  'class ZCL_DEV_MCP definition',                    // 1
  '  public',                                        // 2
  '  final',                                         // 3
  '  create public .',                               // 4
  '',                                                // 5
  '  public section.',                               // 6
  '',                                                // 7
  '    methods CONSTRUCTOR',                         // 8
  '      importing',                                 // 9
  '        !iv_name type string .',                  // 10
  '    class-methods VERSION',                       // 11
  '      returning',                                 // 12
  '        value(rv_version) type i .',              // 13
  '  protected section.',                            // 14
  '  private section.',                              // 15
  '',                                                // 16
  '    data mv_name type string .',                  // 17
  'ENDCLASS.',                                       // 18
  '',                                                // 19
  '',                                                // 20
  'CLASS ZCL_DEV_MCP IMPLEMENTATION.',               // 21
  '',                                                // 22
  '  METHOD constructor.',                           // 23
  '    mv_name = iv_name.',                          // 24
  '  ENDMETHOD.',                                    // 25
  '',                                                // 26
  '  METHOD version.',                               // 27
  '    rv_version = 1.',                             // 28
  '  ENDMETHOD.',                                    // 29
  'ENDCLASS.'                                        // 30
].join('\r\n');

describe('readClassLayout', () => {
  it('finds the sections and both ENDCLASS lines', () => {
    const layout = readClassLayout(CLASS);
    expect(layout.sections).toEqual({ public: 6, protected: 14, private: 15 });
    expect(layout.definitionEnd).toBe(18);
    expect(layout.implementationStart).toBe(21);
    expect(layout.implementationEnd).toBe(30);
  });

  it('refuses a source that is not a class', () => {
    expect(() => readClassLayout('REPORT zfoo.\nWRITE 1.'))
      .toThrow(/no CLASS \.\.\. DEFINITION/);
  });

  it('refuses a definition with no ENDCLASS', () => {
    expect(() => readClassLayout('class ZCL_X definition public .\npublic section.'))
      .toThrow(/no ENDCLASS/);
  });

  // A commented-out ENDCLASS used to end the class early.
  it('ignores a commented line', () => {
    const layout = readClassLayout([
      'class ZCL_X definition public .',
      '  public section.',
      '* ENDCLASS.',
      '    methods FOO .',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      '  METHOD foo.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n'));
    expect(layout.definitionEnd).toBe(5);
  });
});

describe('definitionStatements', () => {
  it('keeps a multi-line declaration together', () => {
    const statements = definitionStatements(readClassLayout(CLASS));
    expect(statements).toEqual([
      { start: 8, end: 10, chained: false },
      { start: 11, end: 13, chained: false },
      { start: 17, end: 17, chained: false }
    ]);
  });

  it('sees a chain as one statement', () => {
    const layout = readClassLayout([
      'class ZCL_X definition public .',
      '  public section.',
      '    methods:',
      '      first,',
      '      second.',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n'));
    expect(definitionStatements(layout)).toEqual([{ start: 3, end: 5, chained: true }]);
  });
});

describe('findMethod', () => {
  const layout = readClassLayout(CLASS);

  it('finds a declaration and its implementation', () => {
    expect(findMethod(layout, 'constructor')).toEqual({ declaredAt: 8, implementedAt: 23 });
    expect(findMethod(layout, 'VERSION')).toEqual({ declaredAt: 11, implementedAt: 27 });
  });

  it('does not mistake a parameter for a method', () => {
    expect(findMethod(layout, 'iv_name')).toEqual({});
    expect(findMethod(layout, 'rv_version')).toEqual({});
  });

  it('finds an entry of a chain', () => {
    const chained = readClassLayout([
      'class ZCL_X definition public .',
      '  public section.',
      '    methods:',
      '      first,',
      '      second.',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n'));
    expect(findMethod(chained, 'second')).toEqual({ declaredAt: 5 });
  });

  it('answers nothing for a method that is not there', () => {
    expect(findMethod(layout, 'zz_nothing')).toEqual({});
  });
});

describe('methodDeclaration', () => {
  it('builds a full signature', () => {
    expect(methodDeclaration({
      name: 'CALC',
      importing: [{ name: 'iv_a', type: 'i' }, { name: 'iv_b', type: 'i', default: '1' }],
      exporting: [{ name: 'ev_log', type: 'string' }],
      returning: { name: 'rv_sum', type: 'i' },
      raising: ['cx_sy_zerodivide']
    }, '    ')).toEqual([
      '    METHODS CALC',
      '      IMPORTING',
      '        !iv_a TYPE i',
      '        !iv_b TYPE i DEFAULT 1',
      '      EXPORTING',
      '        !ev_log TYPE string',
      '      RETURNING',
      '        VALUE(rv_sum) TYPE i',
      '      RAISING',
      '        cx_sy_zerodivide',
      '        .'
    ]);
  });

  it('puts the full stop on the name when there is no signature', () => {
    expect(methodDeclaration({ name: 'RUN', static: true }, '  '))
      .toEqual(['  CLASS-METHODS RUN .']);
  });

  it('marks an optional importing parameter', () => {
    expect(methodDeclaration({ name: 'X', importing: [{ name: 'iv_a', type: 'i', optional: true }] }, ''))
      .toContain('    !iv_a TYPE i OPTIONAL');
  });

  it('takes a verbatim declaration when one is given', () => {
    expect(methodDeclaration({ name: 'X', declaration: '  methods x .' }, '    '))
      .toEqual(['  methods x .']);
  });

  it('insists on a name and a type for every parameter', () => {
    expect(() => methodDeclaration({ name: 'X', importing: [{ name: 'iv_a', type: '' }] }, ''))
      .toThrow(/name and a type/);
    expect(() => methodDeclaration({ name: '' }, '')).toThrow(/needs a name/);
  });
});

describe('methodImplementation', () => {
  it('indents the body one step in', () => {
    expect(methodImplementation({ name: 'CALC', implementation: ['rv_sum = iv_a + iv_b.', '', 'RETURN.'] }, '  '))
      .toEqual(['  METHOD calc.', '    rv_sum = iv_a + iv_b.', '', '    RETURN.', '  ENDMETHOD.']);
  });

  it("keeps the caller's own indentation", () => {
    expect(methodImplementation({ name: 'X', implementation: ['IF a = 1.', '  b = 2.', 'ENDIF.'] }, '  '))
      .toEqual(['  METHOD x.', '    IF a = 1.', '      b = 2.', '    ENDIF.', '  ENDMETHOD.']);
  });

  it('leaves a marker when there is no body', () => {
    expect(methodImplementation({ name: 'TODO_LATER' }, '  '))
      .toEqual(['  METHOD todo_later.', '    " TODO: implement todo_later', '  ENDMETHOD.']);
  });
});

describe('planAddMethod', () => {
  it('adds the declaration after the section body and the body before ENDCLASS', () => {
    const edits = planAddMethod(CLASS, {
      name: 'GET_NAME',
      visibility: 'public',
      returning: { name: 'rv_name', type: 'string' },
      implementation: ['rv_name = mv_name.']
    }) as any[];
    // Descending line order, so applying one cannot move the other.
    expect(edits[0].insertAfterLine).toBe(29);
    expect(edits[1].insertAfterLine).toBe(13);
    expect(edits[1].insertion.split('\n')[0]).toBe('    METHODS GET_NAME');
    expect(edits[0].insertion).toBe([
      '  METHOD get_name.',
      '    rv_name = mv_name.',
      '  ENDMETHOD.'
    ].join('\n'));
  });

  it('follows the indentation the class already uses', () => {
    const twoSpace = CLASS.replace(/^ {4}/gm, '  ');
    const edits = planAddMethod(twoSpace, { name: 'X' }) as any[];
    expect(edits[1].insertion).toBe('  METHODS X .');
  });

  it('puts a private method in the private section', () => {
    const edits = planAddMethod(CLASS, { name: 'HELP', visibility: 'private' }) as any[];
    expect(edits[1].insertAfterLine).toBe(17);
    expect(edits[1].describe).toMatch(/private declaration of HELP/);
  });

  it('adds to an empty section right after its header', () => {
    const edits = planAddMethod(CLASS, { name: 'HOOK', visibility: 'protected' }) as any[];
    expect(edits[1].insertAfterLine).toBe(14);
  });

  it('refuses a method that is already there, and says where', () => {
    expect(() => planAddMethod(CLASS, { name: 'version' }))
      .toThrow(/VERSION is already there \(declared on line 11\) \(implemented on line 27\)/);
  });

  it('refuses a class with no implementation part', () => {
    const definitionOnly = [
      'class ZCL_X definition public .',
      '  public section.',
      'ENDCLASS.'
    ].join('\n');
    expect(() => planAddMethod(definitionOnly, { name: 'X' }))
      .toThrow(/no CLASS \.\.\. IMPLEMENTATION part/);
  });

  it('refuses a section the class does not have', () => {
    const noPrivate = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods FOO .',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      '  METHOD foo.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n');
    expect(() => planAddMethod(noPrivate, { name: 'X', visibility: 'private' }))
      .toThrow(/no private section. Sections present: public/);
  });
});

describe('planAddAttribute', () => {
  it('adds a private attribute by default', () => {
    const edits = planAddAttribute(CLASS, { name: 'mv_count', type: 'i' }) as any[];
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ insertAfterLine: 17, insertion: '    DATA mv_count TYPE i .' });
  });

  it('writes a constant with its value and a static attribute', () => {
    expect((planAddAttribute(CLASS, {
      name: 'co_kind', type: 'char1', value: `'X'`, constant: true, visibility: 'public'
    }) as any[])[0].insertion).toBe(`    CONSTANTS co_kind TYPE char1 VALUE 'X' .`);
    expect((planAddAttribute(CLASS, {
      name: 'gv_instances', type: 'i', static: true
    }) as any[])[0].insertion).toBe('    CLASS-DATA gv_instances TYPE i .');
  });

  it('insists on a value for a constant, and on public for READ-ONLY', () => {
    expect(() => planAddAttribute(CLASS, { name: 'c', type: 'i', constant: true }))
      .toThrow(/constant needs a value/);
    expect(() => planAddAttribute(CLASS, { name: 'a', type: 'i', readOnly: true, visibility: 'private' }))
      .toThrow(/READ-ONLY is only accepted on a public attribute/);
  });
});

describe('planDeleteMethod', () => {
  it('removes the declaration and the implementation, bottom up', () => {
    const edits = planDeleteMethod(CLASS, 'version') as any[];
    expect(edits).toEqual([
      { startLine: 27, endLine: 29, replacement: '', describe: 'implementation of VERSION' },
      { startLine: 11, endLine: 13, replacement: '', describe: 'declaration of VERSION' }
    ]);
  });

  it('removes an entry from the middle of a chain', () => {
    const chained = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods:',
      '      first,',
      '      second,',
      '      third.',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      '  METHOD second.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n');
    expect(planDeleteMethod(chained, 'second')).toEqual([
      { startLine: 9, endLine: 10, replacement: '', describe: 'implementation of SECOND' },
      { startLine: 5, endLine: 5, replacement: '', describe: expect.stringContaining('one entry of a chain') }
    ]);
  });

  // Taking the last entry out would leave the one before it ending in a comma.
  it('closes the chain when the last entry goes', () => {
    const chained = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods:',
      '      first,',
      '      last.',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n');
    const edits = planDeleteMethod(chained, 'last') as any[];
    expect(edits[0]).toMatchObject({ startLine: 4, endLine: 5, replacement: '      first .' });
  });

  it('removes the whole chain when its only entry goes', () => {
    const chained = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods:',
      '      only.',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n');
    expect(planDeleteMethod(chained, 'only')).toEqual([
      { startLine: 3, endLine: 4, replacement: '', describe: 'declaration of ONLY (the whole chain)' }
    ]);
  });

  it('refuses when the declaration shares a line with another method', () => {
    const shared = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods: first, second.',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n');
    expect(() => planDeleteMethod(shared, 'first'))
      .toThrow(/shares a line with another method in a METHODS: chain/);
  });

  it('refuses an implementation with no ENDMETHOD', () => {
    const broken = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods FOO .',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      '  METHOD foo.',
      'ENDCLASS.'
    ].join('\n');
    expect(() => planDeleteMethod(broken, 'foo')).toThrow(/no ENDMETHOD/);
  });

  it('refuses a method that is not in the class', () => {
    expect(() => planDeleteMethod(CLASS, 'nope'))
      .toThrow(/NOPE is not declared or implemented/);
  });

  it('takes out a declaration whose implementation is missing', () => {
    const declaredOnly = [
      'class ZCL_X definition public .',
      '  public section.',
      '    methods FOO .',
      'ENDCLASS.',
      'CLASS ZCL_X IMPLEMENTATION.',
      'ENDCLASS.'
    ].join('\n');
    expect(planDeleteMethod(declaredOnly, 'foo')).toEqual([
      { startLine: 3, endLine: 3, replacement: '', describe: 'declaration of FOO' }
    ]);
  });
});

describe('ClassEditError', () => {
  it('is an Error, so a handler can tell it from an ADT failure', () => {
    expect(new ClassEditError('x')).toBeInstanceOf(Error);
  });
});
