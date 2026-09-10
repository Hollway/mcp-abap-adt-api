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

  it('keeps the lock when the deletion itself fails', async () => {
    const { handlers } = handler({
      deleteObject: async () => { throw new Error('object is used elsewhere'); }
    });
    await expect(handlers.handleDeleteObject({ objectUrl: URL, lockHandle: 'HANDLE' }))
      .rejects.toThrow(/object is used elsewhere/);
    expect(lockRegistry.count()).toBe(1);
  });
});
