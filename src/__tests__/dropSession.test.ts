import { AuthHandlers } from '../handlers/AuthHandlers';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCache } from '../lib/sourceCache';

/**
 * dropSession reported failure for a session that did not exist.
 *
 * The library sends its drop request without the auto-login the normal path
 * has, so on a client that never logged in - the usual case, because reads run
 * on the stateless clone - the backend answered 401 and the tool raised it.
 * And the locks taken in the dropped session went on being offered to the next
 * write although their handles died with it.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

/** The shape a dead session came back as on the live system: 401, undiagnosed. */
const dead = () => {
  const error: any = new Error('Request failed with status code 401');
  // abap-adt-api tags its HTTP failures with this symbol, and that is what
  // makes a 401 recognisable as one rather than as an unknown exception.
  error.typeID = Symbol.for('HTTP EXCEPTION');
  error.status = 401;
  error.code = 'ERR_BAD_REQUEST';
  return error;
};

beforeEach(() => {
  lockRegistry.clear();
  sourceCache.clear();
});

describe('dropSession', () => {
  it('drops the session when there is one, and says so', async () => {
    const calls: string[] = [];
    const client = { loggedin: true, dropSession: async () => { calls.push('drop'); } };
    const result = answer(await new AuthHandlers(client as any).handle('dropSession', {}));
    expect(calls).toEqual(['drop']);
    expect(result).toMatchObject({ status: 'success', dropped: true });
  });

  it('does not call the backend when no session is open', async () => {
    const calls: string[] = [];
    const client = { loggedin: false, dropSession: async () => { calls.push('drop'); } };
    const result = answer(await new AuthHandlers(client as any).handle('dropSession', {}));
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: 'success', dropped: false });
    expect(result.note).toMatch(/nothing to drop/i);
  });

  it('treats a session that is already gone as the state it wanted', async () => {
    const client = { loggedin: true, dropSession: async () => { throw dead(); } };
    const result = answer(await new AuthHandlers(client as any).handle('dropSession', {}));
    expect(result).toMatchObject({ status: 'success', dropped: false });
    expect(result.note).toMatch(/already gone/i);
  });

  it('still raises a failure that is not about the session', async () => {
    const client = { loggedin: true, dropSession: async () => { throw new Error('connect ECONNREFUSED'); } };
    await expect(new AuthHandlers(client as any).handle('dropSession', {}))
      .rejects.toThrow(/ECONNREFUSED/);
  });

  it('forgets the locks that died with the session, and reports how many', async () => {
    lockRegistry.remember('/sap/bc/adt/oo/classes/zcl_a', 'HANDLE_A');
    lockRegistry.remember('/sap/bc/adt/oo/classes/zcl_b', 'HANDLE_B');
    const client = { loggedin: true, dropSession: async () => undefined };
    const result = answer(await new AuthHandlers(client as any).handle('dropSession', {}));
    expect(result.locksForgotten).toBe(2);
    expect(lockRegistry.count()).toBe(0);
  });

  it('forgets the cached sources too', async () => {
    sourceCache.set('/sap/bc/adt/oo/classes/zcl_a/source/main', 'CLASS zcl_a DEFINITION.');
    const client = { loggedin: true, dropSession: async () => undefined };
    const result = answer(await new AuthHandlers(client as any).handle('dropSession', {}));
    expect(result.sourcesForgotten).toBe(1);
    expect(sourceCache.has('/sap/bc/adt/oo/classes/zcl_a/source/main')).toBe(false);
  });

  it('clears the local state even when the drop itself fails', async () => {
    lockRegistry.remember('/sap/bc/adt/oo/classes/zcl_a', 'HANDLE_A');
    const client = { loggedin: true, dropSession: async () => { throw dead(); } };
    await new AuthHandlers(client as any).handle('dropSession', {});
    expect(lockRegistry.count()).toBe(0);
  });
});
