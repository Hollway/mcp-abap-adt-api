import { ObjectLockHandlers } from '../handlers/ObjectLockHandlers';
import { lockRegistry } from '../lib/lockRegistry';
import { resetFallbackSession } from '../lib/sessionContext';
import type { ADTClient } from 'abap-adt-api';

/**
 * unLock resolves the lock through lockRegistry.forUrl, which is
 * prefix-tolerant: a class include is written through its own URL, but the
 * lock is recorded under the class URL that covers it. What matters is that
 * releasing it also forgets it under that same covering URL - forgetting the
 * caller's own (narrower) URL is a no-op and leaves a dead handle behind.
 */
const makeClient = () => ({
  lock: jest.fn().mockResolvedValue({ LOCK_HANDLE: 'HANDLE' }),
  unLock: jest.fn().mockResolvedValue(undefined),
  stateful: undefined
});

describe('ObjectLockHandlers.unLock', () => {
  beforeEach(() => {
    resetFallbackSession();
  });

  it('forgets the lock under the covering URL it was actually recorded under', async () => {
    const client = makeClient();
    const handlers = new ObjectLockHandlers(client as unknown as ADTClient);
    const classUrl = '/sap/bc/adt/oo/classes/zcl_app';
    const includeUrl = `${classUrl}/includes/testclasses`;

    lockRegistry.remember(classUrl, 'HANDLE');

    await handlers.handle('unLock', { objectUrl: includeUrl });

    expect(client.unLock).toHaveBeenCalledWith(includeUrl, 'HANDLE');
    expect(lockRegistry.count()).toBe(0);
    expect(lockRegistry.get(classUrl)).toBeUndefined();
  });

  it('still forgets an exact-match lock the same way it always did', async () => {
    const client = makeClient();
    const handlers = new ObjectLockHandlers(client as unknown as ADTClient);
    const url = '/sap/bc/adt/programs/programs/zprog';

    lockRegistry.remember(url, 'HANDLE');

    await handlers.handle('unLock', { objectUrl: url });

    expect(lockRegistry.count()).toBe(0);
  });
});
