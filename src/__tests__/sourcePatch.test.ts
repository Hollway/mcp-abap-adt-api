import { resolveEdits, applyEdits, buildDiff, newlineOf } from '../lib/sourcePatch';

const CRLF = [
  'CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS one.',
  '    METHODS two.',
  'ENDCLASS.',
  '',
  'CLASS zcl_demo IMPLEMENTATION.',
  '  METHOD one.',
  '    WRITE 1.',
  '  ENDMETHOD.',
  '  METHOD two.',
  '    WRITE 1.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\r\n');

const patch = (source: string, edits: any[]) =>
  applyEdits(source, resolveEdits(source, edits));
const lines = (text: string) => text.split(newlineOf(text));

describe('line edits', () => {
  it('replaces a single line', () => {
    const out = patch(CRLF, [{ startLine: 3, replacement: '    METHODS one IMPORTING iv_x TYPE i.' }]);
    expect(lines(out)[2]).toBe('    METHODS one IMPORTING iv_x TYPE i.');
    expect(lines(out)).toHaveLength(14);
  });

  it('replaces a range with fewer lines', () => {
    const out = patch(CRLF, [{ startLine: 8, endLine: 10, replacement: '  METHOD one.\r\n  ENDMETHOD.' }]);
    expect(lines(out)).toHaveLength(13);
  });

  it('deletes lines without leaving blanks behind', () => {
    expect(patch('a\nb\nc\nd', [{ startLine: 2, replacement: '' }])).toBe('a\nc\nd');
    expect(patch('a\nb\nc\nd', [{ startLine: 1, replacement: '' }])).toBe('b\nc\nd');
    expect(patch('a\nb\nc\nd', [{ startLine: 4, replacement: '' }])).toBe('a\nb\nc');
    expect(patch('a\nb\nc\nd', [{ startLine: 2, endLine: 3, replacement: '' }])).toBe('a\nd');
  });

  it('refuses lines outside the source', () => {
    expect(() => patch(CRLF, [{ startLine: 99, replacement: 'x' }])).toThrow(/outside the source/);
    expect(() => patch(CRLF, [{ startLine: 3, endLine: 2, replacement: 'x' }])).toThrow(/endLine/);
  });
});

describe('insertions', () => {
  it('inserts after a line and at the top', () => {
    expect(lines(patch(CRLF, [{ insertAfterLine: 4, insertion: '    METHODS three.' }]))[4])
      .toBe('    METHODS three.');
    expect(lines(patch(CRLF, [{ insertAfterLine: 0, insertion: '* header' }]))[0]).toBe('* header');
  });

  it('inserts at the end of a source with no trailing newline', () => {
    expect(patch('a\nb', [{ insertAfterLine: 2, insertion: 'c' }])).toBe('a\nb\nc');
  });
});

describe('anchor edits', () => {
  it('replaces a unique anchor', () => {
    const out = patch(CRLF, [{ anchor: '    METHODS two.', replacement: '    METHODS two IMPORTING iv_y TYPE i.' }]);
    expect(lines(out)[3]).toBe('    METHODS two IMPORTING iv_y TYPE i.');
  });

  it('requires an occurrence when the anchor repeats', () => {
    expect(() => patch(CRLF, [{ anchor: '    WRITE 1.', replacement: 'x' }]))
      .toThrow(/matches 2 times/);
    const out = patch(CRLF, [{ anchor: '    WRITE 1.', replacement: '    WRITE 2.', occurrence: 2 }]);
    expect(lines(out)[11]).toBe('    WRITE 2.');
    expect(lines(out)[8]).toBe('    WRITE 1.');
  });

  it('refuses an anchor that is not there', () => {
    expect(() => patch(CRLF, [{ anchor: 'NOPE', replacement: 'x' }])).toThrow(/anchor not found/);
  });
});

describe('several edits', () => {
  it('applies every edit at the coordinates of the source as read', () => {
    const out = lines(patch(CRLF, [
      { startLine: 3, replacement: '    METHODS one IMPORTING iv_x TYPE i.' },
      { insertAfterLine: 9, insertion: '    WRITE iv_x.' }
    ]));
    expect(out[2]).toBe('    METHODS one IMPORTING iv_x TYPE i.');
    expect(out[9]).toBe('    WRITE iv_x.');
  });

  it('refuses overlapping edits', () => {
    expect(() => patch(CRLF, [
      { startLine: 8, endLine: 10, replacement: 'a' },
      { startLine: 9, replacement: 'b' }
    ])).toThrow(/overlap/);
  });

  it('refuses an empty list and an unrecognised edit', () => {
    expect(() => patch(CRLF, [])).toThrow(/No edits/);
    expect(() => patch(CRLF, [{ replacement: 'x' }])).toThrow(/needs startLine/);
  });
});

describe('line endings', () => {
  it('keeps CRLF and LF as they were', () => {
    expect(patch(CRLF, [{ startLine: 2, replacement: '  PUBLIC SECTION.' }])).toBe(CRLF);
    expect(patch('a\nb\nc', [{ startLine: 2, replacement: 'B' }])).toBe('a\nB\nc');
    // a replacement written with \n lands in a CRLF file as CRLF
    const out = patch(CRLF, [{ startLine: 3, replacement: 'x\ny' }]);
    expect(out).toContain('x\r\ny');
    expect(out).not.toContain('x\ny');
  });
});

describe('buildDiff', () => {
  it('shows the removal, the addition and the context', () => {
    const diff = buildDiff(CRLF, resolveEdits(CRLF, [{ startLine: 9, replacement: '    WRITE 42.' }]));
    expect(diff).toContain('-    WRITE 1.');
    expect(diff).toContain('+    WRITE 42.');
    expect(diff).toContain('  METHOD one.');
    expect(diff).toMatch(/^@@ -9,1 \+9,1 @@/m);
  });
});
