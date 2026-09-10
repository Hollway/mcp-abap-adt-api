import { DebugHandlers } from '../handlers/DebugHandlers';

/**
 * Asking the backend to check for a listener conflict raises a short dump when
 * there is no listener at all - which is every system where nobody happens to
 * be debugging. The library defaults that check to on, so the plain call, with
 * only the arguments the tool declares as required, answered 500 AdiFailed on a
 * live ECC run. It is off here unless the caller asks for it.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const handler = (result: unknown = undefined) => {
  const calls: unknown[][] = [];
  const client = {
    debuggerListeners: async (...args: unknown[]) => {
      calls.push(args);
      return result;
    }
  };
  return { handlers: new DebugHandlers(client as any), calls };
};

const ARGS = {
  debuggingMode: 'user',
  terminalId: '3C4A5B6D7E8F41A2B3C4D5E6F7A8B9C0',
  ideId: '3C4A5B6D7E8F41A2B3C4D5E6F7A8B9C1',
  user: 'TESTER'
};

describe('debuggerListeners', () => {
  it('does not ask for the conflict check unless told to', async () => {
    const { handlers, calls } = handler();
    await handlers.handleDebuggerListeners({ ...ARGS });
    expect(calls[0][4]).toBe(false);
  });

  it('passes the conflict check on when it is asked for', async () => {
    const { handlers, calls } = handler();
    await handlers.handleDebuggerListeners({ ...ARGS, checkConflict: true });
    expect(calls[0][4]).toBe(true);
  });

  it('says there is no listener instead of answering a bare success', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleDebuggerListeners({ ...ARGS }));
    expect(result).toMatchObject({ status: 'success', listener: 'none', user: 'TESTER' });
    expect(result.note).toContain('debuggerListen');
  });

  it('reports the conflict the backend described', async () => {
    const conflict = { conflictText: 'Another listener is already registered' };
    const { handlers } = handler(conflict);
    const result = answer(await handlers.handleDebuggerListeners({ ...ARGS }));
    expect(result).toMatchObject({ listener: 'conflict', result: conflict });
    expect(result.note).toBeUndefined();
  });
});
