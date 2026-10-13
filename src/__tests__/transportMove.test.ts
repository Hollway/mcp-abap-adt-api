import {
  DELETE_EXCEPTIONS,
  MAX_OBJECTS,
  headerEntries,
  headerKeysSql,
  moveToTaskSnippet,
  moveToken,
  selectEntries
} from '../lib/transportMove';
import type { HeaderEntry } from '../lib/transportMove';
import { DdifError, parseDdifPrint } from '../lib/ddifWrite';
import { APPEND_EXCEPTIONS } from '../lib/transportRegistration';

/**
 * Moving an entry off a request header and into a task. What is held here:
 * the order measured on the ERP system (read, take off, append, commit); a
 * stop after the first take-off rolls back, so nothing is left in neither;
 * the keys of an entry travel with it; and the selection is checked against
 * what the header really holds.
 */
const header: HeaderEntry[] = headerEntries(
  [
    { PGMID: 'R3TR', OBJECT: 'DOMA', OBJ_NAME: 'ZDEMO_DOM', OBJFUNC: '' },
    { PGMID: 'R3TR', OBJECT: 'TABL', OBJ_NAME: 'ZDEMO_TAB', OBJFUNC: '' },
    { PGMID: 'R3TR', OBJECT: 'TABU', OBJ_NAME: 'ZDEMO_TAB', OBJFUNC: 'K' }
  ],
  [{ MASTERTYPE: 'TABU', MASTERNAME: 'ZDEMO_TAB', CNT: 4 }]
);

describe('headerEntries', () => {
  it('attaches the key count to the entry it hangs off', () => {
    expect(header.map(entry => entry.keys)).toEqual([0, 0, 4]);
    expect(header[2].OBJFUNC).toBe('K');
  });

  it('groups the keys in the query', () => {
    expect(headerKeysSql('DEVK900123')).toContain('GROUP BY mastertype, mastername');
  });
});

describe('selectEntries', () => {
  it('takes the whole header when nothing is named', () => {
    expect(selectEntries(header, undefined)).toHaveLength(3);
    expect(selectEntries(header, [])).toHaveLength(3);
  });

  it('takes the named entries, R3TR by default, once each', () => {
    const chosen = selectEntries(header, [
      { object: 'doma', objName: 'zdemo_dom' },
      { pgmid: 'R3TR', object: 'DOMA', objName: 'ZDEMO_DOM' }
    ]);
    expect(chosen).toEqual([header[0]]);
  });

  it('refuses an entry the header does not hold', () => {
    expect(() => selectEntries(header, [{ object: 'DTEL', objName: 'ZDEMO_DTEL' }])).toThrow(/Not on the request header: R3TR DTEL ZDEMO_DTEL/);
  });

  it('refuses an empty header and too many entries', () => {
    expect(() => selectEntries([], undefined)).toThrow(/every object is in a task already/);
    const many = Array.from({ length: MAX_OBJECTS + 1 }, (_, index) => ({ object: 'DOMA', objName: `ZD${index}` }));
    expect(() => selectEntries(header, many)).toThrow(DdifError);
  });
});

describe('moveToken', () => {
  it('changes with the task, the selection and the keys', () => {
    const token = moveToken('DEVK900123', 'DEVK900124', header);
    expect(moveToken('DEVK900123', 'DEVK900124', [...header].reverse())).toBe(token);
    expect(moveToken('DEVK900123', 'DEVK900125', header)).not.toBe(token);
    expect(moveToken('DEVK900123', 'DEVK900124', header.slice(1))).not.toBe(token);
    expect(moveToken('DEVK900123', 'DEVK900124', header.map(entry => ({ ...entry, keys: entry.keys + 1 })))).not.toBe(token);
  });
});

describe('moveToTaskSnippet', () => {
  const spec = { request: 'DEVK900123', task: 'DEVK900124', entries: header };

  it('reads, takes each entry off, appends them all, commits - in that order', () => {
    const text = moveToTaskSnippet(spec).code.join('\n');
    const read = text.indexOf("'TR_READ_REQUEST'");
    const firstOff = text.indexOf("'TR_DELETE_COMM_OBJECT_KEYS'");
    const append = text.indexOf("'TR_APPEND_TO_COMM_OBJS_KEYS'");
    const commit = text.indexOf('COMMIT WORK AND WAIT.');
    expect(read).toBeGreaterThan(-1);
    expect(firstOff).toBeGreaterThan(read);
    expect(append).toBeGreaterThan(text.lastIndexOf("'TR_DELETE_COMM_OBJECT_KEYS'"));
    expect(commit).toBeGreaterThan(append);
    expect(text.match(/'TR_DELETE_COMM_OBJECT_KEYS'/g)).toHaveLength(3);
  });

  it('carries the keys of each entry into the task, in default-key tables', () => {
    const text = moveToTaskSnippet(spec).code.join('\n');
    expect(text).not.toMatch(/OF e071k? WITH EMPTY KEY/);
    expect(text).toContain('LOOP AT ls_request-keys INTO ls_key WHERE mastertype = ls_obj-object AND mastername = ls_obj-obj_name.');
    expect(text).toContain("ls_key-trkorr = 'DEVK900124'.");
    expect(text).toContain('TABLES wt_e071 = lt_e071 wt_e071k = lt_e071k');
  });

  it('rolls back on every stop after the read', () => {
    const { code } = moveToTaskSnippet(spec);
    const readStop = code.findIndex(line => line.trim() === 'RETURN.');
    const later = code
      .map((line, index) => ({ line, index }))
      .filter(entry => entry.line.trim() === 'RETURN.' && entry.index > readStop);
    expect(later.length).toBeGreaterThanOrEqual(7);
    for (const { index } of later) {
      expect(code.slice(Math.max(0, index - 3), index).join('\n')).toContain('ROLLBACK WORK.');
    }
  });

  it('refuses the request as its own task and an empty list', () => {
    expect(() => moveToTaskSnippet({ ...spec, task: 'DEVK900123' })).toThrow(/same number/);
    expect(() => moveToTaskSnippet({ ...spec, entries: [] })).toThrow(/Nothing to move/);
  });

  it('maps the exceptions of each module in signature order', () => {
    const { exceptions } = moveToTaskSnippet(spec);
    expect(exceptions.take_off).toEqual(DELETE_EXCEPTIONS);
    expect(exceptions.append).toEqual([...APPEND_EXCEPTIONS]);
    const print = parseDdifPrint('STEP~#~take_off~#~11~#~0~#~~#~~#~', exceptions);
    expect(print.steps[0].exception).toBe('R_FOREIGN_LOCK');
  });

  it('keeps every line within 255 characters', () => {
    const long = headerEntries(
      [{ PGMID: 'LIMU', OBJECT: 'METH', OBJ_NAME: 'ZCL_' + 'A'.repeat(26) + 'A_VERY_LONG_METHOD_NAME_HERE' }],
      []
    );
    const { code } = moveToTaskSnippet({ ...spec, entries: long });
    expect(Math.max(...code.map(line => line.length))).toBeLessThanOrEqual(255);
  });
});
