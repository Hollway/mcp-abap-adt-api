import { resolveEdits, applyEdits, buildDiff, newlineOf } from '../lib/sourcePatch';
import { lockRegistry } from '../lib/lockRegistry';

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

  /**
   * The case this whole tool exists for: one comment at the end of a method,
   * which is how it was first used on a live class.
   */
  it('adds exactly one line when inserting before ENDMETHOD', () => {
    const out = patch(CRLF, [{ insertAfterLine: 12, insertion: '    " comment' }]);
    expect(lines(out)).toHaveLength(lines(CRLF).length + 1);
    expect(lines(out)[12]).toBe('    " comment');
    expect(lines(out)[13]).toBe('  ENDMETHOD.');
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

  /**
   * ADT serves this system's sources with CRLF, and an anchor is written with
   * plain newlines. Matching it literally meant every multi-line anchor came
   * back "not found" - seen live while trying to delete a line by quoting it
   * with its newline.
   */
  it('matches a multi-line anchor written with plain newlines', () => {
    const out = patch(CRLF, [{
      anchor: '    METHODS one.\n    METHODS two.',
      replacement: '    METHODS one_and_two.'
    }]);
    expect(lines(out)[2]).toBe('    METHODS one_and_two.');
    expect(out).not.toContain('METHODS two.');
  });

  it('deletes a line quoted with its own newline', () => {
    const out = patch(CRLF, [{ anchor: '    METHODS two.\n', replacement: '' }]);
    expect(out).not.toContain('METHODS two.');
    expect(lines(out)).toHaveLength(lines(CRLF).length - 1);
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
  const diffOf = (edits: any[]) => buildDiff(CRLF, resolveEdits(CRLF, edits));
  const marks = (diff: string, sign: string) =>
    diff.split('\n').filter(line => line.startsWith(sign));

  /**
   * An insertion carries its own trailing newline and a deletion swallows one,
   * so splitting those chunks naively used to put a phantom blank line into the
   * diff, and into the hunk counts with it. Seen for real on a live class: one
   * comment inserted, two "+" lines reported.
   */
  it('shows exactly the lines an insertion adds', () => {
    const diff = diffOf([{ insertAfterLine: 4, insertion: '    METHODS three.' }]);
    expect(marks(diff, '+')).toEqual(['+    METHODS three.']);
    expect(marks(diff, '-')).toEqual([]);
    // an insertion after line 4 lands on line 5 of the result
    expect(diff).toMatch(/^@@ -4,0 \+5,1 @@/m);
  });

  it('keeps the line an insertion follows in the context', () => {
    const diff = diffOf([{ insertAfterLine: 4, insertion: '    METHODS three.' }]);
    const context = diff.split('\n').filter(line => line.startsWith(' '));
    // line 4 is the one being inserted after: it used to be dropped entirely
    expect(context).toContain('     METHODS two.');
    expect(context).toContain('     METHODS one.');
    expect(context).toContain(' ENDCLASS.');
  });

  /**
   * The include created by createInclude is three lines with no trailing
   * newline, so an insertion at its end has to add one - and that newline only
   * terminates the line already there. It was counted as an added blank line.
   */
  it('does not count the newline that closes the last line of a file', () => {
    const src = ['*&----*', '*&  Include  zdev_test', '*&----*'].join('\r\n');
    const edits = [{ insertAfterLine: 3, insertion: 'FORM x.\r\nENDFORM.' }];
    const diff = buildDiff(src, resolveEdits(src, edits));
    expect(marks(diff, '+')).toEqual(['+FORM x.', '+ENDFORM.']);
    expect(diff).toMatch(/^@@ -3,0 \+4,2 @@/m);
    // and the count matches what the patch really produces
    expect(applyEdits(src, resolveEdits(src, edits)).split('\r\n')).toHaveLength(5);
  });

  it('describes an insertion at the top of the file', () => {
    const src = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const diff = buildDiff(src, resolveEdits(src, [{ insertAfterLine: 0, insertion: '* header' }]));
    expect(marks(diff, '+')).toEqual(['+* header']);
    expect(diff).toMatch(/^@@ -0,0 \+1,1 @@/m);
    expect(diff.split('\n').filter(line => line.startsWith(' '))).toEqual([' a', ' b', ' c']);
  });

  it('shows exactly the lines a deletion removes', () => {
    const diff = diffOf([{ startLine: 4, replacement: '' }]);
    expect(marks(diff, '-')).toEqual(['-    METHODS two.']);
    expect(marks(diff, '+')).toEqual([]);
    expect(diff).toMatch(/^@@ -4,1 \+4,0 @@/m);
  });

  it('counts a multi-line replacement correctly', () => {
    const diff = diffOf([{ startLine: 8, endLine: 10, replacement: '  METHOD one.\r\n  ENDMETHOD.' }]);
    expect(marks(diff, '-')).toEqual(['-  METHOD one.', '-    WRITE 1.', '-  ENDMETHOD.']);
    expect(marks(diff, '+')).toEqual(['+  METHOD one.', '+  ENDMETHOD.']);
    expect(diff).toMatch(/^@@ -8,3 \+8,2 @@/m);
  });

  it('describes a deletion of the last line without a phantom line', () => {
    const src = 'a\nb\nc';
    const diff = buildDiff(src, resolveEdits(src, [{ startLine: 3, replacement: '' }]));
    expect(marks(diff, '-')).toEqual(['-c']);
    expect(marks(diff, '+')).toEqual([]);
  });

  it('keeps an anchor edit described by its own text, not by whole lines', () => {
    const diff = diffOf([{ anchor: 'METHODS two', replacement: 'METHODS deux' }]);
    expect(marks(diff, '-')).toEqual(['-METHODS two']);
    expect(marks(diff, '+')).toEqual(['+METHODS deux']);
  });

  it('shows the removal, the addition and the context', () => {
    const diff = buildDiff(CRLF, resolveEdits(CRLF, [{ startLine: 9, replacement: '    WRITE 42.' }]));
    expect(diff).toContain('-    WRITE 1.');
    expect(diff).toContain('+    WRITE 42.');
    expect(diff).toContain('  METHOD one.');
    expect(diff).toMatch(/^@@ -9,1 \+9,1 @@/m);
  });
});

describe('lock lookup by url', () => {
  it('answers with the class lock for a class include, and invents nothing', () => {
    lockRegistry.clear();
    lockRegistry.remember('/sap/bc/adt/oo/classes/zcl_x', 'CLASSHANDLE');
    expect(lockRegistry.forUrl('/sap/bc/adt/oo/classes/zcl_x/includes/testclasses')?.lockHandle)
      .toBe('CLASSHANDLE');
    expect(lockRegistry.forUrl('/sap/bc/adt/oo/classes/zcl_x')?.lockHandle).toBe('CLASSHANDLE');
    expect(lockRegistry.forUrl('/sap/bc/adt/oo/classes/zcl_other')).toBeUndefined();
    // Not a path boundary: a longer name that merely starts the same way.
    expect(lockRegistry.forUrl('/sap/bc/adt/oo/classes/zcl_x2')).toBeUndefined();
    lockRegistry.clear();
  });

  it('prefers the most specific lock it holds', () => {
    lockRegistry.clear();
    lockRegistry.remember('/sap/bc/adt/functions/groups/zfg', 'GROUP');
    lockRegistry.remember('/sap/bc/adt/functions/groups/zfg/fmodules/z_fm', 'MODULE');
    expect(lockRegistry.forUrl('/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main')?.lockHandle)
      .toBe('MODULE');
    expect(lockRegistry.forUrl('/sap/bc/adt/functions/groups/zfg/includes/lzfgtop')?.lockHandle)
      .toBe('GROUP');
    lockRegistry.clear();
  });
});
