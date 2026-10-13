import {
  changeTableSnippet,
  checkFieldList,
  columnProbeLines,
  createTableSnippet,
  parseColumns,
  planFieldChange,
  previewToken,
  rowCountLines,
  tableFields
} from '../lib/tableDdif';
import type { CurrentField, TableContext } from '../lib/tableDdif';
import { DdifError } from '../lib/ddifWrite';

/**
 * Tables are where a mistake costs the most, so the measured behaviour the
 * tools depend on is held here:
 *
 *  - DDIF_TABL_PUT drops foreign keys and search help assignments that are not
 *    passed back to it, so the change snippet carries them from the GET;
 *  - a failed activation leaves an inactive version; writing back the
 *    definition read before and activating it restores the table;
 *  - a column probe needs set_param and next( ), or it lies either way;
 *  - no line of generated ABAP may pass 255 characters.
 */
const context = (overrides: Partial<TableContext> = {}): TableContext => ({
  foreignKeyFields: new Set(),
  indexFields: new Set(),
  searchHelpFields: new Set(),
  checkTableOf: [],
  ...overrides
});

const current: CurrentField[] = [
  { name: 'MANDT', key: true, dataElement: 'MANDT' },
  { name: 'BOT_NAME', key: true, dataElement: 'ZBOT_NAME' },
  { name: 'TOKEN', key: false, dataElement: 'ZTOKEN' },
  { name: 'ACTIVE', key: false, dataElement: 'XFELD' }
];

const longest = (code: string[]) => Math.max(...code.map(line => line.length));

describe('tableFields', () => {
  it('puts MANDT in front of a client-dependent table', () => {
    const fields = tableFields([{ name: 'id', dataElement: 'char10', key: true }], true);
    expect(fields.map(field => field.name)).toEqual(['MANDT', 'ID']);
    expect(fields[0]).toEqual({ name: 'MANDT', dataElement: 'MANDT', key: true });
  });

  it('refuses MANDT anywhere but first, and in a client-independent table', () => {
    expect(() => tableFields([{ name: 'ID', dataElement: 'X', key: true }, { name: 'MANDT', dataElement: 'MANDT', key: true }], true))
      .toThrow(/first field/);
    expect(() => tableFields([{ name: 'MANDT', dataElement: 'MANDT', key: true }, { name: 'ID', dataElement: 'X', key: true }], false))
      .toThrow(/client-independent/);
  });

  it('refuses names longer than 16 characters', () => {
    expect(() => tableFields([{ name: 'A_FIELD_NAME_TOO_LONG', dataElement: 'X', key: true }], false)).toThrow(/16/);
  });
});

describe('checkFieldList', () => {
  it('wants the keys first and together, with one besides MANDT', () => {
    expect(() => checkFieldList([{ name: 'A' }, { name: 'B', key: true }])).toThrow(/at least one key/);
    expect(() => checkFieldList([{ name: 'A', key: true }, { name: 'B' }, { name: 'C', key: true }])).toThrow(/comes after/);
    expect(() => checkFieldList([{ name: 'MANDT', key: true }, { name: 'B' }])).toThrow(/besides MANDT/);
    expect(() => checkFieldList([{ name: 'A', key: true }, { name: 'A' }])).toThrow(/twice/);
  });
});

describe('createTableSnippet', () => {
  const spec = {
    name: 'zapp_log',
    description: 'Log',
    packageName: '$TMP',
    fields: [{ name: 'id', dataElement: 'char10', key: true }, { name: 'text', dataElement: 'as4text' }]
  };

  it('defaults to a plain client-dependent application table', () => {
    const text = createTableSnippet(spec).code.join('\n');
    expect(text).toContain("ls_dd02v-tabclass = 'TRANSP'.");
    expect(text).toContain("ls_dd02v-contflag = 'A'.");
    expect(text).toContain("ls_dd02v-mainflag = 'X'.");
    expect(text).toContain("ls_dd02v-clidep = 'X'.");
    expect(text).toContain("ls_dd02v-exclass = '1'.");
    expect(text).toContain("ls_dd09v-tabart = 'APPL2'.");
    expect(text).toContain("ls_dd09v-tabkat = '0'.");
    expect(text).toContain("ls_dd09v-bufallow = 'N'.");
  });

  it('registers, writes, activates and then proves every column', () => {
    const { code, fields } = createTableSnippet(spec);
    const text = code.join('\n');
    expect(fields.map(field => field.name)).toEqual(['MANDT', 'ID', 'TEXT']);
    expect(text.indexOf("'RS_CORR_INSERT'")).toBeLessThan(text.indexOf("'DDIF_TABL_PUT'"));
    expect(text.indexOf("'DDIF_TABL_PUT'")).toBeLessThan(text.indexOf("'DDIF_TABL_ACTIVATE'"));
    for (const field of ['MANDT', 'ID', 'TEXT']) {
      expect(text).toContain(`SELECT "${field}" FROM "ZAPP_LOG" WHERE 1 = 0`);
    }
    expect(text).toContain("keyflag = 'X' notnull = 'X'");
  });

  it('keeps every line under 255 characters', () => {
    const fields = Array.from({ length: 40 }, (_, index) => ({
      name: `FIELD_${String(index).padStart(10, '0')}`,
      dataElement: 'Z'.repeat(30),
      key: index === 0
    }));
    expect(longest(createTableSnippet({ ...spec, fields, description: 'x'.repeat(60) }).code)).toBeLessThanOrEqual(255);
  });

  it('refuses settings that do not exist', () => {
    expect(() => createTableSnippet({ ...spec, deliveryClass: 'Q' })).toThrow(DdifError);
    expect(() => createTableSnippet({ ...spec, buffering: 'full' })).toThrow(/buffering/);
    expect(() => createTableSnippet({ ...spec, dataClass: 'APPL9' })).toThrow(/dataClass/);
    expect(() => createTableSnippet({ ...spec, sizeCategory: 12 })).toThrow(/sizeCategory/);
  });
});

describe('planFieldChange', () => {
  it('appends a non-key field at the end by default, and after a field when told', () => {
    const atEnd = planFieldChange(current, { add: [{ name: 'note', dataElement: 'as4text' }] }, context());
    expect(atEnd.fields.map(field => field.name)).toEqual(['MANDT', 'BOT_NAME', 'TOKEN', 'ACTIVE', 'NOTE']);
    expect(atEnd.requiresEmpty).toBe(false);
    const after = planFieldChange(current, { add: [{ name: 'note', dataElement: 'as4text', after: 'token' }] }, context());
    expect(after.fields.map(field => field.name)).toEqual(['MANDT', 'BOT_NAME', 'TOKEN', 'NOTE', 'ACTIVE']);
    const afterKey = planFieldChange(current, { add: [{ name: 'note', dataElement: 'as4text', afterKey: true }] }, context());
    expect(afterKey.fields[2].name).toBe('NOTE');
  });

  it('needs an empty table for a key field or a removal', () => {
    const key = planFieldChange(current, { add: [{ name: 'chat', dataElement: 'zchat', key: true }] }, context());
    expect(key.fields.map(field => field.name)).toEqual(['MANDT', 'BOT_NAME', 'CHAT', 'TOKEN', 'ACTIVE']);
    expect(key.requiresEmpty).toBe(true);
    const removal = planFieldChange(current, { remove: ['active'] }, context());
    expect(removal.removed).toEqual(['ACTIVE']);
    expect(removal.emptyBecause).toEqual(['removing ACTIVE']);
  });

  it('keeps the key together', () => {
    expect(() => planFieldChange(current, { add: [{ name: 'X', dataElement: 'Y', key: true, after: 'TOKEN' }] }, context()))
      .toThrow(/within the key/);
    expect(() => planFieldChange(current, { add: [{ name: 'X', dataElement: 'Y', after: 'MANDT' }] }, context()))
      .toThrow(/between key fields/);
  });

  it('refuses what would break something else', () => {
    expect(() => planFieldChange(current, { remove: ['MANDT'] }, context())).toThrow(/client field/);
    expect(() => planFieldChange(current, { remove: ['TOKEN'] }, context({ foreignKeyFields: new Set(['TOKEN']) })))
      .toThrow(/foreign key/);
    expect(() => planFieldChange(current, { remove: ['TOKEN'] }, context({ indexFields: new Set(['TOKEN']) })))
      .toThrow(/index/);
    expect(() => planFieldChange(current, { remove: ['TOKEN'] }, context({ searchHelpFields: new Set(['TOKEN']) })))
      .toThrow(/search help/);
    expect(() => planFieldChange(current, { remove: ['BOT_NAME'] }, context({ checkTableOf: ['ZOTHER'] })))
      .toThrow(/check table/);
    expect(() => planFieldChange(current, { remove: ['NOPE'] }, context())).toThrow(/no field NOPE/);
    expect(() => planFieldChange(current, { add: [{ name: 'TOKEN', dataElement: 'X' }] }, context())).toThrow(/already has/);
    expect(() => planFieldChange(current, {}, context())).toThrow(/nothing to change/);
    expect(() => planFieldChange([...current, { name: '.INCLUDE', key: false, dataElement: 'ZSTRUC' }], { remove: ['ACTIVE'] }, context()))
      .toThrow(/INCLUDE/);
    expect(() => planFieldChange(current, { remove: ['BOT_NAME'] }, context())).toThrow(/besides MANDT/);
  });
});

describe('previewToken', () => {
  const change = { add: [{ name: 'note', dataElement: 'as4text' }] };

  it('is stable for the same table and change, case-insensitive in the names', () => {
    expect(previewToken('ZT', 's', current, change))
      .toBe(previewToken('ZT', 's', current, { add: [{ name: 'NOTE', dataElement: 'AS4TEXT' }] }));
  });

  it('changes with the table or with the change', () => {
    const base = previewToken('ZT', 's', current, change);
    expect(previewToken('ZT', 's2', current, change)).not.toBe(base);
    expect(previewToken('ZT', 's', current.slice(0, 3), change)).not.toBe(base);
    expect(previewToken('ZT', 's', current, { add: [{ name: 'note', dataElement: 'as4text', afterKey: true }] })).not.toBe(base);
    expect(previewToken('ZT', 's', current, { remove: ['ACTIVE'] })).not.toBe(base);
  });
});

describe('changeTableSnippet', () => {
  const plan = planFieldChange(current, { add: [{ name: 'note', dataElement: 'as4text', after: 'TOKEN' }], remove: ['ACTIVE'] }, context());
  const { code } = changeTableSnippet({
    name: 'ZT',
    packageName: 'ZPKG',
    request: 'DEVK900100',
    expected: current.map(field => field.name),
    plan
  });
  const text = code.join('\n');

  it('passes the foreign keys and search help assignments back - left out, they are deleted', () => {
    expect(text).toContain('dd05m_tab = lt_dd05m dd08v_tab = lt_dd08v');
    expect(text).toContain('dd35v_tab = lt_dd35v dd36m_tab = lt_dd36m');
    const put = text.indexOf("'DDIF_TABL_PUT'");
    expect(text.slice(put, put + 400)).toContain('dd05m_tab = lt_dd05m');
  });

  it('stops when the table is not what the preview saw', () => {
    expect(text).toContain('lv_expected = `MANDT,BOT_NAME,TOKEN,ACTIVE,`.');
    expect(text).toContain("IF lv_names <> lv_expected OR ls_dd02v-tabclass <> 'TRANSP'.");
  });

  it('counts the rows of every client before a change that needs an empty table', () => {
    expect(text).toContain('SELECT COUNT(*) FROM "ZT"');
    expect(text).toContain('IF lv_rows <> 0.');
    expect(text.indexOf('IF lv_rows <> 0.')).toBeLessThan(text.indexOf("'DDIF_TABL_PUT'"));
  });

  it('builds the new list from the rows read, plus the new field, renumbered', () => {
    expect(text).toContain("APPEND lt_old[ fieldname = 'TOKEN' ] TO lt_new.");
    expect(text).not.toContain("fieldname = 'ACTIVE' ] TO lt_new");
    expect(text).toContain("fieldname = 'NOTE'");
    expect(text.indexOf("fieldname = 'TOKEN' ]")).toBeLessThan(text.indexOf("fieldname = 'NOTE'"));
    expect(text).toContain("<ls_position>-position = |{ sy-tabix WIDTH = 4 ALIGN = RIGHT PAD = '0' }|.");
  });

  it('writes the old definition back and activates it when the activation fails', () => {
    const failure = text.indexOf('IF lv_subrc <> 0 OR lv_rc > 4.\nCLEAR lv_rc.');
    expect(failure).toBeGreaterThan(text.indexOf("'DDIF_TABL_ACTIVATE'"));
    const rollback = text.slice(failure);
    expect(rollback).toContain('TABLES dd03p_tab = lt_old');
    expect(rollback).toContain('rollback_activate');
  });

  it('checks the added and the removed column in the database', () => {
    expect(text).toContain('SELECT "NOTE" FROM "ZT" WHERE 1 = 0');
    expect(text).toContain('SELECT "ACTIVE" FROM "ZT" WHERE 1 = 0');
  });

  it('keeps every line under 255 characters, even for a wide table', () => {
    const wide: CurrentField[] = [
      { name: 'MANDT', key: true, dataElement: 'MANDT' },
      ...Array.from({ length: 60 }, (_, index) => ({ name: `FIELD_${String(index).padStart(10, '0')}`, key: index === 0, dataElement: 'X' }))
    ];
    const widePlan = planFieldChange(wide, { add: [{ name: 'NEW', dataElement: 'Z'.repeat(30) }] }, context());
    const wideCode = changeTableSnippet({ name: 'ZT', packageName: '$TMP', expected: wide.map(field => field.name), plan: widePlan }).code;
    expect(longest(wideCode)).toBeLessThanOrEqual(255);
  });
});

describe('probes', () => {
  it('bind the result and fetch it - without that a probe lies either way', () => {
    const text = columnProbeLines('ZT', ['F1']).join('\n');
    expect(text).toContain('set_param( REF #( lv_probe ) )');
    expect(text).toContain('lo_probe->next( )');
    expect(rowCountLines('ZT').join('\n')).toContain('set_param( REF #( lv_rows ) )');
  });

  it('read back as present or absent, with the database message', () => {
    expect(parseColumns('COLUMN~#~F1~#~1~#~\nCOLUMN~#~NOPE~#~0~#~ORA-00904: "NOPE": invalid identifier')).toEqual({
      F1: { present: true },
      NOPE: { present: false, message: 'ORA-00904: "NOPE": invalid identifier' }
    });
  });
});
