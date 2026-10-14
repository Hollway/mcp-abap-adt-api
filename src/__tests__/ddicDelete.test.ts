import {
  ddicDeletionToken,
  ddicKind,
  ddicName,
  deleteDdicSnippet,
  entriesSql,
  headerSql,
  requestEntries,
  usageSqls,
  withdrawal
} from '../lib/ddicDelete';
import type { DdicState } from '../lib/ddicDelete';
import { DdifError, parseDdifPrint } from '../lib/ddifWrite';

/**
 * Deleting a dictionary object is one module, RS_DD_DELETE_OBJ, with what
 * SE11 does around it. What is held here:
 *
 *  - the module is told not to ask, and is never trusted on its word: the
 *    header table is read afterwards, because some refusals return subrc 0;
 *  - a transparent table is counted in every client before anything happens,
 *    since the module commits and dropping a table cannot be rolled back;
 *  - withdrawing happens only after the deletion is proven, and only for an
 *    object no other system can have.
 */
const open = (trkorr: string, parent = '', objfunc = '') => ({ trkorr, objfunc, status: 'D', parent });

describe('ddicKind and ddicName', () => {
  it('takes TADIR types, ADT types and words', () => {
    expect(ddicKind('doma')).toBe('DOMA');
    expect(ddicKind('DTEL/DE')).toBe('DTEL');
    expect(ddicKind('TABL/DT')).toBe('TABL');
    expect(ddicKind('structure')).toBe('TABL');
    expect(() => ddicKind('VIEW')).toThrow(DdifError);
  });

  it('refuses a name no statement should be built from', () => {
    expect(ddicName('TABL', 'zdemo_tab')).toBe('ZDEMO_TAB');
    expect(() => ddicName('TABL', "Z'; DELETE")).toThrow(DdifError);
  });
});

describe('the reads', () => {
  it('reads the table class with the versions of a table', () => {
    expect(headerSql('TABL', 'ZDEMO_TAB')).toBe("SELECT as4local, tabclass, contflag FROM dd02l WHERE tabname = 'ZDEMO_TAB'");
    expect(headerSql('DOMA', 'ZDEMO_DOM')).toContain('FROM dd01l WHERE domname');
  });

  it('asks who uses a domain, a data element and a table in the dictionary', () => {
    expect(Object.keys(usageSqls('DOMA', 'X'))).toEqual(['dataElements']);
    expect(Object.keys(usageSqls('DTEL', 'X'))).toEqual(['fields', 'tableTypes']);
    expect(Object.keys(usageSqls('TABL', 'X'))).toEqual(['fields', 'tableTypes', 'appends', 'views', 'checkTableOf']);
  });

  it('keeps every statement within the 255 characters of the query endpoint', () => {
    const name = 'Z' + 'X'.repeat(29);
    const all = [headerSql('TABL', name), entriesSql('TABL', name), ...Object.values(usageSqls('TABL', name))];
    for (const sql of all) expect(sql.length).toBeLessThanOrEqual(255);
  });
});

describe('withdrawal', () => {
  it('is possible for an object only in open requests of this system', () => {
    const result = withdrawal([open('DEVK900124', 'DEVK900123')], 'DEV', 'ZDEMO');
    expect(result).toEqual({ possible: true, requests: ['DEVK900123'] });
  });

  it('is not possible once a request with it was released', () => {
    const result = withdrawal([open('DEVK900124', 'DEVK900123'), { ...open('DEVK900100'), status: 'R' }], 'DEV', 'ZDEMO');
    expect(result.possible).toBe(false);
    expect(result.reason).toMatch(/DEVK900100 \(released\)/);
  });

  it('is not possible for an object created elsewhere, a local one, or one in no request', () => {
    expect(withdrawal([open('DEVK900124')], 'QAS', 'ZDEMO').possible).toBe(false);
    expect(withdrawal([], 'DEV', '$TMP').possible).toBe(false);
    expect(withdrawal([], 'DEV', 'ZDEMO').reason).toMatch(/no request/);
  });

  it('reads the entries in a stable order', () => {
    const entries = requestEntries([
      { TRKORR: 'DEVK900125', OBJFUNC: 'D', TRSTATUS: 'D', STRKORR: 'DEVK900123' },
      { TRKORR: 'DEVK900124', OBJFUNC: '', TRSTATUS: 'D', STRKORR: 'DEVK900123' }
    ]);
    expect(entries.map(entry => entry.trkorr)).toEqual(['DEVK900124', 'DEVK900125']);
  });
});

describe('ddicDeletionToken', () => {
  const state = (): DdicState => ({
    kind: 'TABL',
    name: 'ZDEMO_TAB',
    versions: [{ AS4LOCAL: 'A', TABCLASS: 'TRANSP' }],
    directory: { DEVCLASS: 'ZDEMO', SRCSYSTEM: 'DEV' },
    entries: [open('DEVK900124', 'DEVK900123')],
    usages: { fields: 0 },
    rows: 0
  });

  it('changes with the state and with the choice to withdraw', () => {
    const token = ddicDeletionToken(state(), false);
    expect(ddicDeletionToken(state(), false)).toBe(token);
    expect(ddicDeletionToken(state(), true)).not.toBe(token);
    expect(ddicDeletionToken({ ...state(), rows: 1 }, false)).not.toBe(token);
    expect(ddicDeletionToken({ ...state(), usages: { fields: 1 } }, false)).not.toBe(token);
    expect(ddicDeletionToken({ ...state(), entries: [] }, false)).not.toBe(token);
  });
});

describe('deleteDdicSnippet', () => {
  const table = { kind: 'TABL' as const, name: 'ZDEMO_TAB', packageName: 'ZDEMO', request: 'DEVK900123', countRows: true, withdraw: false };

  it('counts rows in every client, deletes without asking, then proves it from DD02L', () => {
    const text = deleteDdicSnippet(table).code.join('\n');
    const order = [
      "lv_korrnum = 'DEVK900123'.",
      'SELECT COUNT(*) FROM "ZDEMO_TAB"',
      'IF lv_rows <> 0.',
      "CALL FUNCTION 'RS_DD_DELETE_OBJ'",
      "no_ask = 'X' objname = 'ZDEMO_TAB' objtype = 'T'",
      "SELECT COUNT(*) FROM dd02l INTO lv_count WHERE tabname = 'ZDEMO_TAB'."
    ];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  /**
   * A SELECT probe lied on Oracle: execute_query parses lazily, so without a
   * fetch a dropped table looked present. DB_EXISTS_TABLE asks the database.
   */
  it('commits, then asks DB_EXISTS_TABLE whether a transparent table is gone from the database', () => {
    const text = deleteDdicSnippet(table).code.join('\n');
    expect(text.indexOf('COMMIT WORK AND WAIT.')).toBeGreaterThan(text.indexOf("CALL FUNCTION 'RS_DD_DELETE_OBJ'"));
    expect(text).toContain("CALL FUNCTION 'DB_EXISTS_TABLE' EXPORTING tabname = 'ZDEMO_TAB' IMPORTING subrc = lv_subrc.");
    expect(deleteDdicSnippet({ ...table, countRows: false }).code.join('\n')).not.toContain('DB_EXISTS_TABLE');
  });

  it('never names the object other than as a literal - a static use makes the module refuse', () => {
    const text = deleteDdicSnippet(table).code.join('\n');
    expect(text).not.toMatch(/TYPE\s+zdemo_tab|FROM\s+zdemo_tab\b|TABLES\s+zdemo_tab/i);
  });

  it('counts no rows of a structure, a domain or a data element', () => {
    for (const spec of [
      { ...table, countRows: false },
      { kind: 'DOMA' as const, name: 'ZDEMO_DOM', packageName: '$TMP', countRows: false, withdraw: false },
      { kind: 'DTEL' as const, name: 'ZDEMO_DTE', packageName: '$TMP', countRows: false, withdraw: false }
    ]) {
      expect(deleteDdicSnippet(spec).code.join('\n')).not.toContain('cl_sql_statement');
    }
    expect(deleteDdicSnippet({ kind: 'DOMA', name: 'ZDEMO_DOM', packageName: '$TMP', countRows: false, withdraw: false }).code.join('\n'))
      .toContain("objtype = 'D'");
  });

  it('needs a request outside a $ package, and refuses to withdraw a local object', () => {
    expect(() => deleteDdicSnippet({ ...table, request: undefined })).toThrow(DdifError);
    expect(() => deleteDdicSnippet({ ...table, packageName: '$TMP', withdraw: true })).toThrow(/nothing to withdraw/);
  });

  it('withdraws only after the deletion is proven: entries off every request, then TADIR, then commit', () => {
    const text = deleteDdicSnippet({ ...table, withdraw: true }).code.join('\n');
    const order = [
      "CALL FUNCTION 'RS_DD_DELETE_OBJ'",
      'FROM dd02l INTO lv_count',
      "SELECT trkorr FROM e071 INTO TABLE lt_tr WHERE pgmid = 'R3TR' AND object = 'TABL' AND obj_name = 'ZDEMO_TAB'.",
      "CALL FUNCTION 'TR_READ_REQUEST'",
      "CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'",
      "CALL FUNCTION 'TR_TADIR_INTERFACE'",
      'COMMIT WORK AND WAIT.'
    ];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(deleteDdicSnippet(table).code.join('\n')).not.toContain('TR_DELETE_COMM_OBJECT_KEYS');
  });

  it('keeps every line within 255 characters', () => {
    const { code } = deleteDdicSnippet({ ...table, name: 'Z' + 'X'.repeat(29), withdraw: true });
    expect(Math.max(...code.map(line => line.length))).toBeLessThanOrEqual(255);
  });

  it('names the module refusal by its exception', () => {
    const print = parseDdifPrint('STEP~#~delete~#~5~#~0~#~E2~#~071~#~still used', deleteDdicSnippet(table).exceptions);
    expect(print.steps[0].exception).toBe('DIALOG_NEEDED');
  });
});
