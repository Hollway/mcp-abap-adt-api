import { QueryHandlers } from '../handlers/QueryHandlers';

/**
 * The data preview endpoint takes its row cap from the rowNumber query
 * parameter and ignores an UP TO n ROWS written into the SQL text - measured
 * live, where a SELECT ... UP TO 3 ROWS answered with a hundred rows. These
 * tests hold the consequence in place: the limit the caller asked for is the
 * limit that travels, wherever they wrote it, and the answer says which cap
 * applied and whether it cut the result short.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ BUKRS: `${1000 + index}` }));

const handler = (available = 100) => {
  const asked: { sql: string; rowNumber: number }[] = [];
  const client = {
    stateful: 'stateless',
    runQuery: async (sql: string, rowNumber: number) => {
      asked.push({ sql, rowNumber });
      return { columns: [{ name: 'BUKRS' }], values: rowsOf(Math.min(available, rowNumber)) };
    },
    tableContents: async (name: string, rowNumber: number) => {
      asked.push({ sql: name, rowNumber });
      return { columns: [{ name: 'BUKRS' }], values: rowsOf(Math.min(available, rowNumber)) };
    }
  };
  return { handlers: new QueryHandlers(client as any), asked };
};

describe('runQuery row limits', () => {
  it('sends rowNumber as the cap when it is given', async () => {
    const { handlers, asked } = handler();
    const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT bukrs FROM t001', rowNumber: 3 }));
    expect(asked[0].rowNumber).toBe(3);
    expect(result.rows).toMatchObject({ returned: 3, limit: 3, limitedBy: 'rowNumber' });
  });

  it('applies an UP TO n ROWS the backend would have ignored', async () => {
    const { handlers, asked } = handler();
    const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT bukrs FROM t001 UP TO 5 ROWS' }));
    expect(asked[0].rowNumber).toBe(5);
    expect(result.rows).toMatchObject({ limit: 5, limitedBy: 'upToRows', returned: 5 });
    expect(result.rows.hint).toContain('ignores UP TO 5 ROWS');
  });

  it('says so when rowNumber and the text disagree, because the text loses', async () => {
    const { handlers, asked } = handler();
    const result = answer(await handlers.handleRunQuery({
      sqlQuery: 'SELECT bukrs FROM t001 UP TO 50 ROWS',
      rowNumber: 2
    }));
    expect(asked[0].rowNumber).toBe(2);
    expect(result.rows).toMatchObject({ limit: 2, limitedBy: 'rowNumber', upToRowsIgnored: 50 });
  });

  it('falls back to the hundred rows the library asks for', async () => {
    const { handlers, asked } = handler(400);
    const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT bukrs FROM t001' }));
    expect(asked[0].rowNumber).toBe(100);
    expect(result.rows).toMatchObject({ limit: 100, limitedBy: 'default', more: true });
    expect(result.rows.hint).toContain('more rows');
  });

  it('reports no more rows when the result stopped short of the cap', async () => {
    const { handlers } = handler(4);
    const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT bukrs FROM t001', rowNumber: 10 }));
    expect(result.rows).toMatchObject({ returned: 4, limit: 10 });
    expect(result.rows.more).toBeUndefined();
  });

  it('fetches past the offset so the window is the size that was asked for', async () => {
    const { handlers, asked } = handler(400);
    const result = answer(await handlers.handleRunQuery({
      sqlQuery: 'SELECT bukrs FROM t001',
      rowNumber: 5,
      offset: 10
    }));
    expect(asked[0].rowNumber).toBe(15);
    expect(result.window).toMatchObject({ offset: 10, returned: 5, fetched: 15 });
    expect(result.rows).toMatchObject({ returned: 5, limit: 5 });
  });

  it('ignores an UP TO nothing can be read out of', async () => {
    const { handlers, asked } = handler();
    const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT bukrs FROM t001 UP TO 0 ROWS' }));
    expect(asked[0].rowNumber).toBe(100);
    expect(result.rows.limitedBy).toBe('default');
  });
});

describe('tableContents row limits', () => {
  it('caps by rowNumber and reports it the same way', async () => {
    const { handlers, asked } = handler(400);
    const result = answer(await handlers.handleTableContents({ ddicEntityName: 'T001', rowNumber: 7 }));
    expect(asked[0].rowNumber).toBe(7);
    expect(result.rows).toMatchObject({ returned: 7, limit: 7, limitedBy: 'rowNumber', more: true });
  });
});
