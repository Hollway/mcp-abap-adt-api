import { trackUse } from '../lib/trackedClient';

/**
 * The wrapper exists because a list of "tools that use the stateful session"
 * could not be kept right: three read-only tools went through it and were
 * missed, so the pool thought a session was idle while SAP was counting it as
 * busy. Observing the client removes the list - so what matters here is that
 * observing it changes nothing else about how the client behaves.
 */
const clientLike = () => {
  const calls: string[] = [];
  const object = {
    baseUrl: 'https://sap.example.test/DEV00',
    username: 'JSMITH',
    stateful: 'stateless',
    inner: { nested: true },
    async lock(url: string) {
      calls.push(`lock:${url}`);
      return { LOCK_HANDLE: 'HANDLE' };
    },
    who(this: { username: string }) {
      return this.username;
    },
    get statelessClone() {
      // The real getter reaches for other members of the object, which is
      // why the proxy must read against the target rather than itself.
      return { baseUrl: this.baseUrl, isClone: true };
    },
    calls
  };
  return object;
};

describe('trackUse', () => {
  it('reports a call and passes the answer through unchanged', async () => {
    const client = clientLike();
    let uses = 0;
    const tracked = trackUse(client, () => uses++);

    const result = await tracked.lock('/zcl_thing');

    expect(result).toEqual({ LOCK_HANDLE: 'HANDLE' });
    expect(client.calls).toEqual(['lock:/zcl_thing']);
    expect(uses).toBe(1);
  });

  it('counts every call, not just the first', async () => {
    const client = clientLike();
    let uses = 0;
    const tracked = trackUse(client, () => uses++);

    await tracked.lock('/a');
    await tracked.lock('/b');

    expect(uses).toBe(2);
  });

  /**
   * Reading a property is local: it reaches no backend and says nothing
   * about whether the session is still alive.
   */
  it('does not count reading a property', () => {
    const client = clientLike();
    let uses = 0;
    const tracked = trackUse(client, () => uses++);

    expect(tracked.baseUrl).toBe('https://sap.example.test/DEV00');
    expect(tracked.username).toBe('JSMITH');
    expect(tracked.inner).toEqual({ nested: true });

    expect(uses).toBe(0);
  });

  it('does not count a getter that builds something', () => {
    const client = clientLike();
    let uses = 0;
    const tracked = trackUse(client, () => uses++);

    expect(tracked.statelessClone).toMatchObject({ isClone: true, baseUrl: client.baseUrl });
    expect(uses).toBe(0);
  });

  it('keeps methods bound to the real object', () => {
    const client = clientLike();
    const tracked = trackUse(client, () => undefined);

    expect(tracked.who()).toBe('JSMITH');
  });

  it('lets assignments through without counting them', () => {
    const client = clientLike();
    let uses = 0;
    const tracked = trackUse(client, () => uses++);

    tracked.stateful = 'stateful';

    expect(client.stateful).toBe('stateful');
    expect(uses).toBe(0);
  });

  /**
   * A fresh closure on every property read would allocate on a hot path and
   * break any code comparing the method it got last time.
   */
  it('hands back the same wrapper for the same method', () => {
    const tracked = trackUse(clientLike(), () => undefined);
    expect(tracked.lock).toBe(tracked.lock);
  });

  it('reports the call even when it fails', async () => {
    const failing = { async boom() { throw new Error('ADT said no'); } };
    let uses = 0;
    const tracked = trackUse(failing, () => uses++);

    await expect(tracked.boom()).rejects.toThrow('ADT said no');
    expect(uses).toBe(1);
  });
});
