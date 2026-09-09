import { unifiedDiff, diffLines, splitLines } from '../lib/textDiff';

const abap = (...lines: string[]) => lines.join('\n');

describe('splitLines', () => {
  it('reads CRLF and LF alike, and drops the phantom last line', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual(['']);
  });
});

describe('unifiedDiff', () => {
  it('says nothing changed when nothing changed', () => {
    const text = abap('METHOD foo.', '  DATA(x) = 1.', 'ENDMETHOD.');
    const result = unifiedDiff(text, text);
    expect(result.stats).toMatchObject({ identical: true, added: 0, removed: 0, hunks: 0 });
    expect(result.diff).toBe('');
  });

  it('sees a CRLF source and an LF source as the same text', () => {
    const result = unifiedDiff('METHOD foo.\r\nENDMETHOD.\r\n', 'METHOD foo.\nENDMETHOD.\n');
    expect(result.stats.identical).toBe(true);
  });

  it('reports one changed line with its numbers and context', () => {
    const before = abap('REPORT z.', 'DATA lv_a TYPE i.', 'lv_a = 1.', 'WRITE lv_a.');
    const after = abap('REPORT z.', 'DATA lv_a TYPE i.', 'lv_a = 2.', 'WRITE lv_a.');
    const result = unifiedDiff(before, after, { context: 1 });
    expect(result.stats).toMatchObject({ added: 1, removed: 1, hunks: 1, identical: false });
    expect(result.diff).toBe([
      '@@ -2,3 +2,3 @@',
      ' DATA lv_a TYPE i.',
      '-lv_a = 1.',
      '+lv_a = 2.',
      ' WRITE lv_a.'
    ].join('\n'));
  });

  it('counts an insertion and a deletion separately', () => {
    const before = abap('a', 'b', 'c');
    const after = abap('a', 'b1', 'b2', 'c');
    const result = unifiedDiff(before, after, { context: 0 });
    expect(result.stats).toMatchObject({ added: 2, removed: 1, hunks: 1 });
  });

  it('keeps two distant changes in separate hunks and adjacent ones together', () => {
    const before = abap(...Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
    const after = splitLines(before);
    after[1] = 'line 2 changed';
    after[25] = 'line 26 changed';
    const result = unifiedDiff(before, after.join('\n'), { context: 2 });
    expect(result.stats.hunks).toBe(2);
    expect(result.diff.split('\n').filter(l => l.startsWith('@@'))).toHaveLength(2);
  });

  it('labels the two sides when asked', () => {
    const result = unifiedDiff('a', 'b', { beforeLabel: 'version 3', afterLabel: 'active' });
    expect(result.diff.split('\n').slice(0, 2)).toEqual(['--- version 3', '+++ active']);
  });

  /**
   * The reason this is patience diff and not a plain LCS. Inserting a whole
   * method into a class gives an LCS the chance to pair the new ENDMETHOD with
   * the old one and call the method NAMES the change - a minimal diff that
   * reads as if two unrelated methods were rewritten.
   */
  it('shows an inserted method as an insertion, not as two rewritten methods', () => {
    const before = abap(
      'CLASS zcl_x IMPLEMENTATION.',
      '  METHOD first.',
      '    out = 1.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    );
    const after = abap(
      'CLASS zcl_x IMPLEMENTATION.',
      '  METHOD first.',
      '    out = 1.',
      '  ENDMETHOD.',
      '  METHOD second.',
      '    out = 2.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    );
    const result = unifiedDiff(before, after, { context: 1 });
    expect(result.stats).toMatchObject({ added: 3, removed: 0 });
    expect(result.diff).not.toMatch(/^-/m);
  });

  it('does not anchor on a blank line', () => {
    const before = abap('METHOD a.', '', 'ENDMETHOD.');
    const after = abap('METHOD b.', '', 'ENDMETHOD.');
    const result = unifiedDiff(before, after, { context: 0 });
    expect(result.stats).toMatchObject({ added: 1, removed: 1 });
  });

  it('handles an empty side', () => {
    expect(unifiedDiff('', abap('a', 'b')).stats).toMatchObject({ added: 2, removed: 1 });
    expect(unifiedDiff(abap('a', 'b'), '').stats).toMatchObject({ added: 1, removed: 2 });
  });
});

describe('diffLines', () => {
  it('returns ranges that reconstruct the after text', () => {
    const before = ['a', 'b', 'c', 'd'];
    const after = ['a', 'x', 'c', 'd', 'e'];
    const rebuilt: string[] = [];
    for (const op of diffLines(before, after)) {
      if (op.type === 'delete') continue;
      for (let i = op.bStart; i < op.bEnd; i++) rebuilt.push(after[i]);
    }
    expect(rebuilt).toEqual(after);
  });

  // A file where every line repeats has no unique anchor at all: the bounded
  // LCS has to carry it, and it must still describe the change.
  it('falls back to LCS when no line is unique', () => {
    const before = ['x', 'x', 'x', 'x'];
    const after = ['x', 'x', 'x'];
    const result = unifiedDiff(before.join('\n'), after.join('\n'));
    expect(result.stats).toMatchObject({ added: 0, removed: 1, identical: false });
  });

  it('reports a block too large to diff line by line instead of grinding on it', () => {
    // Over the cell budget on both sides, with no unique line to anchor on.
    const before = Array.from({ length: 1200 }, (_, i) => `a${i % 7}`);
    const after = Array.from({ length: 1200 }, (_, i) => `b${i % 7}`);
    const result = unifiedDiff(before.join('\n'), after.join('\n'));
    expect(result.stats.coarse).toBe(true);
    expect(result.diff).toMatch(/too large a block to diff line by line/);
  });
});
