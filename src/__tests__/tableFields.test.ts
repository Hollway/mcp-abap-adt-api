import {
  ddicName,
  fieldsQuery,
  textsQuery,
  headerQuery,
  indexesQuery,
  chunkForQuery,
  groupByStructure,
  flattenFields,
  includesOf,
  textsByElement,
  applyConversionExits,
  pickText,
  languageCode,
  shapeIndexes,
  shapeForeignKeys,
  TableFieldsError
} from '../lib/tableFields';
import type { Row } from '../lib/tableFields';

/** A DD03L row, with the columns runQuery answers in. */
const field = (over: Partial<Record<string, unknown>> = {}): Row => ({
  TABNAME: 'ZAPPSTEP_POS',
  FIELDNAME: 'WERKS',
  POSITION: 1,
  KEYFLAG: '',
  ROLLNAME: 'WERKS_D',
  DOMNAME: 'WERKS',
  DATATYPE: 'CHAR',
  LENG: 4,
  DECIMALS: 0,
  NOTNULL: '',
  CHECKTABLE: '',
  REFTABLE: '',
  REFFIELD: '',
  PRECFIELD: '',
  COMPTYPE: 'E',
  ...over
});

const include = (structure: string, position: number, marker = '.INCLUDE'): Row =>
  field({ FIELDNAME: marker, POSITION: position, PRECFIELD: structure, COMPTYPE: 'S', ROLLNAME: '', DOMNAME: '' });

describe('ddicName', () => {
  it('accepts a table name and a namespaced one', () => {
    expect(ddicName('ekpo')).toBe('EKPO');
    expect(ddicName('/SPE/TPOP_CRM_DATA')).toBe('/SPE/TPOP_CRM_DATA');
  });

  it('refuses anything that could carry SQL', () => {
    expect(() => ddicName("EKPO' OR '1'='1")).toThrow(TableFieldsError);
    expect(() => ddicName('')).toThrow(TableFieldsError);
    expect(() => ddicName('A'.repeat(31))).toThrow(TableFieldsError);
  });
});

describe('the queries', () => {
  it('puts spaces around a comparison, which the parser insists on', () => {
    // tabname='EKPO' is refused with "a Boolean expression is required in
    // positions starting with TABNAME=".
    expect(headerQuery('EKPO')).toContain("tabname = 'EKPO'");
    expect(indexesQuery('EKPO')).toContain("sqltab = 'EKPO'");
    expect(fieldsQuery(['EKPO'])).toContain("as4local = 'A'");
  });

  it('reads the active version only', () => {
    const sql = fieldsQuery(['EKPO']);
    expect(sql).toContain("tabname IN ('EKPO')");
    expect(sql).toContain("as4local = 'A'");
  });

  it('asks for several structures in one statement', () => {
    expect(fieldsQuery(['EKPO', 'EKPODATA'])).toContain("IN ('EKPO','EKPODATA')");
  });

  it('reads every language of a text and filters none, because the pick is made here', () => {
    const sql = textsQuery(['WERKS_D']);
    expect(sql).toContain('ddlanguage');
    expect(sql).not.toContain("ddlanguage =");
  });

  it('refuses a name that is not one, before it reaches SQL', () => {
    expect(() => fieldsQuery(["EKPO'; DROP TABLE"])).toThrow(TableFieldsError);
    expect(() => headerQuery('x y')).toThrow(TableFieldsError);
    expect(() => indexesQuery('-')).toThrow(TableFieldsError);
  });
});

describe('chunkForQuery', () => {
  const build = (names: string[]) => `SELECT * FROM t WHERE n IN (${names.map(n => `'${n}'`).join(',')})`;

  it('fits as many names into a statement as the limit allows', () => {
    // The fixed part is 28 characters, so a limit of 45 leaves room for two
    // names of four characters and their quotes and comma.
    expect(chunkForQuery(['AAAA', 'BBBB', 'CCCC'], build, 45)).toEqual([['AAAA', 'BBBB'], ['CCCC']]);
  });

  it('keeps everything in one query when it fits', () => {
    expect(chunkForQuery(['A', 'B'], build)).toEqual([['A', 'B']]);
    expect(chunkForQuery([], build)).toEqual([]);
  });

  it('still sends a single name whose query is over the limit', () => {
    // Better a refusal that names the limit than a name quietly dropped.
    expect(chunkForQuery(['A'], build, 5)).toEqual([['A']]);
  });

  it('keeps every real query under the limit for a long name list', () => {
    const names = Array.from({ length: 40 }, (_, at) => `ZSTRUCTURE_WITH_A_LONG_NAME_${at}`.slice(0, 30));
    for (const part of chunkForQuery(names, fieldsQuery)) {
      expect(fieldsQuery(part).length).toBeLessThanOrEqual(255);
    }
  });
});

describe('the statement length', () => {
  it('keeps every query under the limit the data preview endpoint enforces', () => {
    // It refuses anything longer with "maximum number of characters in the
    // line exceeds 255", counting the whole statement.
    expect(fieldsQuery(['EKPO']).length).toBeLessThanOrEqual(255);
    expect(headerQuery('ZAPPSTEP_POS').length).toBeLessThanOrEqual(255);
    expect(indexesQuery('EKPO').length).toBeLessThanOrEqual(255);
    expect(textsQuery(['WERKS_D', 'MATNR']).length).toBeLessThanOrEqual(255);
  });

  it('leaves out an ORDER BY that can be done after the fact', () => {
    expect(fieldsQuery(['EKPO'])).not.toContain('ORDER BY');
  });
});

describe('groupByStructure', () => {
  it('groups rows by their table and sorts each by position', () => {
    const grouped = groupByStructure([
      field({ TABNAME: 'A', FIELDNAME: 'SECOND', POSITION: 2 }),
      field({ TABNAME: 'B', FIELDNAME: 'ONLY', POSITION: 1 }),
      field({ TABNAME: 'A', FIELDNAME: 'FIRST', POSITION: 1 })
    ]);
    expect([...grouped.keys()]).toEqual(['A', 'B']);
    expect(grouped.get('A')!.map(row => row.FIELDNAME)).toEqual(['FIRST', 'SECOND']);
  });
});

describe('includesOf', () => {
  it('lists the include markers with what they bring', () => {
    expect(includesOf([
      field({ FIELDNAME: 'MANDT', POSITION: 1 }),
      include('EKPODATA', 2),
      include('/BEV1/NE_EKPODATA_A', 3, '.INCLU--AP')
    ])).toEqual([
      { position: 2, structure: 'EKPODATA', marker: '.INCLUDE' },
      { position: 3, structure: '/BEV1/NE_EKPODATA_A', marker: '.INCLU--AP' }
    ]);
  });
});

describe('flattenFields', () => {
  it('reads a plain table into fields with the flags it has', () => {
    const byStructure = groupByStructure([
      field({ FIELDNAME: 'MANDT', POSITION: 1, KEYFLAG: 'X', NOTNULL: 'X', ROLLNAME: 'MANDT', DOMNAME: 'MANDT', DATATYPE: 'CLNT', LENG: 3 }),
      field({ FIELDNAME: 'MENGE', POSITION: 2, ROLLNAME: 'MENGE_D', DATATYPE: 'QUAN', LENG: 13, DECIMALS: 3, REFTABLE: 'ZAPPSTEP_POS', REFFIELD: 'MEINS' })
    ]);
    const { fields } = flattenFields('ZAPPSTEP_POS', { byStructure });
    expect(fields[0]).toEqual({
      name: 'MANDT', position: 1, key: true, notNull: true,
      dataElement: 'MANDT', domain: 'MANDT', dataType: 'CLNT', length: 3
    });
    expect(fields[1]).toMatchObject({
      name: 'MENGE', position: 2, decimals: 3, reference: 'ZAPPSTEP_POS-MEINS'
    });
  });

  it('splices an include in where it sits and says where each field came from', () => {
    const byStructure = groupByStructure([
      field({ TABNAME: 'EKPO', FIELDNAME: 'EBELN', POSITION: 1, KEYFLAG: 'X' }),
      { ...include('EKPODATA', 2), TABNAME: 'EKPO' },
      field({ TABNAME: 'EKPO', FIELDNAME: 'LAST', POSITION: 3 }),
      field({ TABNAME: 'EKPODATA', FIELDNAME: 'WERKS', POSITION: 1 }),
      field({ TABNAME: 'EKPODATA', FIELDNAME: 'MATNR', POSITION: 2 })
    ]);
    const { fields, includes } = flattenFields('EKPO', { byStructure });
    expect(fields.map(one => one.name)).toEqual(['EBELN', 'WERKS', 'MATNR', 'LAST']);
    expect(fields.map(one => one.position)).toEqual([1, 2, 3, 4]);
    expect(fields[1].fromInclude).toBe('EKPODATA');
    expect(fields[3].fromInclude).toBeUndefined();
    expect(includes).toEqual(['EKPODATA']);
  });

  it('follows an include of an include', () => {
    const byStructure = groupByStructure([
      field({ TABNAME: 'OUTER', FIELDNAME: 'A', POSITION: 1 }),
      { ...include('MIDDLE', 2), TABNAME: 'OUTER' },
      { ...include('INNER', 1), TABNAME: 'MIDDLE' },
      field({ TABNAME: 'INNER', FIELDNAME: 'DEEP', POSITION: 1 })
    ]);
    const { fields, includes } = flattenFields('OUTER', { byStructure });
    expect(fields.map(one => one.name)).toEqual(['A', 'DEEP']);
    expect(fields[1].fromInclude).toBe('INNER');
    expect(includes).toEqual(['MIDDLE', 'INNER']);
  });

  it('reports an include whose fields nobody read rather than dropping it silently', () => {
    const byStructure = groupByStructure([
      field({ TABNAME: 'EKPO', FIELDNAME: 'EBELN', POSITION: 1 }),
      { ...include('NOT_READ', 2), TABNAME: 'EKPO' }
    ]);
    const { fields, missing } = flattenFields('EKPO', { byStructure });
    expect(fields.map(one => one.name)).toEqual(['EBELN']);
    expect(missing).toEqual(['NOT_READ']);
  });

  it('refuses a structure that includes itself', () => {
    const byStructure = groupByStructure([
      { ...include('B', 1), TABNAME: 'A' },
      { ...include('A', 1), TABNAME: 'B' }
    ]);
    expect(() => flattenFields('A', { byStructure })).toThrow(/includes itself/);
  });
});

describe('languageCode', () => {
  it('takes the first letter where that is the SAP code', () => {
    expect(languageCode('RU')).toBe('R');
    expect(languageCode('EN')).toBe('E');
    expect(languageCode('DE')).toBe('D');
  });

  it('knows the ones that differ', () => {
    expect(languageCode('ZH')).toBe('1');
    expect(languageCode('JA')).toBe('J');
    expect(languageCode('SV')).toBe('V');
  });

  it('passes a one character code through and falls back to English', () => {
    expect(languageCode('R')).toBe('R');
    expect(languageCode('')).toBe('E');
    expect(languageCode(undefined)).toBe('E');
  });
});

describe('pickText', () => {
  const rows = [
    { DDLANGUAGE: 'D', DDTEXT: 'Werk' },
    { DDLANGUAGE: 'E', DDTEXT: 'Plant' },
    { DDLANGUAGE: 'R', DDTEXT: 'Завод' }
  ];

  it('takes the connection language when it is there', () => {
    expect(pickText(rows, 'RU')).toMatchObject({ DDTEXT: 'Завод' });
  });

  it('falls back to English, and then to whatever there is', () => {
    expect(pickText(rows, 'FR')).toMatchObject({ DDTEXT: 'Plant' });
    expect(pickText([{ DDLANGUAGE: 'D', DDTEXT: 'Werk' }], 'RU')).toMatchObject({ DDTEXT: 'Werk' });
    expect(pickText([], 'RU')).toBeUndefined();
  });
});

describe('textsByElement', () => {
  it('keeps one text per element, in the best language available', () => {
    const texts = textsByElement([
      { ROLLNAME: 'WERKS_D', DDLANGUAGE: 'E', DDTEXT: 'Plant' },
      { ROLLNAME: 'WERKS_D', DDLANGUAGE: 'R', DDTEXT: 'Завод' },
      { ROLLNAME: 'MATNR', DDLANGUAGE: 'E', DDTEXT: 'Material' }
    ], 'RU');
    expect(texts.get('WERKS_D')).toBe('Завод');
    expect(texts.get('MATNR')).toBe('Material');
  });

  it('falls back to a screen text when the description is empty', () => {
    const texts = textsByElement([
      { ROLLNAME: 'X', DDLANGUAGE: 'E', DDTEXT: '', SCRTEXT_L: 'Long one' }
    ], 'EN');
    expect(texts.get('X')).toBe('Long one');
  });
});

describe('applyConversionExits', () => {
  it('takes the conversion exit from the domain of the field', () => {
    const applied = applyConversionExits(
      [{ name: 'MATNR', position: 1, domain: 'MATNR' }],
      [{ DOMNAME: 'MATNR', CONVEXIT: 'MATN1' }]
    );
    expect(applied[0].conversionExit).toBe('MATN1');
  });

  it('leaves a field whose domain has no exit, or none that was read, alone', () => {
    const fields = [{ name: 'A', position: 1, domain: 'WERKS' }];
    expect(applyConversionExits(fields, [{ DOMNAME: 'WERKS', CONVEXIT: '' }])).toEqual(fields);
    expect(applyConversionExits(fields, [])).toEqual(fields);
  });
});

describe('shapeIndexes', () => {
  it('puts the fields of each index in order', () => {
    const shaped = shapeIndexes(
      [
        { INDEXNAME: '1', DBINDEX: 'EKPO___1', UNIQUEFLAG: '' },
        { INDEXNAME: 'Z01', DBINDEX: 'EKPO~Z01', UNIQUEFLAG: 'X' }
      ],
      [
        { INDEXNAME: '1', POSITION: 2, FIELDNAME: 'MATNR' },
        { INDEXNAME: '1', POSITION: 1, FIELDNAME: 'WERKS' },
        { INDEXNAME: 'Z01', POSITION: 1, FIELDNAME: 'EBELN' },
        { INDEXNAME: 'Z01', POSITION: 2, FIELDNAME: '.INCLUDE' }
      ]
    );
    expect(shaped[0]).toEqual({ name: '1', dbName: 'EKPO___1', fields: ['WERKS', 'MATNR'] });
    expect(shaped[1]).toEqual({ name: 'Z01', dbName: 'EKPO~Z01', unique: true, fields: ['EBELN'] });
  });

  it('reports an index whose fields nobody read as having none', () => {
    expect(shapeIndexes([{ INDEXNAME: 'Z1' }], [])).toEqual([{ name: 'Z1', fields: [] }]);
  });
});

describe('shapeForeignKeys', () => {
  it('reads a key with what fills the key of the check table, in its order', () => {
    const shaped = shapeForeignKeys(
      [{ FIELDNAME: 'STEPIN', CHECKTABLE: 'ZCHECK_POINT', FRKART: '', CARDLEFT: 'C', CARD: 'N', CHECKFLAG: 'X', ARBGB: 'ZAPP', MSGNR: '010' }],
      [
        { FIELDNAME: 'STEPIN', PRIMPOS: 2, FORTABLE: 'ZAPPSTEP_POS', FORKEY: 'STEPIN', FORSTRING: '' },
        { FIELDNAME: 'STEPIN', PRIMPOS: 1, FORTABLE: 'ZAPPSTEP_POS', FORKEY: 'MANDT', FORSTRING: '' }
      ]
    );
    expect(shaped[0]).toEqual({
      field: 'STEPIN',
      checkTable: 'ZCHECK_POINT',
      cardinality: 'C:N',
      checked: true,
      message: 'ZAPP 010',
      keyFields: ['ZAPPSTEP_POS-MANDT', 'ZAPPSTEP_POS-STEPIN']
    });
  });

  it('reads a cardinality of which only one side is filled', () => {
    const shaped = shapeForeignKeys(
      [{ FIELDNAME: 'A', CHECKTABLE: 'T1', CARDLEFT: '', CARD: 'N', CHECKFLAG: 'X' }],
      []
    );
    expect(shaped[0].cardinality).toBe('?:N');
  });

  it('reads a constant where the definition uses one instead of a field', () => {
    const shaped = shapeForeignKeys(
      [{ FIELDNAME: 'A', CHECKTABLE: 'T1', CHECKFLAG: 'X' }],
      [{ FIELDNAME: 'A', PRIMPOS: 1, FORTABLE: '', FORKEY: '', FORSTRING: 'X' }]
    );
    expect(shaped[0].keyFields).toEqual(["'X'"]);
  });

  it('says a key is not enforced rather than leaving the flag out', () => {
    const shaped = shapeForeignKeys([{ FIELDNAME: 'A', CHECKTABLE: 'T1', CHECKFLAG: '' }], []);
    expect(shaped[0]).toMatchObject({ checked: false, keyFields: [] });
  });
});
