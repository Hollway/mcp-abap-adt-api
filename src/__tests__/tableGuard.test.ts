import { assertNotTable, ddicObjectOf, tableClassQuery, TableWriteRefused } from '../lib/tableGuard';
import { takeLock } from '../lib/lockCycle';
import { ObjectLockHandlers } from '../handlers/ObjectLockHandlers';
import { ObjectSourceHandlers } from '../handlers/ObjectSourceHandlers';
import { ObjectDeletionHandlers } from '../handlers/ObjectDeletionHandlers';
import { lockRegistry } from '../lib/lockRegistry';
import { resetFallbackSession } from '../lib/sessionContext';

/**
 * A transparent table and a structure share ddic/structures and the same DDL
 * text, so a table could be locked and rewritten over ADT exactly like a
 * structure - and one was, and broke. Nothing locks a table any more; every
 * write needs that lock first.
 */
const TABLE_URL = '/sap/bc/adt/ddic/structures/zdev_cfg';
const TABLE_SOURCE_URL = `${TABLE_URL}/source/main`;

const dd02l = (...classes: string[]) => async () => ({
  values: classes.map(tabclass => ({ TABNAME: 'ZDEV_CFG', AS4LOCAL: 'A', TABCLASS: tabclass }))
});

const client = (runQuery: any) => {
  const calls: string[] = [];
  return {
    calls,
    client: {
      stateful: 'stateless',
      runQuery: jest.fn(runQuery),
      lock: jest.fn(async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; }),
      unLock: jest.fn(async () => { calls.push('unlock'); }),
      deleteObject: jest.fn(async () => { calls.push('delete'); }),
      setObjectSource: jest.fn(async () => { calls.push('write'); }),
      getObjectSource: jest.fn(async () => 'define table zdev_cfg {\n  key mandt : mandt not null;\n}')
    } as any
  };
};

beforeEach(() => {
  lockRegistry.clear();
  resetFallbackSession();
});

describe('ddicObjectOf', () => {
  it('reads the DDIC name behind a structure, source or table address', () => {
    expect(ddicObjectOf(TABLE_SOURCE_URL)).toEqual({ collection: 'structures', name: 'ZDEV_CFG' });
    expect(ddicObjectOf('/sap/bc/adt/ddic/tables/t000')).toEqual({ collection: 'tables', name: 'T000' });
    expect(ddicObjectOf('/sap/bc/adt/ddic/structures/%2fdev%2fcfg')).toEqual({ collection: 'structures', name: '/DEV/CFG' });
  });

  it('leaves every other address alone', () => {
    expect(ddicObjectOf('/sap/bc/adt/oo/classes/zcl_app')).toBeUndefined();
    expect(ddicObjectOf('/sap/bc/adt/ddic/dataelements/zdev_de')).toBeUndefined();
    expect(ddicObjectOf('')).toBeUndefined();
  });
});

describe('assertNotTable', () => {
  it('asks DD02L for every version, not only the active one', () => {
    expect(tableClassQuery('zdev_cfg')).toBe("SELECT tabname,as4local,tabclass FROM dd02l WHERE tabname = 'ZDEV_CFG'");
  });

  it.each(['TRANSP', 'POOL', 'CLUSTER', 'VIEW'])('refuses a %s', async tabclass => {
    const { client: c } = client(dd02l(tabclass));
    await expect(assertNotTable(c, TABLE_SOURCE_URL)).rejects.toThrow(TableWriteRefused);
    await expect(assertNotTable(c, TABLE_SOURCE_URL)).rejects.toThrow(/SE11/);
  });

  it('refuses an append structure - it changes the table it is appended to', async () => {
    const { client: c } = client(dd02l('APPEND'));
    await expect(assertNotTable(c, TABLE_URL)).rejects.toThrow(/append structure/);
  });

  it('refuses when any version is a table, even if another says structure', async () => {
    const { client: c } = client(dd02l('INTTAB', 'TRANSP'));
    await expect(assertNotTable(c, TABLE_URL)).rejects.toThrow(/TRANSP/);
  });

  it('lets a plain structure through', async () => {
    const { client: c } = client(dd02l('INTTAB'));
    await expect(assertNotTable(c, TABLE_URL)).resolves.toBeUndefined();
  });

  it('lets through a name DD02L does not know - a structure created a moment ago', async () => {
    const { client: c } = client(async () => ({ values: [] }));
    await expect(assertNotTable(c, TABLE_URL)).resolves.toBeUndefined();
  });

  it('refuses when DD02L cannot be read, rather than guessing', async () => {
    const { client: c } = client(async () => { throw new Error('no data preview authorization'); });
    await expect(assertNotTable(c, TABLE_URL)).rejects.toThrow(/reading DD02L failed/);
  });

  it('refuses when DD02L has the name but no class', async () => {
    const { client: c } = client(async () => ({ values: [{ TABNAME: 'ZDEV_CFG' }] }));
    await expect(assertNotTable(c, TABLE_URL)).rejects.toThrow(/names no class/);
  });

  it('refuses a ddic/tables address without asking', async () => {
    const { client: c } = client(dd02l('INTTAB'));
    await expect(assertNotTable(c, '/sap/bc/adt/ddic/tables/zdev_cfg')).rejects.toThrow(TableWriteRefused);
    expect(c.runQuery).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a DDIC name', async () => {
    const { client: c } = client(dd02l('INTTAB'));
    await expect(assertNotTable(c, "/sap/bc/adt/ddic/structures/x'or'1")).rejects.toThrow(/not a valid DDIC name/);
    expect(c.runQuery).not.toHaveBeenCalled();
  });

  it('does not query at all for anything but a DDIC table or structure', async () => {
    const { client: c } = client(dd02l('TRANSP'));
    await assertNotTable(c, '/sap/bc/adt/programs/programs/zdev_prog');
    expect(c.runQuery).not.toHaveBeenCalled();
  });
});

describe('every way to a lock refuses a table', () => {
  it('the lock tool', async () => {
    const { client: c, calls } = client(dd02l('TRANSP'));
    const handlers = new ObjectLockHandlers(c);
    await expect(handlers.handle('lock', { objectUrl: TABLE_URL })).rejects.toThrow(/SE11/);
    expect(calls).toEqual([]);
    expect(lockRegistry.count()).toBe(0);
  });

  it('the lock tool still locks a structure', async () => {
    const { client: c, calls } = client(dd02l('INTTAB'));
    const handlers = new ObjectLockHandlers(c);
    await handlers.handle('lock', { objectUrl: TABLE_URL });
    expect(calls).toEqual(['lock']);
  });

  it('takeLock, behind every composite write', async () => {
    const { client: c, calls } = client(dd02l('TRANSP'));
    await expect(takeLock(c, TABLE_URL)).rejects.toThrow(TableWriteRefused);
    expect(calls).toEqual([]);
  });

  it('editObject - nothing is locked, written or activated', async () => {
    const { client: c, calls } = client(dd02l('TRANSP'));
    const handlers = new ObjectSourceHandlers(c);
    await expect(handlers.handle('editObject', {
      objectSourceUrl: TABLE_SOURCE_URL,
      edits: [{ anchor: 'key mandt : mandt not null;', position: 'after', text: '  inv_detect_matnr : abap.char(1);' }]
    })).rejects.toThrow(/SE11/);
    expect(calls).toEqual([]);
  });

  it('deleteObject', async () => {
    const { client: c, calls } = client(dd02l('TRANSP'));
    const handlers = new ObjectDeletionHandlers(c);
    await expect(handlers.handleDeleteObject({ objectUrl: TABLE_URL })).rejects.toThrow(/SE11/);
    expect(calls).toEqual([]);
  });
});
