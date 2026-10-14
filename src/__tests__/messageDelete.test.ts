import {
  MAX_NUMBERS,
  classDeletionToken,
  classHeader,
  classLongTextsSql,
  classNumbers,
  deleteMessageClassSnippet,
  deleteMessagesSnippet,
  deletionToken,
  expectedCounts,
  inListQueries,
  longTextObject,
  longTextsSql,
  messageClassName,
  messageNumbers,
  messageState,
  recordedSql,
  textsSql
} from '../lib/messageDelete';
import { DdifError, parseDdifPrint } from '../lib/ddifWrite';
import { APPEND_EXCEPTIONS } from '../lib/transportRegistration';

/**
 * Deleting a message is three tables and a long text, under a lock, in one
 * transaction, recorded as LIMU MESS with function D. What is held here:
 *
 *  - the long text is deleted by plain DELETEs, never DOCU_DEL: that module
 *    calls over DESTINATION 'NONE', and the synchronous RFC would commit
 *    whatever the snippet had done before a rollback could undo it;
 *  - every stop after the lock rolls back and releases the lock;
 *  - the transport entry names class and number run together, function D;
 *  - no statement the query endpoint gets passes 255 characters, no line of
 *    ABAP passes 255 either.
 */
const state = () =>
  messageState('ZDEMO_MSG', {
    texts: [
      { MSGNR: '007', SPRSL: 'R', TEXT: 'Текст &1   ' },
      { MSGNR: '007', SPRSL: 'E', TEXT: 'Text &1' },
      { MSGNR: '012', SPRSL: 'R', TEXT: 'Другое' }
    ],
    authors: [
      { MSGNR: '007', NAME: 'DEVELOPER', DATUM: '2026-10-01', SELFDEF: '' },
      { MSGNR: '012', NAME: 'DEVELOPER', DATUM: '2026-10-01', SELFDEF: '3' }
    ],
    supplements: [{ MSGNR: '012' }],
    longTexts: [
      { OBJECT: 'ZDEMO_MSG007', LANGU: 'R', TYP: 'E', DOKVERSION: 2, DOKSTATE: 'R' },
      { OBJECT: 'ZDEMO_MSG007', LANGU: 'R', TYP: 'E', DOKVERSION: 1, DOKSTATE: 'R' },
      { OBJECT: 'ZDEMO_MSG007', LANGU: 'E', TYP: 'E', DOKVERSION: 1, DOKSTATE: 'R' },
      // The stub a self-explanatory message gets: language D, state N, no text.
      { OBJECT: 'ZDEMO_MSG012', LANGU: 'D', TYP: 'E', DOKVERSION: 1, DOKSTATE: 'N' }
    ]
  });

const longest = (code: string[]) => Math.max(...code.map(line => line.length));

describe('messageNumbers', () => {
  it('pads, dedupes and sorts', () => {
    expect(messageNumbers(['12', 7, '007'])).toEqual(['007', '012']);
  });

  it('takes a single number', () => {
    expect(messageNumbers('3')).toEqual(['003']);
  });

  it('refuses an empty list, a non-number and too many', () => {
    expect(() => messageNumbers([])).toThrow(DdifError);
    expect(() => messageNumbers(['1000'])).toThrow(/one to three digits/);
    const many = Array.from({ length: MAX_NUMBERS + 1 }, (_, index) => String(index));
    expect(() => messageNumbers(many)).toThrow(/at most/);
  });
});

describe('messageClassName', () => {
  it('takes a class that starts with a digit, as class 00 does', () => {
    expect(messageClassName('00')).toBe('00');
    expect(messageClassName('v1')).toBe('V1');
    expect(messageClassName('/abc/msg')).toBe('/ABC/MSG');
  });

  it('upper-cases and holds the 20 characters of ARBGB', () => {
    expect(messageClassName(' zdemo ')).toBe('ZDEMO');
    expect(() => messageClassName('Z' + 'X'.repeat(20))).toThrow(/20/);
    expect(() => messageClassName("Z'; DELETE")).toThrow(DdifError);
  });
});

describe('the reads', () => {
  it('cuts an IN list so no statement passes 255 characters', () => {
    const numbers = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, '0'));
    const queries = textsSql('ZDEMO_MSG', numbers);
    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries) expect(query.length).toBeLessThanOrEqual(255);
    const values = queries.flatMap(query => query.match(/'\d{3}'/g) || []);
    expect(values).toHaveLength(100);
  });

  it('asks DOKHL for class and number run together under ID NA', () => {
    const [query] = longTextsSql('ZDEMO_MSG', ['007']);
    expect(query).toContain("id = 'NA'");
    expect(query).toContain("'ZDEMO_MSG007'");
    expect(longTextObject('ZDEMO_MSG', '007')).toBe('ZDEMO_MSG007');
  });

  it('reads the task back for LIMU MESS entries', () => {
    const [query] = recordedSql('DEVK900123', 'ZDEMO_MSG', ['007']);
    expect(query).toContain("pgmid = 'LIMU' AND object = 'MESS'");
    expect(query).toContain("'ZDEMO_MSG007'");
  });

  it('refuses a value too long for any statement', () => {
    expect(() => inListQueries('SELECT x FROM y WHERE z', ['A'.repeat(260)])).toThrow(DdifError);
  });
});

describe('messageState', () => {
  it('puts the rows together per number', () => {
    const current = state();
    expect(current.texts['007']).toEqual({ R: 'Текст &1', E: 'Text &1' });
    expect(current.authors['007']).toEqual({ changedBy: 'DEVELOPER', changedOn: '2026-10-01', selfExplanatory: false });
    expect(current.supplements).toEqual(['012']);
    expect(current.longTexts['007']).toEqual([
      { language: 'E', version: 1, state: 'R' },
      { language: 'R', version: 1, state: 'R' },
      { language: 'R', version: 2, state: 'R' }
    ]);
  });

  it('reads SELFDEF 3 as self-explanatory - the value ADT writes, not X', () => {
    expect(state().authors['012'].selfExplanatory).toBe(true);
    expect(state().longTexts['012']).toEqual([{ language: 'D', version: 1, state: 'N' }]);
  });

  it('counts DOKHL rows, versions included, as the snippet does', () => {
    expect(expectedCounts(state())).toEqual({ texts: 3, longTexts: 4 });
  });
});

describe('deletionToken', () => {
  it('is stable for the same state and changes with any of it', () => {
    const token = deletionToken('ZDEMO_MSG', ['007', '012'], state());
    expect(deletionToken('ZDEMO_MSG', ['012', '007'], state())).toBe(token);
    expect(deletionToken('ZDEMO_MSG', ['007'], state())).not.toBe(token);

    const changed = state();
    changed.texts['012'].R = 'Изменено';
    expect(deletionToken('ZDEMO_MSG', ['007', '012'], changed)).not.toBe(token);

    const documented = state();
    documented.longTexts['012'].push({ language: 'R', version: 1, state: 'R' });
    expect(deletionToken('ZDEMO_MSG', ['007', '012'], documented)).not.toBe(token);
  });
});

describe('deleteMessagesSnippet', () => {
  const spec = { className: 'ZDEMO_MSG', numbers: ['007', '012'], expected: { texts: 3, longTexts: 2 } };

  it('locks first, checks the counts, deletes every table, verifies, commits, releases', () => {
    const { code } = deleteMessagesSnippet(spec);
    const text = code.join('\n');
    const order = [
      "CALL FUNCTION 'ENQUEUE_ES_MSGSI'",
      'SELECT COUNT(*) FROM t100',
      'IF lv_count <> 3.',
      'SELECT COUNT(*) FROM dokhl',
      'IF lv_count <> 2.',
      'DELETE FROM t100 ',
      'DELETE FROM t100u ',
      'DELETE FROM t100x ',
      'DELETE FROM dokhl ',
      'DELETE FROM doktl ',
      'DELETE FROM dokil ',
      'COMMIT WORK AND WAIT.',
      "CALL FUNCTION 'DEQUEUE_ES_MSGSI'"
    ];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  it('never calls DOCU_DEL - its RFC to NONE would commit before a rollback could undo', () => {
    expect(deleteMessagesSnippet(spec).code.join('\n')).not.toMatch(/DOCU_DEL/i);
  });

  it('rolls back and releases the lock on every stop after the lock', () => {
    const { code } = deleteMessagesSnippet({ ...spec, task: 'DEVK900124' });
    const returns = code
      .map((line, index) => ({ line, index }))
      .filter(entry => entry.line.trim() === 'RETURN.')
      .map(entry => entry.index);
    // The enqueue step's own stop comes before the lock is held; every later one is after it.
    const lockedAt = code.findIndex(line => line.includes("'ENQUEUE_ES_MSGSI'"));
    const enqueueStop = returns.find(index => index > lockedAt)!;
    const afterLock = returns.filter(index => index > enqueueStop);
    expect(afterLock.length).toBeGreaterThanOrEqual(5);
    for (const index of afterLock) {
      const before = code.slice(Math.max(0, index - 4), index).join('\n');
      expect(before).toContain('ROLLBACK WORK.');
      expect(before).toContain("'DEQUEUE_ES_MSGSI'");
    }
  });

  it('records each number as LIMU MESS class+number with function D in the task, before deleting', () => {
    const { code, exceptions } = deleteMessagesSnippet({ ...spec, task: 'DEVK900124' });
    const text = code.join('\n');
    expect(text).toContain("obj_name = 'ZDEMO_MSG007' objfunc = 'D'");
    expect(text).toContain("obj_name = 'ZDEMO_MSG012' objfunc = 'D'");
    expect(text).toContain("wi_trkorr = 'DEVK900124'");
    expect(text.indexOf("'TR_APPEND_TO_COMM_OBJS_KEYS'")).toBeLessThan(text.indexOf('DELETE FROM t100 '));
    expect(exceptions.transport).toEqual([...APPEND_EXCEPTIONS]);
  });

  it('hands TR_APPEND_TO_COMM_OBJS_KEYS default-key tables - an empty-key one dumps inside SAPLSTRI', () => {
    const text = deleteMessagesSnippet({ ...spec, task: 'DEVK900124' }).code.join('\n');
    expect(text).toContain('DATA lt_e071 TYPE STANDARD TABLE OF e071 WITH DEFAULT KEY.');
    expect(text).toContain('DATA lt_e071k TYPE STANDARD TABLE OF e071k WITH DEFAULT KEY.');
    expect(text).not.toMatch(/OF e071k? WITH EMPTY KEY/);
  });

  it('records nothing for a local class', () => {
    const { code, exceptions } = deleteMessagesSnippet(spec);
    expect(code.join('\n')).not.toContain('TR_APPEND_TO_COMM_OBJS_KEYS');
    expect(exceptions.transport).toBeUndefined();
  });

  it('keeps every line within 255 characters, even for a hundred numbers', () => {
    const numbers = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, '0'));
    const { code } = deleteMessagesSnippet({
      className: 'Z' + 'X'.repeat(19),
      numbers,
      task: 'DEVK900124',
      expected: { texts: 100, longTexts: 0 }
    });
    expect(longest(code)).toBeLessThanOrEqual(255);
  });

  it('prints steps and counts the parser reads back', () => {
    const output = [
      'STEP~#~enqueue~#~0~#~0~#~~#~~#~',
      'STEP~#~compare~#~0~#~0~#~~#~~#~',
      'INFO~#~texts~#~3',
      'INFO~#~docHeaders~#~2',
      'STEP~#~verify~#~0~#~0~#~~#~~#~',
      'STEP~#~commit~#~0~#~0~#~~#~~#~'
    ].join('\n');
    const print = parseDdifPrint(output, deleteMessagesSnippet(spec).exceptions);
    expect(print.steps.map(step => step.step)).toEqual(['enqueue', 'compare', 'verify', 'commit']);
    expect(print.steps.every(step => step.ok)).toBe(true);
    expect(print.info).toEqual({ texts: '3', docHeaders: '2' });
  });

  it('names a lock conflict by its exception', () => {
    const print = parseDdifPrint('STEP~#~enqueue~#~1~#~0~#~MC~#~601~#~locked', deleteMessagesSnippet(spec).exceptions);
    expect(print.steps[0].exception).toBe('FOREIGN_LOCK');
  });
});

describe('messageState on a read of the whole class', () => {
  it('keeps only class plus three digits - LIKE also finds ZDEMO_MSG1 and wildcard matches', () => {
    const current = messageState('ZDEMO_MSG', {
      texts: [],
      authors: [],
      supplements: [],
      longTexts: [
        { OBJECT: 'ZDEMO_MSG007', LANGU: 'R', DOKVERSION: 1, DOKSTATE: 'R' },
        { OBJECT: 'ZDEMO_MSG1007', LANGU: 'R', DOKVERSION: 1, DOKSTATE: 'R' },
        { OBJECT: 'ZDEMO_MSGX07', LANGU: 'R', DOKVERSION: 1, DOKSTATE: 'R' }
      ]
    });
    expect(Object.keys(current.longTexts)).toEqual(['007']);
  });

  it('reads DOKHL by prefix under ID NA', () => {
    expect(classLongTextsSql('ZDEMO_MSG')).toContain("id = 'NA' AND object LIKE 'ZDEMO_MSG%'");
  });

  it('lists every number with a trace: text, change record or long text', () => {
    const current = state();
    current.longTexts['099'] = [{ language: 'R', version: 1, state: 'R' }];
    expect(classNumbers(current)).toEqual(['007', '012', '099']);
  });
});

describe('classDeletionToken', () => {
  const header = classHeader({ MASTERLANG: 'R', RESPUSER: 'DEVELOPER', LASTUSER: 'DEVELOPER', LDATE: '2026-10-01', LTIME: '120000' });

  it('changes with the package, the header, a description or a message', () => {
    const token = classDeletionToken('ZDEMO_MSG', '$TMP', header, { R: 'Demo' }, state());
    expect(classDeletionToken('ZDEMO_MSG', '$TMP', header, { R: 'Demo' }, state())).toBe(token);
    expect(classDeletionToken('ZDEMO_MSG', 'ZDEMO', header, { R: 'Demo' }, state())).not.toBe(token);
    expect(classDeletionToken('ZDEMO_MSG', '$TMP', { ...header!, lastChangedOn: '2026-10-02 120000' }, { R: 'Demo' }, state())).not.toBe(token);
    expect(classDeletionToken('ZDEMO_MSG', '$TMP', header, { R: 'Demo', E: 'Demo' }, state())).not.toBe(token);
    const changed = state();
    changed.texts['007'].E = 'Changed';
    expect(classDeletionToken('ZDEMO_MSG', '$TMP', header, { R: 'Demo' }, changed)).not.toBe(token);
  });
});

describe('deleteMessageClassSnippet', () => {
  const local = { className: 'ZDEMO_MSG', packageName: '$TMP', expected: { texts: 3, longTexts: 2 } };
  const transported = { ...local, packageName: 'ZDEMO', request: 'DEVK900123' };

  it('locks, compares, records with RS_CORR_INSERT mode D, deletes every table, verifies, commits, releases', () => {
    const text = deleteMessageClassSnippet(transported).code.join('\n');
    const order = [
      "CALL FUNCTION 'ENQUEUE_ES_MSGSI'",
      'SELECT COUNT(*) FROM t100 ',
      'IF lv_count <> 3.',
      'IF lv_count <> 2.',
      "CALL FUNCTION 'RS_CORR_INSERT'",
      'DELETE FROM t100 ',
      'DELETE FROM t100a ',
      'DELETE FROM t100o ',
      'DELETE FROM t100t ',
      'DELETE FROM t100u ',
      'DELETE FROM t100x ',
      'DELETE FROM dokhl ',
      'DELETE FROM doktl ',
      'DELETE FROM dokil ',
      'SELECT COUNT(*) FROM t100a ',
      'COMMIT WORK AND WAIT.',
      "CALL FUNCTION 'DEQUEUE_ES_MSGSI'"
    ];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  it('gives RS_CORR_INSERT the request, object class MSAG and mode D, without immediately', () => {
    const text = deleteMessageClassSnippet(transported).code.join('\n');
    expect(text).toContain("object = 'ZDEMO_MSG' object_class = 'MSAG' mode = 'D'");
    expect(text).toContain("korrnum = 'DEVK900123'");
    expect(text).toContain("suppress_dialog = 'X'");
    expect(text).not.toMatch(/use_korrnum_immediatedly/i);
  });

  it('needs a request outside a $ package', () => {
    expect(() => deleteMessageClassSnippet({ ...transported, request: undefined })).toThrow(DdifError);
  });

  /**
   * An empty range matches every row: DELETE FROM dokhl WHERE object IN lr_doc
   * with nothing in lr_doc would take the long texts of every message class.
   */
  it('touches the long texts only behind IF lr_doc IS NOT INITIAL', () => {
    const { code } = deleteMessageClassSnippet(local);
    code.forEach((line, index) => {
      if (/lr_doc/.test(line) && /\b(DELETE|SELECT)\b/.test(line)) {
        const guard = code.slice(0, index).reverse().find(previous => /^\s*(IF lr_doc IS NOT INITIAL\.|ENDIF\.)\s*$/.test(previous));
        expect(guard?.trim()).toBe('IF lr_doc IS NOT INITIAL.');
      }
    });
  });

  it('takes a long text only as class plus three digits', () => {
    const text = deleteMessageClassSnippet(local).code.join('\n');
    expect(text).toContain("object LIKE 'ZDEMO_MSG%'");
    expect(text).toContain("IF strlen( lv_obj ) = 12 AND lv_obj(9) = 'ZDEMO_MSG' AND lv_obj+9(3) CO '0123456789'.");
  });

  it('removes the directory entry itself only in a local package', () => {
    expect(deleteMessageClassSnippet(local).code.join('\n')).toContain("wi_delete_tadir_entry = 'X'");
    expect(deleteMessageClassSnippet(transported).code.join('\n')).not.toContain('TR_TADIR_INTERFACE');
  });

  it('rolls back and releases the lock on every stop after the lock', () => {
    const { code } = deleteMessageClassSnippet(local);
    const lockedAt = code.findIndex(line => line.includes("'ENQUEUE_ES_MSGSI'"));
    const returns = code
      .map((line, index) => ({ line, index }))
      .filter(entry => entry.line.trim() === 'RETURN.' && entry.index > lockedAt)
      .map(entry => entry.index);
    const afterLock = returns.slice(1);
    expect(afterLock.length).toBeGreaterThanOrEqual(6);
    for (const index of afterLock) {
      const before = code.slice(Math.max(0, index - 4), index).join('\n');
      expect(before).toContain('ROLLBACK WORK.');
      expect(before).toContain("'DEQUEUE_ES_MSGSI'");
    }
  });

  it('never calls DOCU_DEL or DOKU_DELETE_ALL, and keeps lines within 255 characters', () => {
    const { code } = deleteMessageClassSnippet({ ...transported, className: 'Z' + 'X'.repeat(19) });
    expect(code.join('\n')).not.toMatch(/DOCU_DEL|DOKU_DELETE_ALL/i);
    expect(longest(code)).toBeLessThanOrEqual(255);
  });

  it('prints the task and request RS_CORR_INSERT chose, and names its exceptions', () => {
    const { exceptions } = deleteMessageClassSnippet(transported);
    const print = parseDdifPrint(
      ['STEP~#~transport~#~1~#~0~#~TK~#~001~#~cancelled', 'INFO~#~task~#~DEVK900124'].join('\n'),
      exceptions
    );
    expect(print.steps[0].exception).toBe('CANCELLED');
    expect(print.info.task).toBe('DEVK900124');
  });
});