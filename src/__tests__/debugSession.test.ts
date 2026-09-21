import { DebugHandlers } from '../handlers/DebugHandlers';
import { resetFallbackSession } from '../lib/sessionContext';
import { debugState } from '../lib/debugSession';

/**
 * What a debugger costs the rest of the server.
 *
 * debuggerListen only answers when a process stops at a breakpoint, and the
 * library sends it with a timeout of one hundred hours. It used to wait on the
 * stateful client, which is the session the locks and the writes are on and
 * which SAP serialises: one listener with nothing to trigger it, and every
 * writing tool queued behind it until somebody noticed. Here it waits on a
 * session of its own, for a bounded time, and says what it is still waiting
 * for.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const never = () => new Promise<never>(() => { /* a listener nobody triggers */ });

const handler = (client: Record<string, unknown>) => {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    const answerFor = (client as any)[`${name}Result`];
    return typeof answerFor === 'function' ? answerFor(...args) : Promise.resolve(answerFor);
  };
  const stub: Record<string, unknown> = {};
  for (const name of Object.keys(client)) {
    if (name.endsWith('Result')) continue;
    stub[name] = record(name);
  }
  return { handlers: new DebugHandlers(stub as any), calls, stub };
};

const ARGS = {
  debuggingMode: 'user',
  terminalId: '3C4A5B6D7E8F41A2B3C4D5E6F7A8B9C0',
  ideId: '3C4A5B6D7E8F41A2B3C4D5E6F7A8B9C1',
  user: 'TESTER'
};

beforeEach(() => {
  resetFallbackSession();
});

describe('debuggerListen', () => {
  it('gives up waiting instead of holding the call open', async () => {
    const { handlers } = handler({ debuggerListen: true, debuggerListenResult: never });
    const result = answer(await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 1 }));
    expect(result).toMatchObject({ status: 'waiting', listener: 'registered', waitedSeconds: 1 });
    expect(result.note).toContain('debuggerDeleteListener');
  });

  it('rejoins the listener it already started', async () => {
    const { handlers, calls } = handler({ debuggerListen: true, debuggerListenResult: never });
    const first = answer(await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 1 }));
    const second = answer(await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 1 }));
    expect(first.rejoined).toBe(false);
    expect(second.rejoined).toBe(true);
    // One POST, two waits: a second listener for the same user is refused by
    // the backend anyway, and it is the first one that will answer.
    expect(calls.debuggerListen).toHaveLength(1);
  });

  it('names the debuggee and what to do with it', async () => {
    const debuggee = { DEBUGGEE_ID: 'ABC123', DEBUGGEE_USER: 'TESTER' };
    const { handlers } = handler({ debuggerListen: true, debuggerListenResult: () => Promise.resolve(debuggee) });
    const result = answer(await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 5 }));
    expect(result).toMatchObject({ status: 'success', stopped: true, debuggeeId: 'ABC123' });
    expect(result.next).toContain('debuggerAttach');
    expect(debugState().listen).toBeUndefined();
  });

  /**
   * Measured on a live run: a listener started at 07:20:04 caught a process at
   * 07:24, long after the bounded wait had answered - and the first version of
   * this treated the listener as spent and started a second one, while a work
   * process stood stopped with nobody coming for it.
   */
  it('keeps an answer that arrived while nothing was waiting', async () => {
    const debuggee = { DEBUGGEE_ID: 'LATE1' };
    const late = () => new Promise(resolve => setTimeout(() => resolve(debuggee), 1200));
    const { handlers, calls } = handler({ debuggerListen: true, debuggerListenResult: late });
    const first = answer(await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 1 }));
    expect(first.status).toBe('waiting');
    // The stop happens here, with nothing waiting for it.
    await new Promise(resolve => setTimeout(resolve, 400));
    const second = answer(await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 1 }));
    expect(second).toMatchObject({ status: 'success', stopped: true, debuggeeId: 'LATE1', caughtWhileNotWaiting: true });
    expect(calls.debuggerListen).toHaveLength(1);
  });

  /**
   * What ended the listener on the live run: the POST was cut with 504 after
   * about three and a half minutes by the proxy in front of the system, which
   * is nothing like the hundred hours the library asks for.
   */
  it('says who cut the connection when a listener ends in a gateway timeout', async () => {
    const cut = () => Promise.reject({
      typeID: Symbol.for('HTTP EXCEPTION'),
      status: 504,
      code: 'ERR_BAD_RESPONSE',
      message: 'Request failed with status code 504'
    });
    const { handlers } = handler({ debuggerListen: true, debuggerListenResult: cut });
    await expect(handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 5 }))
      .rejects.toThrow(/connection was cut after \d+s \(HTTP 504/);
  });

  it('caps a wait nobody should be able to ask for', async () => {
    const { handlers } = handler({ debuggerListen: true, debuggerListenResult: never });
    const seconds = (handlers as any).waitSeconds.bind(handlers);
    expect(seconds(undefined)).toBe(60);
    expect(seconds(0)).toBe(60);
    expect(seconds(100000)).toBe(900);
    expect(seconds(0.2)).toBe(1);
  });
});

describe('debuggerListeners', () => {
  /**
   * With no listener registered for the user at all, the backend refuses the
   * listeners resource itself - 404, and it names the resource as a blank:
   * "Resource   does not exist." Measured both ways within the hour on one
   * system: 200 while a listener was registered, 404 from the moment the last
   * one was deleted. The smoke run had been passing on a registration left
   * behind by earlier work, and started failing the day it was cleaned up.
   */
  it('reads the 404 of a user with no registration as an answer', async () => {
    const gone = () => Promise.reject({
      typeID: Symbol.for('ADT EXCEPTION'),
      err: 404,
      type: 'ExceptionResourceNotFound',
      message: 'Resource   does not exist.',
      localizedMessage: 'Resource   does not exist.'
    });
    const { handlers } = handler({ debuggerListeners: true, debuggerListenersResult: gone });
    const result = answer(await handlers.handleDebuggerListeners({ ...ARGS }));
    expect(result).toMatchObject({ status: 'success', listener: 'none', registration: 'none' });
    expect(result.note).toContain('debuggerListen');
  });
});

describe('debuggerDeleteListener', () => {
  it('closes the debug session when nothing is stopped', async () => {
    const { handlers, calls } = handler({
      debuggerListen: true,
      debuggerListenResult: never,
      debuggerDeleteListener: true,
      debuggerDeleteListenerResult: undefined
    });
    await handlers.handleDebuggerListen({ ...ARGS, waitSeconds: 1 });
    const result = answer(await handlers.handleDebuggerDeleteListener({ ...ARGS }));
    expect(result).toMatchObject({ listener: 'deleted', debugSession: 'closed' });
    expect(calls.debuggerDeleteListener).toHaveLength(1);
    expect(debugState().listen).toBeUndefined();
  });

  it('keeps the session that holds a stopped debuggee', async () => {
    const { handlers } = handler({
      debuggerAttach: true,
      debuggerAttachResult: { isSteppingPossible: true },
      debuggerDeleteListener: true,
      debuggerDeleteListenerResult: undefined
    });
    await handlers.handleDebuggerAttach({ debuggingMode: 'user', debuggeeId: 'ABC123', user: 'TESTER' });
    const result = answer(await handlers.handleDebuggerDeleteListener({ ...ARGS }));
    expect(result).toMatchObject({ debugSession: 'kept', attachedDebuggee: 'ABC123' });
    expect(result.note).toContain('terminateDebuggee');
  });
});

describe('debuggerSaveSettings', () => {
  it('sends the flags it was given, not the defaults', async () => {
    const { handlers, calls } = handler({ debuggerSaveSettings: true, debuggerSaveSettingsResult: {} });
    const result = answer(await handlers.handleDebuggerSaveSettings({
      settings: '{"systemDebugging":true,"updateDebugging":true}'
    }));
    expect(calls.debuggerSaveSettings[0][0]).toEqual({ systemDebugging: true, updateDebugging: true });
    expect(result.sent).toEqual({ systemDebugging: true, updateDebugging: true });
  });

  it('refuses something that is not a set of flags', async () => {
    const { handlers } = handler({ debuggerSaveSettings: true, debuggerSaveSettingsResult: {} });
    await expect(handlers.handleDebuggerSaveSettings({ settings: 'systemDebugging' }))
      .rejects.toThrow(/not valid JSON/);
    await expect(handlers.handleDebuggerSaveSettings({ settings: '[1,2]' }))
      .rejects.toThrow(/object of debugger flags/);
  });
});

describe('debuggerGoToStack', () => {
  it('takes the frame number the stack reports', async () => {
    const { handlers, calls } = handler({ debuggerGoToStack: true, debuggerGoToStackResult: undefined });
    await handlers.handleDebuggerGoToStack({ urlOrPosition: '2' });
    // A number takes the older setStackPosition endpoint, which is the only
    // one a system without stack URIs has.
    expect(calls.debuggerGoToStack[0][0]).toBe(2);
  });

  it('takes the stack URI of a frame', async () => {
    const uri = '/sap/bc/adt/debugger/stack/type/abap/position/3';
    const { handlers, calls } = handler({ debuggerGoToStack: true, debuggerGoToStackResult: undefined });
    await handlers.handleDebuggerGoToStack({ urlOrPosition: uri });
    expect(calls.debuggerGoToStack[0][0]).toBe(uri);
  });

  it('refuses anything else by naming both forms', async () => {
    const { handlers } = handler({ debuggerGoToStack: true, debuggerGoToStackResult: undefined });
    await expect(handlers.handleDebuggerGoToStack({ urlOrPosition: 'top' }))
      .rejects.toThrow(/frame number nor a stack URI/);
  });
});

describe('debuggerStep', () => {
  it('refuses a step to a line without the line', async () => {
    const { handlers } = handler({ debuggerStep: true, debuggerStepResult: {} });
    await expect(handlers.handleDebuggerStep({ steptype: 'stepRunToLine' }))
      .rejects.toThrow(/needs url/);
  });

  it('forgets the debuggee it terminated', async () => {
    const { handlers } = handler({
      debuggerAttach: true,
      debuggerAttachResult: {},
      debuggerStep: true,
      debuggerStepResult: { isRfcError: false }
    });
    await handlers.handleDebuggerAttach({ debuggingMode: 'user', debuggeeId: 'ABC123', user: 'TESTER' });
    const result = answer(await handlers.handleDebuggerStep({ steptype: 'terminateDebuggee' }));
    expect(result).toMatchObject({ debuggee: 'terminated', debugSession: 'closed' });
    expect(debugState().attached).toBeUndefined();
  });
});

describe('what a failure says', () => {
  /**
   * Every debugger call without an attached session answers the same 500
   * AdiFailed in the system language - "Обнаружена особая ситуация" on the
   * system this was measured on - whatever is actually wrong. The one thing
   * this server knows is whether it attached anything.
   */
  it('names the missing session when nothing is attached', async () => {
    const { handlers } = handler({
      debuggerStackTrace: true,
      debuggerStackTraceResult: () => Promise.reject(new Error('Обнаружена особая ситуация'))
    });
    await expect(handlers.handleDebuggerStackTrace({}))
      .rejects.toThrow(/no debug session is attached here/);
  });

  it('says nothing about the session when there is one', async () => {
    const { handlers } = handler({
      debuggerAttach: true,
      debuggerAttachResult: {},
      debuggerStackTrace: true,
      debuggerStackTraceResult: () => Promise.reject(new Error('Обнаружена особая ситуация'))
    });
    await handlers.handleDebuggerAttach({ debuggingMode: 'user', debuggeeId: 'ABC123', user: 'TESTER' });
    await expect(handlers.handleDebuggerStackTrace({}))
      .rejects.toThrow(/Failed to get stack trace: Обнаружена/);
    await expect(handlers.handleDebuggerStackTrace({}))
      .rejects.not.toThrow(/no debug session/);
  });
});

describe('structured arguments', () => {
  it('parses the ones that used to reach the library as text', async () => {
    const { handlers, calls } = handler({
      debuggerVariables: true,
      debuggerVariablesResult: [],
      debuggerChildVariables: true,
      debuggerChildVariablesResult: { variables: [] },
      debuggerDeleteBreakpoints: true,
      debuggerDeleteBreakpointsResult: undefined
    });
    await handlers.handleDebuggerVariables({ parents: '["@ROOT"]' });
    await handlers.handleDebuggerChildVariables({ parent: '["LT_ROWS"]' });
    await handlers.handleDebuggerDeleteBreakpoints({
      breakpoint: '{"id":"KIND=0.LINE_NR=7"}',
      ...ARGS,
      requestUser: 'TESTER'
    });
    expect(calls.debuggerVariables[0][0]).toEqual(['@ROOT']);
    expect(calls.debuggerChildVariables[0][0]).toEqual(['LT_ROWS']);
    expect(calls.debuggerDeleteBreakpoints[0][0]).toEqual({ id: 'KIND=0.LINE_NR=7' });
  });
});
