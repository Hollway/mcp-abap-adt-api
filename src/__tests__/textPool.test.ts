import {
  TextPoolError,
  elementsFromRows,
  languageLines,
  lettersFor,
  parsePoolPrint,
  poolProgramFor,
  programLiteral,
  readPoolSnippet,
  stringLiteral,
  titleFromRows,
  titleWrite,
  writePoolSnippet,
  writesFor,
  type TextPoolRow
} from '../lib/textPool';

/**
 * The text pool is the fallback for releases that serve no text elements over
 * ADT, and everything expensive to get wrong about it is in this module: the
 * generated ABAP is run on a live system, where a mistake rewrites the texts of
 * a program.
 *
 * Three of these tests hold measured behaviour rather than a design decision:
 *
 *  - the eight characters in front of a selection text are flags, not
 *    indentation. D in the first position means the text comes from the data
 *    dictionary, and overwriting the flags with blanks cuts that link without
 *    saying so;
 *  - headings is two letters at once - T for the list header, H for the four
 *    column headers - and ADT answers with all five even when the program has
 *    none;
 *  - out->write resets sy-subrc, so the subrc of a statement has to be taken on
 *    the very next line. A snippet that printed first once reported a clean run
 *    of a call that had failed.
 */

const row = (id: TextPoolRow['id'], key: string, entry: string, length: number): TextPoolRow =>
  ({ id, key, entry, length });

describe('lettersFor', () => {
  it('knows that headings is two letters', () => {
    expect(lettersFor('symbols')).toEqual(['I']);
    expect(lettersFor('selections')).toEqual(['S']);
    expect(lettersFor('headings')).toEqual(['T', 'H']);
  });
});

describe('elementsFromRows', () => {
  it('serves text symbols with the declared length, not the length of the text', () => {
    const elements = elementsFromRows([row('I', '001', 'Belege', 40)], 'symbols');
    expect(elements).toEqual([{ id: '001', text: 'Belege', maxLength: 40 }]);
  });

  it('cuts the eight flag characters off a selection text and reports the dictionary flag', () => {
    const elements = elementsFromRows(
      [
        row('S', 'P_WERKS', '        Plant', 21),
        row('S', 'P_TPLGD', 'D       .', 9)
      ],
      'selections'
    );
    expect(elements).toEqual([
      { id: 'P_WERKS', text: 'Plant' },
      { id: 'P_TPLGD', text: '.', fromDictionary: true }
    ]);
  });

  it('answers headings with all five elements, the missing ones empty', () => {
    const elements = elementsFromRows(
      [row('H', '001', 'Document', 20), row('H', '003', 'Date', 10)],
      'headings'
    );
    expect(elements.map(element => element.id)).toEqual([
      'listHeader',
      'columnHeader_1',
      'columnHeader_2',
      'columnHeader_3',
      'columnHeader_4'
    ]);
    expect(elements[0]).toEqual({ id: 'listHeader', text: '' });
    expect(elements[1]).toEqual({ id: 'columnHeader_1', text: 'Document', maxLength: 20 });
    expect(elements[3]).toEqual({ id: 'columnHeader_3', text: 'Date', maxLength: 10 });
  });

  it('leaves the program title out of every category, the way ADT does', () => {
    const rows = [row('R', '', 'Delivery monitor', 70), row('I', '001', 'Belege', 40)];
    expect(elementsFromRows(rows, 'symbols')).toHaveLength(1);
    expect(elementsFromRows(rows, 'selections')).toHaveLength(0);
    expect(elementsFromRows(rows, 'headings').every(element => element.text === '')).toBe(true);
  });
});

describe('parsePoolPrint', () => {
  it('reads back what the snippet printed, blanks and brackets included', () => {
    const print = parsePoolPrint([
      'READ~#~0~#~3',
      'ROW~#~I~#~001~#~40~#~[Belege]',
      'ROW~#~S~#~P_TPLGD~#~9~#~[D       .]',
      'ROW~#~T~#~~#~70~#~[Delivery monitor]',
      'INSERT~#~0~#~3'
    ].join('\n'));

    expect(print.subrc).toBe(0);
    expect(print.steps).toEqual({ read: 0, readRows: 3, insert: 0, insertRows: 3 });
    expect(print.rows).toEqual([
      row('I', '001', 'Belege', 40),
      // The flags survive the round trip: without the brackets the seven blanks
      // after the D would be indistinguishable from padding.
      row('S', 'P_TPLGD', 'D       .', 9),
      row('T', '', 'Delivery monitor', 70)
    ]);
  });

  it('ignores whatever else the console carries', () => {
    const print = parsePoolPrint('some banner\n\nROW~#~I~#~001~#~40~#~[Belege]\ndone');
    expect(print.rows).toEqual([row('I', '001', 'Belege', 40)]);
  });

  it('keeps a failed read visible', () => {
    const print = parsePoolPrint('READ~#~4~#~0');
    expect(print.subrc).toBe(4);
    expect(print.rows).toEqual([]);
  });
});

describe('writesFor', () => {
  it('takes the length from maxLength and adds the flag field for a selection text', () => {
    const writes = writesFor('selections', [{ id: 'p_werks', text: 'Plant', maxLength: 20 }]);
    expect(writes).toEqual([
      { letter: 'S', key: 'P_WERKS', text: 'Plant', length: 28, keepsFlags: true }
    ]);
  });

  it('falls back to the length of the text when no maximum is given', () => {
    expect(writesFor('symbols', [{ id: '001', text: 'Belege' }])[0].length).toBe(6);
  });

  it('widens the length rather than cutting the text, and says so', () => {
    const notes: string[] = [];
    const writes = writesFor('symbols', [{ id: '001', text: 'Belegübersicht', maxLength: 5 }], notes);
    expect(writes[0].length).toBe(14);
    expect(notes[0]).toContain('widened');
  });

  it('maps the five heading ids onto their rows', () => {
    const writes = writesFor('headings', [
      { id: 'listHeader', text: 'Monitor' },
      { id: 'columnHeader_2', text: 'Plant' }
    ]);
    expect(writes.map(write => [write.letter, write.key])).toEqual([['T', ''], ['H', '002']]);
  });

  it('refuses a text that does not fit, counting the flag field against it', () => {
    expect(() => writesFor('selections', [{ id: 'P_X', text: 'x'.repeat(125) }]))
      .toThrow(TextPoolError);
    expect(() => writesFor('symbols', [{ id: '001', text: 'x'.repeat(125) }]))
      .not.toThrow();
  });

  it('refuses what would quietly write the wrong row', () => {
    expect(() => writesFor('headings', [{ id: 'columnHeader_5', text: 'x' }])).toThrow(TextPoolError);
    expect(() => writesFor('symbols', [{ id: '001', text: 'a' }, { id: '001', text: 'b' }]))
      .toThrow(TextPoolError);
    expect(() => writesFor('symbols', [{ id: '', text: 'a' }])).toThrow(TextPoolError);
  });

  it('says that an empty text removes the row instead of blanking it', () => {
    const notes: string[] = [];
    writesFor('headings', [{ id: 'listHeader', text: '' }], notes);
    expect(notes[0]).toContain('leaves the pool');
  });
});

describe('writePoolSnippet', () => {
  const snippet = (over: Partial<Parameters<typeof writePoolSnippet>[0]> = {}) => writePoolSnippet({
    program: 'ZR_DELIV_MONITOR',
    category: 'selections',
    writes: writesFor('selections', [{ id: 'P_WERKS', text: 'Plant', maxLength: 20 }]),
    ...over
  });

  it('takes sy-subrc on the line after every pool statement', () => {
    const lines = snippet();
    lines.forEach((line, index) => {
      if (/^(READ|INSERT) TEXTPOOL/.test(line)) {
        expect(lines[index + 1]).toBe('lv_subrc = sy-subrc.');
      }
    });
    expect(lines.filter(line => /^(READ|INSERT) TEXTPOOL/.test(line)).length).toBe(3);
  });

  it('reads, changes and writes in one run, sorted, into the active state', () => {
    const lines = snippet();
    const insert = lines.findIndex(line => line.startsWith('INSERT TEXTPOOL'));
    expect(lines[insert]).toBe("INSERT TEXTPOOL 'ZR_DELIV_MONITOR' FROM lt_pool LANGUAGE lv_langu STATE 'A'.");
    expect(lines.indexOf('SORT lt_pool BY id key.')).toBeLessThan(insert);
    expect(lines.findIndex(line => line.startsWith('READ TEXTPOOL'))).toBeLessThan(insert);
  });

  it('replaces the category by default and only the rows named with merge', () => {
    expect(snippet({ category: 'headings', writes: writesFor('headings', [{ id: 'listHeader', text: 'M' }]) }))
      .toEqual(expect.arrayContaining(["DELETE lt_pool WHERE id = 'T'.", "DELETE lt_pool WHERE id = 'H'."]));
    expect(snippet({ merge: true }).some(line => line === "DELETE lt_pool WHERE id = 'S'.")).toBe(false);
    // The row being written still goes, or the pool would hold it twice.
    expect(snippet({ merge: true })).toEqual(
      expect.arrayContaining(["DELETE lt_pool WHERE id = 'S' AND key = 'P_WERKS'."])
    );
  });

  it('carries the flags of a selection text over from the pool as it was', () => {
    const lines = snippet();
    const copy = lines.indexOf('lt_before = lt_pool.');
    const read = lines.indexOf("READ TABLE lt_before INTO ls_row WITH KEY id = 'S' key = 'P_WERKS'.");
    expect(copy).toBeGreaterThan(-1);
    // The copy is taken before the category is emptied, or the flags would be
    // gone by the time they are looked up.
    expect(copy).toBeLessThan(lines.indexOf("DELETE lt_pool WHERE id = 'S'."));
    expect(read).toBeGreaterThan(copy);
    expect(lines).toEqual(expect.arrayContaining(['  lv_prefix = ls_row-entry(8).']));
  });

  // Measured on a live selection text that came back as "ва" instead of
  // "Проба два": a string template converts the C field and drops its trailing
  // blanks, so the D of a dictionary flag landed straight against the text and
  // the next read cut eight characters off the front of it. Offsets keep the
  // blanks, and nothing else here does.
  it('puts the flags in by offset, never through a string template', () => {
    const lines = snippet();
    expect(lines).toEqual(expect.arrayContaining([
      'ls_new-entry(8) = lv_prefix.',
      'ls_new-entry+8 = `Plant`.'
    ]));
    expect(lines.some(line => line.includes('{ lv_prefix }'))).toBe(false);
  });

  it('writes a text symbol without a flag field', () => {
    const lines = writePoolSnippet({
      program: 'ZFOO',
      category: 'symbols',
      writes: writesFor('symbols', [{ id: '001', text: 'Belege' }])
    });
    expect(lines).toEqual(expect.arrayContaining(['ls_new-entry = `Belege`.']));
    expect(lines.some(line => line.includes('lv_prefix'))).toBe(false);
  });

  it('removes a row whose text is empty instead of appending an empty one', () => {
    const lines = writePoolSnippet({
      program: 'ZFOO',
      category: 'headings',
      writes: writesFor('headings', [{ id: 'listHeader', text: '' }]),
      merge: true
    });
    expect(lines).toEqual(expect.arrayContaining(["DELETE lt_pool WHERE id = 'T' AND key = ''."]));
    expect(lines.some(line => line === 'APPEND ls_new TO lt_pool.')).toBe(false);
  });

  it('escapes a text that carries a backtick', () => {
    const lines = writePoolSnippet({
      program: 'ZFOO',
      category: 'symbols',
      writes: writesFor('symbols', [{ id: '001', text: 'a`b' }])
    });
    expect(lines).toEqual(expect.arrayContaining(['ls_new-entry = `a``b`.']));
  });
});

describe('the program title', () => {
  // ADT serves the R row in no category at all, so it is a parameter of its
  // own - and it has to survive a category being replaced, because no category
  // owns that letter.
  it('is read off its own row', () => {
    expect(titleFromRows([row('R', '', 'Delivery monitor', 70), row('I', '001', 'x', 1)]))
      .toEqual({ text: 'Delivery monitor', maxLength: 70 });
    expect(titleFromRows([row('I', '001', 'x', 1)])).toBeUndefined();
  });

  it('follows the same length rule as an element', () => {
    expect(titleWrite('Monitor', 40)).toEqual({ letter: 'R', key: '', text: 'Monitor', length: 40, keepsFlags: false });
    const notes: string[] = [];
    expect(titleWrite('Delivery monitor', 4, notes).length).toBe(16);
    expect(notes[0]).toContain('widened');
    expect(() => titleWrite('x'.repeat(133))).toThrow(TextPoolError);
  });

  it('is written without disturbing the category being replaced', () => {
    const lines = writePoolSnippet({
      program: 'ZFOO',
      category: 'symbols',
      writes: [...writesFor('symbols', [{ id: '001', text: 'Belege' }]), titleWrite('Monitor')]
    });
    expect(lines).toEqual(expect.arrayContaining([
      "DELETE lt_pool WHERE id = 'I'.",
      "DELETE lt_pool WHERE id = 'R' AND key = ''.",
      'ls_new-entry = `Monitor`.'
    ]));
    // Replacing the symbols must not take the title with it.
    expect(lines.some(line => line === "DELETE lt_pool WHERE id = 'R'.")).toBe(false);
  });
});

describe('readPoolSnippet', () => {
  it('prints the rows of the pool it read', () => {
    const lines = readPoolSnippet('ZFOO');
    expect(lines).toEqual(expect.arrayContaining([
      "READ TEXTPOOL 'ZFOO' INTO lt_pool LANGUAGE lv_langu.",
      'lv_subrc = sy-subrc.',
      'LOOP AT lt_pool INTO ls_row.'
    ]));
    expect(lines.some(line => line.startsWith('INSERT TEXTPOOL'))).toBe(false);
  });
});

describe('languageLines', () => {
  it('uses the language of the session when none is given', () => {
    expect(languageLines()).toEqual(['lv_langu = sy-langu.']);
  });

  it('takes the one-character SAP key as it stands', () => {
    expect(languageLines('r')).toEqual(["lv_langu = 'R'."]);
  });

  it('lets the system convert a two-character ISO code, because the mapping is not the first letter', () => {
    const lines = languageLines('ru');
    expect(lines[1]).toBe("    lv_langu = cl_i18n_languages=>sap2_to_sap1( 'RU' ).");
    expect(lines).toEqual(expect.arrayContaining(['  CATCH cx_root.']));
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => languageLines('rus')).toThrow(TextPoolError);
  });
});

describe('programLiteral and stringLiteral', () => {
  it('refuses a name that would carry a statement of its own', () => {
    expect(() => programLiteral("ZFOO'. DELETE lt_pool. \"")).toThrow(TextPoolError);
    expect(programLiteral('/dune/zfoo')).toBe("'/DUNE/ZFOO'");
    // Measured: a class pool is all equals signs, and the first pattern here
    // refused every class on the system.
    expect(programLiteral('ZCL_AOC_CHECK_01==============CP'))
      .toBe("'ZCL_AOC_CHECK_01==============CP'");
  });

  it('refuses a text with a line break, which no pool entry has', () => {
    expect(() => stringLiteral('a\nb')).toThrow(TextPoolError);
  });
});

describe('poolProgramFor', () => {
  it('knows where each kind of object keeps its texts', () => {
    expect(poolProgramFor('PROG/P', 'zr_foo')).toBe('ZR_FOO');
    expect(poolProgramFor('FUGR/F', 'zfg_foo')).toBe('SAPLZFG_FOO');
    const classPool = poolProgramFor('CLAS/OC', 'zcl_foo');
    expect(classPool).toBe('ZCL_FOO=======================CP');
    expect(classPool).toHaveLength(32);
  });
});
