import { compactResult, isBlank, rowFormatOf } from '../lib/compactRows';
import { QueryHandlers } from '../handlers/QueryHandlers';

/**
 * The compact layout of a data preview answer: columns once, rows as arrays,
 * and the columns nothing is in named rather than repeated. Nothing may be
 * lost on the way - every value that is not blank or zero stays, in the
 * column order the columns list gives.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const column = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'C',
  description: `${name} text`,
  keyAttribute: false,
  colType: '',
  isKeyFigure: false,
  length: 10,
  ...extra
});

const ekpoLike = () => ({
  columns: [column('EBELN'), column('LOEKZ', { length: 1 }), column('MENGE', { type: 'P', length: 13 }), column('AEDAT', { length: 8 })],
  values: [
    { EBELN: '4500000001', LOEKZ: '', MENGE: 0, AEDAT: '20260101' },
    { EBELN: '4500000002', LOEKZ: ' ', MENGE: 0, AEDAT: '00000000' }
  ]
});

describe('what counts as blank', () => {
  it.each([null, undefined, '', '   ', 0, '0', '0.00', '00000000', '00:00:00', '0000-00-00'])('%p is blank', value => {
    expect(isBlank(value)).toBe(true);
  });

  it.each(['X', 1, -1, '0001', '4500000001', 'A0', false, true])('%p is not', value => {
    expect(isBlank(value)).toBe(false);
  });
});

describe('compactResult', () => {
  it('describes each column once and writes each row as an array in that order', () => {
    const result = compactResult(ekpoLike());
    expect(result.format).toBe('compact');
    expect(result.columnFormat).toEqual(['name', 'type', 'length', 'description']);
    expect(result.columns).toEqual([
      ['EBELN', 'C', 10, 'EBELN text'],
      ['AEDAT', 'C', 8, 'AEDAT text']
    ]);
    expect(result.values).toEqual([
      ['4500000001', '20260101'],
      ['4500000002', '00000000']
    ]);
  });

  it('names the columns that are blank or zero in every row instead of repeating them', () => {
    expect(compactResult(ekpoLike()).emptyColumns).toEqual(['LOEKZ', 'MENGE']);
  });

  it('keeps a column that is blank in some rows only', () => {
    const result = compactResult(ekpoLike());
    expect(result.columns.map((c: unknown[]) => c[0])).toContain('AEDAT');
  });

  it('keeps every column when asked to', () => {
    const result = compactResult(ekpoLike(), true);
    expect(result.columns.map((c: unknown[]) => c[0])).toEqual(['EBELN', 'LOEKZ', 'MENGE', 'AEDAT']);
    expect(result.values[0]).toEqual(['4500000001', '', 0, '20260101']);
    expect(result.emptyColumns).toBeUndefined();
  });

  it('calls nothing empty when there are no rows to look at', () => {
    const result = compactResult({ columns: [column('EBELN')], values: [] });
    expect(result.columns).toHaveLength(1);
    expect(result.values).toEqual([]);
    expect(result.emptyColumns).toBeUndefined();
  });

  it('adds the flag fields to the column format only when a column carries one', () => {
    const plain = compactResult(ekpoLike());
    expect(plain.columnFormat).not.toContain('keyAttribute');

    const keyed = compactResult({
      columns: [column('MANDT', { keyAttribute: true }), column('NETWR', { isKeyFigure: true })],
      values: [{ MANDT: '100', NETWR: 5 }]
    });
    expect(keyed.columnFormat).toEqual(['name', 'type', 'length', 'description', 'keyAttribute', 'isKeyFigure']);
    expect(keyed.columns[0]).toEqual(['MANDT', 'C', 10, 'MANDT text', true, false]);
  });

  it('writes a value the row does not carry as null rather than dropping its place', () => {
    const result = compactResult({ columns: [column('A'), column('B')], values: [{ A: 'x' }, { A: 'y', B: 'z' }] });
    expect(result.values).toEqual([['x', null], ['y', 'z']]);
  });

  it('hands back a result that has no columns or values array unchanged', () => {
    const odd = { something: 'else' };
    expect(compactResult(odd)).toBe(odd);
    expect(compactResult(undefined)).toBeUndefined();
  });

  it('reads the format argument, defaulting to compact', () => {
    expect(rowFormatOf({})).toBe('compact');
    expect(rowFormatOf({ format: 'objects' })).toBe('objects');
    expect(rowFormatOf({ format: 'nonsense' })).toBe('compact');
  });
});

describe('the query tools answer compact by default', () => {
  const handlers = () => new QueryHandlers({
    stateful: 'stateless',
    runQuery: async () => ekpoLike(),
    tableContents: async () => ekpoLike()
  } as any);

  it('tableContents', async () => {
    const result = answer(await handlers().handleTableContents({ ddicEntityName: 'EKPO', rowNumber: 2 }));
    expect(result.result.format).toBe('compact');
    expect(result.result.values).toEqual([['4500000001', '20260101'], ['4500000002', '00000000']]);
    expect(result.result.emptyColumns).toEqual(['LOEKZ', 'MENGE']);
    expect(result.rows).toMatchObject({ returned: 2, limit: 2 });
  });

  it('runQuery', async () => {
    const result = answer(await handlers().handleRunQuery({ sqlQuery: 'SELECT * FROM ekpo', rowNumber: 2 }));
    expect(result.result.format).toBe('compact');
    expect(result.result.columns[0]).toEqual(['EBELN', 'C', 10, 'EBELN text']);
  });

  it('gives the endpoint answer as it is when objects is asked for', async () => {
    const result = answer(await handlers().handleTableContents({ ddicEntityName: 'EKPO', rowNumber: 2, format: 'objects' }));
    expect(result.result).toEqual(ekpoLike());
  });

  it('passes keepEmptyColumns through', async () => {
    const result = answer(await handlers().handleRunQuery({ sqlQuery: 'SELECT * FROM ekpo', rowNumber: 2, keepEmptyColumns: true }));
    expect(result.result.columns).toHaveLength(4);
  });

  it('leaves the rows of runQueryCore as objects for the callers inside the server', async () => {
    const payload: any = await handlers().runQueryCore({ sqlQuery: 'SELECT * FROM ekpo', rowNumber: 2 });
    expect(payload.result.values[0]).toEqual({ EBELN: '4500000001', LOEKZ: '', MENGE: 0, AEDAT: '20260101' });
  });
});
