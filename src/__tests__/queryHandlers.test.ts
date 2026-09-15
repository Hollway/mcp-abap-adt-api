import { QueryHandlers } from '../handlers/QueryHandlers';

/**
 * Three things the data preview endpoints do that nobody would guess, all
 * measured live, and all of them held in place here:
 *
 *  - the row cap is the rowNumber parameter; an UP TO n ROWS in the query text
 *    is ignored, so a SELECT ... UP TO 3 ROWS answered with a hundred rows;
 *  - the ddic endpoint behind tableContents answers with rowNumber+1 rows,
 *    having fetched one past the cap to see whether more follows, while the
 *    freestyle endpoint behind runQuery answers with exactly rowNumber;
 *  - the filter of tableContents is not a WHERE clause but a whole SELECT, and
 *    a bare condition is rejected outright.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ BUKRS: `${1000 + index}` }));

/**
 * `extra` is what the endpoint hands back beyond the cap: one row for the ddic
 * endpoint, none for freestyle.
 */
const handler = (available = 100, extra = { freestyle: 0, ddic: 1 }) => {
  const asked: { sql?: string; entity?: string; rowNumber: number }[] = [];
  const client = {
    stateful: 'stateless',
    runQuery: async (sql: string, rowNumber: number) => {
      asked.push({ sql, rowNumber });
      return { columns: [{ name: 'BUKRS' }], values: rowsOf(Math.min(available, rowNumber + extra.freestyle)) };
    },
    tableContents: async (entity: string, rowNumber: number, _decode: boolean, sql?: string) => {
      asked.push({ entity, sql, rowNumber });
      return { columns: [{ name: 'BUKRS' }], values: rowsOf(Math.min(available, rowNumber + extra.ddic)) };
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
    expect(result.rows.limitNote).toContain('ignores UP TO 5 ROWS');
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
    expect(result.rows).toMatchObject({ limit: 100, limitedBy: 'default' });
  });

  it('will not claim there is more when the cap was merely filled', async () => {
    const { handlers } = handler(400);
    const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT bukrs FROM t001', rowNumber: 5 }));
    expect(result.rows.more).toBe('unknown');
    expect(result.rows.hint).toContain('filled the cap exactly');
  });

  it('reports nothing about more rows when the result stopped short of the cap', async () => {
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

describe('tableContents', () => {
  it('trims the row the ddic endpoint adds, and spends it on saying there is more', async () => {
    const { handlers, asked } = handler(400);
    const result = answer(await handlers.handleTableContents({ ddicEntityName: 'T001', rowNumber: 4 }));
    expect(asked[0].rowNumber).toBe(4);
    expect(result.result.values).toHaveLength(4);
    expect(result.rows).toMatchObject({ returned: 4, limit: 4, limitedBy: 'rowNumber', more: true });
  });

  it('does not invent a further row when the table ended', async () => {
    const { handlers } = handler(3);
    const result = answer(await handlers.handleTableContents({ ddicEntityName: 'T001', rowNumber: 10 }));
    expect(result.rows).toMatchObject({ returned: 3 });
    expect(result.rows.more).toBeUndefined();
  });

  it('completes a bare condition into the SELECT the endpoint insists on', async () => {
    const { handlers, asked } = handler();
    const result = answer(await handlers.handleTableContents({
      ddicEntityName: 'T001',
      sqlQuery: "BUKRS = '1000'",
      rowNumber: 5
    }));
    expect(asked[0].sql).toBe("SELECT * FROM T001 WHERE BUKRS = '1000'");
    expect(result.sqlRewritten).toBe("SELECT * FROM T001 WHERE BUKRS = '1000'");
  });

  it('takes a leading WHERE off rather than writing it twice', async () => {
    const { handlers, asked } = handler();
    await handlers.handleTableContents({ ddicEntityName: 'T001', sqlQuery: "where bukrs = '1000'" });
    expect(asked[0].sql).toBe("SELECT * FROM T001 WHERE bukrs = '1000'");
  });

  it('passes a SELECT written out in full through untouched', async () => {
    const { handlers, asked } = handler();
    const result = answer(await handlers.handleTableContents({
      ddicEntityName: 'T001',
      sqlQuery: 'SELECT bukrs FROM t001'
    }));
    expect(asked[0].sql).toBe('SELECT bukrs FROM t001');
    expect(result.sqlRewritten).toBeUndefined();
  });
});
