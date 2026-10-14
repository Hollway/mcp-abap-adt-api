import { ObjectDeletionHandlers } from '../handlers/ObjectDeletionHandlers';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCache } from '../lib/sourceCache';

/**
 * Deleting an object does not release its lock - seen on a live system: after
 * deleteObject the lock was still there and the registry still listed it,
 * pointing at an object that no longer existed. The handler releases it now.
 */
const URL = '/sap/bc/adt/programs/includes/zdev_test_t01';

const handler = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const client = {
    stateful: 'stateful',
    deleteObject: async () => { calls.push('delete'); },
    unLock: async () => { calls.push('unlock'); },
    ...over
  };
  return { handlers: new ObjectDeletionHandlers(client as any), calls };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => {
  lockRegistry.clear();
  lockRegistry.remember(URL, 'HANDLE');
  sourceCache.clear();
});

describe('deleteObject', () => {
  it('releases the lock and forgets it', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleDeleteObject({ objectUrl: URL, lockHandle: 'HANDLE' }));
    expect(calls).toEqual(['delete', 'unlock']);
    expect(result).toMatchObject({ status: 'success', lockReleased: true, locksHeld: 0 });
    expect(lockRegistry.count()).toBe(0);
  });

  it('still reports success when the unlock fails, and says why', async () => {
    const { handlers, calls } = handler({
      unLock: async () => { throw new Error('lock is gone'); }
    });
    const result = answer(await handlers.handleDeleteObject({ objectUrl: URL, lockHandle: 'HANDLE' }));
    expect(calls).toEqual(['delete']);
    expect(result).toMatchObject({
      status: 'success',
      lockReleased: false,
      lockError: 'lock is gone',
      locksHeld: 0
    });
    // the object is gone either way, so the entry must not linger
    expect(lockRegistry.count()).toBe(0);
  });

  // Without this, a syntax check reusing the cached text would report an
  // object that is no longer in the system as fine.
  it('forgets the source it had cached for the object', async () => {
    sourceCache.set(`${URL}/source/main`, 'REPORT zdev_test.');
    const { handlers } = handler();
    const result = answer(await handlers.handleDeleteObject({ objectUrl: URL, lockHandle: 'HANDLE' }));
    expect(result.sourceCacheDropped).toBe(1);
    expect(sourceCache.has(`${URL}/source/main`)).toBe(false);
  });

  it('keeps the cached source when the deletion fails', async () => {
    sourceCache.set(`${URL}/source/main`, 'REPORT zdev_test.');
    const { handlers } = handler({
      deleteObject: async () => { throw new Error('object is used elsewhere'); }
    });
    await expect(handlers.handleDeleteObject({ objectUrl: URL, lockHandle: 'HANDLE' }))
      .rejects.toThrow(/object is used elsewhere/);
    expect(sourceCache.has(`${URL}/source/main`)).toBe(true);
  });

  /**
   * Refusing to delete without a lock taken in a separate call was friction
   * with no safety in it, and it made the obvious cleanup after createAndWrite
   * fail: that call releases its lock when it is done, so nothing is held by
   * the time the object is to be deleted.
   */
  it('takes the lock itself when none is held', async () => {
    lockRegistry.clear();
    const { handlers, calls } = handler({
      lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'FRESH' }; }
    });
    const result = answer(await handlers.handleDeleteObject({ objectUrl: URL }));
    expect(calls).toEqual(['lock', 'delete', 'unlock']);
    expect(result).toMatchObject({ status: 'success', lockReleased: true, locksHeld: 0 });
  });

  it('deletes with the handle it already holds rather than locking again', async () => {
    const { handlers, calls } = handler({
      lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'FRESH' }; }
    });
    answer(await handlers.handleDeleteObject({ objectUrl: URL }));
    expect(calls).toEqual(['delete', 'unlock']);
  });

  it('says why it could not delete when the lock is refused', async () => {
    lockRegistry.clear();
    const { handlers } = handler({
      lock: async () => { throw new Error('user JSMITH is already processing this object'); }
    });
    await expect(handlers.handleDeleteObject({ objectUrl: URL }))
      .rejects.toThrow(/Could not lock .* for deletion/);
  });

  it('points a dictionary object without an ADT address to deleteDdicObject', async () => {
    lockRegistry.clear();
    const { handlers } = handler({
      lock: () => Promise.reject({
        typeID: Symbol.for('ADT EXCEPTION'),
        err: 404,
        type: 'ExceptionResourceNotFound',
        message: 'Resource not found',
        localizedMessage: 'Resource not found'
      })
    });
    await expect(handlers.handleDeleteObject({ objectUrl: '/sap/bc/adt/ddic/domains/zdemo_dom' }))
      .rejects.toThrow(/deleteDdicObject/);
  });

  it('asks for the object rather than guessing when no url is given', async () => {
    const { handlers } = handler();
    await expect(handlers.handleDeleteObject({})).rejects.toThrow(/Pass objectUrl/);
  });

  /**
   * ADT's DELETE of a message class leaves every long text behind and can
   * answer success on a transportable class it did not delete, so a message
   * class goes the SE91 way, previewed first - never to client.deleteObject.
   */
  describe('on a message class', () => {
    const CLASS_URL = '/sap/bc/adt/messageclass/zdemo_msg';
    const tables: Record<string, Record<string, any>[]> = {
      t100a: [{ ARBGB: 'ZDEMO_MSG', MASTERLANG: 'R', RESPUSER: 'DEVELOPER', LASTUSER: 'DEVELOPER', LDATE: '2026-10-01', LTIME: '120000' }],
      tadir: [{ DEVCLASS: '$TMP' }],
      t100t: [{ SPRSL: 'R', STEXT: 'Demo' }],
      't100 ': [{ MSGNR: '001', SPRSL: 'R', TEXT: 'One' }, { MSGNR: '001', SPRSL: 'E', TEXT: 'One' }],
      t100u: [{ MSGNR: '001', NAME: 'DEVELOPER', DATUM: '2026-10-01', SELFDEF: '3' }],
      t100x: [],
      dokhl: [{ OBJECT: 'ZDEMO_MSG001', LANGU: 'D', DOKVERSION: 1, DOKSTATE: 'N' }]
    };
    const messageClassHandler = () => {
      const queries: string[] = [];
      const { handlers, calls } = handler({
        runQuery: async (sql: string) => {
          queries.push(sql);
          const table = Object.keys(tables).find(name => new RegExp(`FROM ${name}`, 'i').test(`${sql} `));
          return { values: table ? tables[table] : [] };
        },
        usageReferences: async () => [{ objectIdentifier: 'ZR_DEMO' }]
      });
      return { handlers, calls, queries };
    };

    it('previews instead of deleting, with a token', async () => {
      const { handlers, calls } = messageClassHandler();
      const result = answer(await handlers.handleDeleteObject({ objectUrl: CLASS_URL }));
      expect(calls).toEqual([]);
      expect(result).toMatchObject({
        preview: true,
        deleted: false,
        className: 'ZDEMO_MSG',
        packageName: '$TMP',
        messages: 1,
        textsPerLanguage: { R: 1, E: 1 },
        longTexts: 1,
        usages: { sites: 1 }
      });
      expect(result.previewToken).toMatch(/^[0-9a-f]{16}$/);
    });

    it('refuses a token from another preview without running anything', async () => {
      const { handlers, calls } = messageClassHandler();
      const result = answer(await handlers.handleDeleteObject({ objectUrl: CLASS_URL, previewToken: '0000000000000000' }));
      expect(calls).toEqual([]);
      expect(result).toMatchObject({ status: 'error', deleted: false });
      expect(result.hint).toMatch(/previewToken does not match/);
    });

    it('sends a message inside a class to deleteMessages', async () => {
      const { handlers } = messageClassHandler();
      await expect(handlers.handleDeleteObject({ objectUrl: `${CLASS_URL}/messages/001` }))
        .rejects.toThrow(/deleteMessages/);
    });
  });

  it('keeps the lock when the deletion itself fails', async () => {
    const { handlers } = handler({
      deleteObject: async () => { throw new Error('object is used elsewhere'); }
    });
    await expect(handlers.handleDeleteObject({ objectUrl: URL, lockHandle: 'HANDLE' }))
      .rejects.toThrow(/object is used elsewhere/);
    expect(lockRegistry.count()).toBe(1);
  });
});
