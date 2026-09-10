import { findInSource, outlineSource, includedPrograms, codeOf, isCommentLine } from '../lib/sourceScan';

const REPORT = [
  'REPORT zr_app_foo.',
  '',
  'INCLUDE zr_app_foo_top.',
  'INCLUDE zr_app_foo_f01 IF FOUND.',
  '',
  'START-OF-SELECTION.',
  '  PERFORM read_data.',
  '',
  '*  PERFORM old_read_data.',
  'FORM read_data.',
  '  SELECT * FROM ekpo INTO TABLE @DATA(lt_ekpo). "read the items',
  'ENDFORM.',
  '',
  'FORM write_data.',
  '  WRITE: / \'say "hello"\'.',
  'ENDFORM.'
].join('\n');

describe('codeOf', () => {
  it('drops a trailing comment', () => {
    expect(codeOf('  WRITE x. "why').trim()).toBe('WRITE x.');
  });

  it('keeps a quote that lives inside a literal', () => {
    expect(codeOf("  WRITE: / 'say \"hello\"'.").trim()).toBe("WRITE: / 'say \"hello\"'.");
  });

  it('treats a star in the first column as a whole-line comment', () => {
    expect(codeOf('* PERFORM x.')).toBe('');
    expect(isCommentLine('* PERFORM x.')).toBe(true);
    expect(isCommentLine('   " just a note')).toBe(true);
    expect(isCommentLine('  PERFORM x.')).toBe(false);
  });
});

describe('findInSource', () => {
  it('finds plain text case-insensitively and numbers the lines from 1', () => {
    const found = findInSource(REPORT, { pattern: 'perform read_data' });
    expect(found.matches.map(m => m.line)).toEqual([7]);
    expect(found.totalLines).toBe(16);
  });

  it('counts commented-out code unless asked to skip it', () => {
    expect(findInSource(REPORT, { pattern: 'old_read_data' }).totalMatches).toBe(1);
    expect(findInSource(REPORT, { pattern: 'old_read_data', skipComments: true }).totalMatches).toBe(0);
  });

  it('takes a regular expression and returns context', () => {
    const found = findInSource(REPORT, { pattern: '^FORM\\s+\\w+', regex: true, contextLines: 1 });
    expect(found.matches.map(m => m.line)).toEqual([10, 14]);
    expect(found.matches[0].before).toEqual(['*  PERFORM old_read_data.']);
    expect(found.matches[0].after).toEqual(['  SELECT * FROM ekpo INTO TABLE @DATA(lt_ekpo). "read the items']);
  });

  it('reports the total even when it returns fewer matches', () => {
    const found = findInSource(REPORT, { pattern: 'FORM', maxMatches: 1 });
    expect(found.matches).toHaveLength(1);
    // two FORM, two ENDFORM, and the two PERFORM lines that contain the word
    expect(found.totalMatches).toBe(6);
    expect(found.truncated).toBe(true);
  });

  it('rejects a broken regular expression instead of searching for its text', () => {
    expect(() => findInSource(REPORT, { pattern: '(unclosed', regex: true })).toThrow(/regular expression/);
  });

  it('treats a pattern as text when regex is off', () => {
    expect(findInSource('x = a(1).', { pattern: 'a(1)' }).totalMatches).toBe(1);
  });
});

describe('outlineSource', () => {
  it('lists the blocks with their line numbers', () => {
    expect(outlineSource(REPORT)).toEqual([
      { kind: 'REPORT', name: 'ZR_APP_FOO', line: 1 },
      { kind: 'INCLUDE', name: 'ZR_APP_FOO_TOP', line: 3 },
      { kind: 'INCLUDE', name: 'ZR_APP_FOO_F01', line: 4 },
      { kind: 'EVENT', name: 'START-OF-SELECTION', line: 6 },
      { kind: 'FORM', name: 'READ_DATA', line: 10 },
      { kind: 'FORM', name: 'WRITE_DATA', line: 14 }
    ]);
  });

  it('separates a class definition from its implementation', () => {
    const source = [
      'CLASS zcl_test DEFINITION PUBLIC.',
      'ENDCLASS.',
      'CLASS zcl_test IMPLEMENTATION.',
      '  METHOD run.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\n');
    expect(outlineSource(source)).toEqual([
      { kind: 'CLASS-DEFINITION', name: 'ZCL_TEST', line: 1 },
      { kind: 'CLASS-IMPLEMENTATION', name: 'ZCL_TEST', line: 3 },
      { kind: 'METHOD', name: 'RUN', line: 4 }
    ]);
  });

  it('skips a commented-out block', () => {
    expect(outlineSource('*FORM dead.\n*ENDFORM.')).toEqual([]);
  });

  it('lists the includes of a program once each', () => {
    expect(includedPrograms(REPORT)).toEqual(['ZR_APP_FOO_TOP', 'ZR_APP_FOO_F01']);
  });
});
