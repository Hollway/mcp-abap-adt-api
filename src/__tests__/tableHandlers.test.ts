import { TableHandlers } from '../handlers/TableHandlers';

/**
 * The three table tools put several dictionary reads together, and what these
 * tests hold in place is the seam: that an include is expanded by asking for
 * the next level rather than being dropped, that a view is answered with what
 * it is instead of an empty field list, and that the counts reported are the
 * counts before any filtering.
 */
const HEADER = [{ TABNAME: 'EKPO', TABCLASS: 'TRANSP', CONTFLAG: 'A', MAINFLAG: 'X' }];
const HEADER_TEXT = [{ TABNAME: 'EKPO', DDLANGUAGE: 'R', DDTEXT: 'Позиция закупки' }];

const row = (over: Record<string, unknown>) => ({
  TABNAME: 'EKPO',
  FIELDNAME: 'X',
  POSITION: 1,
  KEYFLAG: '',
  ROLLNAME: '',
  DOMNAME: '',
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

const EKPO_FIELDS = [
  row({ FIELDNAME: 'EBELN', POSITION: 1, KEYFLAG: 'X', ROLLNAME: 'EBELN', DOMNAME: 'EBELN' }),
  row({ FIELDNAME: '.INCLUDE', POSITION: 2, PRECFIELD: 'EKPODATA', COMPTYPE: 'S' }),
  row({ FIELDNAME: 'LOEKZ', POSITION: 3, ROLLNAME: 'ELOEKZ' })
];

const EKPODATA_FIELDS = [
  row({ TABNAME: 'EKPODATA', FIELDNAME: 'WERKS', POSITION: 1, ROLLNAME: 'WERKS_D', DOMNAME: 'WERKS' }),
  row({ TABNAME: 'EKPODATA', FIELDNAME: 'MENGE', POSITION: 2, ROLLNAME: 'BSTMG', DATATYPE: 'QUAN', LENG: 13, DECIMALS: 3, REFTABLE: 'EKPO', REFFIELD: 'MEINS' })
];

const handler = (over: { fields?: Record<string, unknown[]>; header?: unknown[] } = {}) => {
  const queries: string[] = [];
  const fields: Record<string, unknown[]> = over.fields ?? {
    EKPO: EKPO_FIELDS,
    EKPODATA: EKPODATA_FIELDS
  };

  const client = {
    stateful: 'stateless',
    runQuery: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM dd02l')) return { values: over.header ?? HEADER };
      if (sql.includes('FROM dd02t')) return { values: HEADER_TEXT };
      if (sql.includes('FROM dd03l')) {
        const asked = [...sql.matchAll(/'([A-Z0-9_/]+)'/g)].map(match => match[1]);
        return { values: asked.flatMap(name => fields[name] ?? []) };
      }
      if (sql.includes('FROM dd04t')) {
        return {
          values: [
            { ROLLNAME: 'WERKS_D', DDLANGUAGE: 'R', DDTEXT: 'Завод' },
            { ROLLNAME: 'WERKS_D', DDLANGUAGE: 'E', DDTEXT: 'Plant' },
            { ROLLNAME: 'EBELN', DDLANGUAGE: 'E', DDTEXT: 'Purchasing document' }
          ]
        };
      }
      if (sql.includes('FROM dd01l')) {
        return { values: [{ DOMNAME: 'WERKS', CONVEXIT: 'ALPHA' }] };
      }
      if (sql.includes('FROM dd12l')) {
        return { values: [{ INDEXNAME: 'Z01', DBINDEX: 'EKPO~Z01', UNIQUEFLAG: 'X' }] };
      }
      if (sql.includes('FROM dd17s')) {
        return { values: [{ INDEXNAME: 'Z01', POSITION: 1, FIELDNAME: 'MATNR' }] };
      }
      if (sql.includes('FROM dd08l')) {
        return { values: [{ FIELDNAME: 'WERKS', CHECKTABLE: 'T001W', CARDLEFT: 'C', CARD: 'N', CHECKFLAG: 'X' }] };
      }
      if (sql.includes('FROM dd05s')) {
        return {
          values: [
            { FIELDNAME: 'WERKS', PRIMPOS: 2, FORTABLE: 'EKPO', FORKEY: 'WERKS', FORSTRING: '' },
            { FIELDNAME: 'WERKS', PRIMPOS: 1, FORTABLE: 'EKPO', FORKEY: 'MANDT', FORSTRING: '' }
          ]
        };
      }
      return { values: [] };
    }
  };
  return { handlers: new TableHandlers(client as any), queries };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('tableFields', () => {
  const language = process.env.SAP_LANGUAGE;
  beforeAll(() => { process.env.SAP_LANGUAGE = 'RU'; });
  afterAll(() => {
    if (language === undefined) delete process.env.SAP_LANGUAGE;
    else process.env.SAP_LANGUAGE = language;
  });

  it('takes the conversion exit of a field domain', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO' }));
    expect(result.fields[1]).toMatchObject({ name: 'WERKS', conversionExit: 'ALPHA' });
  });

  it('expands an include and reports the table it belongs to', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'ekpo' }));

    expect(result).toMatchObject({
      status: 'success',
      name: 'EKPO',
      tableClass: 'transparent table',
      description: 'Позиция закупки',
      deliveryClass: 'application table',
      maintenanceAllowed: true,
      fieldCount: 4,
      keyCount: 1,
      includes: ['EKPODATA']
    });
    expect(result.fields.map((field: any) => field.name)).toEqual(['EBELN', 'WERKS', 'MENGE', 'LOEKZ']);
    expect(result.fields[1]).toMatchObject({
      name: 'WERKS',
      fromInclude: 'EKPODATA',
      // in the connection language
      text: 'Завод'
    });
    // The value table of the domain is deliberately not reported as a check
    // table: it is not one, and the field here declares none.
    expect(result.fields[1].checkTable).toBeUndefined();
    expect(result.fields[2]).toMatchObject({ reference: 'EKPO-MEINS', decimals: 3 });
  });

  it('asks for one level of includes per query rather than one structure per query', async () => {
    const { queries } = handler();
    const { handlers } = handler();
    await handlers.handleTableFields({ name: 'EKPO' });
    expect(queries.filter(sql => sql.includes('FROM dd03l'))).toHaveLength(0);

    const second = handler();
    await second.handlers.handleTableFields({ name: 'EKPO' });
    const fieldQueries = second.queries.filter(sql => sql.includes('FROM dd03l'));
    expect(fieldQueries).toHaveLength(2);
    expect(fieldQueries[0]).toContain("IN ('EKPO')");
    expect(fieldQueries[1]).toContain("IN ('EKPODATA')");
  });

  it('lists the include markers instead of expanding them when asked', async () => {
    const { handlers, queries } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO', expandIncludes: false }));
    expect(result.fields.map((field: any) => field.name)).toEqual(['EBELN', 'LOEKZ']);
    expect(result.expanded).toBe(false);
    expect(result.includeMarkers).toEqual([{ position: 2, structure: 'EKPODATA', marker: '.INCLUDE' }]);
    expect(queries.filter(sql => sql.includes('FROM dd03l'))).toHaveLength(1);
  });

  it('does not call an include unread when nobody asked for it to be read', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO', expandIncludes: false }));
    expect(result.includesNotRead).toBeUndefined();
    expect(result.includes).toBeUndefined();
  });

  it('skips the texts when they are not wanted', async () => {
    const { handlers, queries } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO', withTexts: false }));
    expect(queries.some(sql => sql.includes('FROM dd04t'))).toBe(false);
    expect(result.fields[0].text).toBeUndefined();
  });

  it('keeps the full count when a filter narrows the list', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO', fields: 'we' }));
    expect(result.fieldCount).toBe(4);
    expect(result.fieldsSelected).toBe(1);
    expect(result.fields.map((field: any) => field.name)).toEqual(['WERKS']);
  });

  it('keeps only the key fields when asked', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO', keysOnly: true }));
    expect(result.fields.map((field: any) => field.name)).toEqual(['EBELN']);
  });

  it('cuts a long list and says how to see more', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableFields({ name: 'EKPO', maxFields: 2 }));
    expect(result.fields).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('raise maxFields');
  });

  it('says what a view is instead of answering no fields', async () => {
    const { handlers } = handler({
      header: [{ TABNAME: 'EKPO', TABCLASS: 'VIEW', CONTFLAG: 'A' }],
      fields: {}
    });
    const result = answer(await handlers.handleTableFields({ name: 'EKPO' }));
    expect(result).toMatchObject({ status: 'error', tableClass: 'database view' });
    expect(result.error).toContain('keeps no fields');
  });

  it('says a name it cannot find is not a table here', async () => {
    const { handlers } = handler({ header: [], fields: {} });
    const result = answer(await handlers.handleTableFields({ name: 'ZNOT_THERE' }));
    expect(result).toMatchObject({ status: 'error' });
    expect(result.error).toContain('not a table or structure');
  });

  it('reports an include it could not read rather than losing it quietly', async () => {
    const { handlers } = handler({ fields: { EKPO: EKPO_FIELDS } });
    const result = answer(await handlers.handleTableFields({ name: 'EKPO' }));
    expect(result.includesNotRead).toEqual(['EKPODATA']);
    expect(result.fields.map((field: any) => field.name)).toEqual(['EBELN', 'LOEKZ']);
  });

  it('refuses a name that is not one before it reaches SQL', async () => {
    const { handlers, queries } = handler();
    await expect(handlers.handleTableFields({ name: "EKPO' OR '1'='1" })).rejects.toThrow(/not a valid/);
    await expect(handlers.handleTableFields({})).rejects.toThrow(/Pass name/);
    expect(queries).toHaveLength(0);
  });
});

describe('tableIndexes', () => {
  it('answers each index with its fields in order', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableIndexes({ name: 'EKPO' }));
    expect(result).toMatchObject({ status: 'success', name: 'EKPO', indexCount: 1 });
    expect(result.indexes[0]).toEqual({ name: 'Z01', dbName: 'EKPO~Z01', unique: true, fields: ['MATNR'] });
  });

  it('says the primary key is still indexed when there is no secondary one', async () => {
    const client = { stateful: 'stateless', runQuery: async () => ({ values: [] }) };
    const handlers = new TableHandlers(client as any);
    const result = answer(await handlers.handleTableIndexes({ name: 'EKPO' }));
    expect(result.indexCount).toBe(0);
    expect(result.hint).toContain('primary key');
  });
});

describe('tableKeys', () => {
  it('answers each foreign key with the fields it joins on', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTableKeys({ name: 'EKPO' }));
    expect(result).toMatchObject({ status: 'success', keyCount: 1 });
    expect(result.foreignKeys[0]).toMatchObject({
      field: 'WERKS',
      checkTable: 'T001W',
      cardinality: 'C:N',
      checked: true,
      keyFields: ['EKPO-MANDT', 'EKPO-WERKS']
    });
  });

  it('says a check table can exist without a foreign key', async () => {
    const client = { stateful: 'stateless', runQuery: async () => ({ values: [] }) };
    const handlers = new TableHandlers(client as any);
    const result = answer(await handlers.handleTableKeys({ name: 'EKPO' }));
    expect(result.keyCount).toBe(0);
    expect(result.hint).toContain('checkTable');
  });
});
