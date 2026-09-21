/**
 * The session a debugger holds, which cannot be the session everything else
 * uses.
 *
 * debuggerListen is a long poll: it answers only when a process stops at a
 * breakpoint, and abap-adt-api sends it with a timeout of 360000000 ms - one
 * hundred hours. On the stateful client that is the session the locks and the
 * source writes travel on, and SAP serialises the requests of one session, so
 * a listener with nothing to trigger it made every writing tool queue behind
 * it for as long as nobody hit the breakpoint. Measured here: two runs issued
 * one after the other never overlapped, so there is no second session to
 * trigger the program from either.
 *
 * The debugger gets its own session: a second stateful client on the same
 * credentials, opened when a debug session starts and closed when it ends.
 * The listener waits there and blocks nothing.
 *
 * Deleting a listener deliberately does NOT go through it. That request has
 * to overtake the pending POST it cancels, and inside the same session it
 * would queue behind exactly the call it is meant to end.
 */
import { ADTClient, session_types } from 'abap-adt-api';
import { currentSession } from './sessionContext';

/** A listener that was started and has not answered yet. */
export interface PendingListen {
  /** Which listener this is: debugging mode, terminal, IDE and user. */
  key: string;
  /**
   * The library call. It is kept after a bounded wait gives up, because the
   * listener on the backend is still registered and a second POST for the
   * same user is refused - the next wait rejoins this one.
   */
  promise: Promise<unknown>;
  startedAt: number;
  settled: boolean;
  /**
   * What it answered, kept because the answer usually arrives when nobody is
   * waiting for it.
   *
   * Measured: a listener started at 07:20 caught a process at 07:24, four
   * minutes after the bounded wait had returned - and the first version of
   * this threw that away, treated the listener as spent, and started a second
   * one while a work process stood stopped with nobody coming to attach to it.
   */
  value?: unknown;
  error?: unknown;
}

export interface DebugSessionState {
  /** The second stateful client, absent until a debugger tool needs one. */
  client?: ADTClient;
  listen?: PendingListen;
  attached?: { debuggeeId: string; since: string };
}

/** The debug session of whoever is calling, created empty on first use. */
export const debugState = (): DebugSessionState => {
  const session = currentSession();
  return (session.debug ??= {});
};

/**
 * The client the debug session runs on.
 *
 * Built like statelessClone does it - same credentials, same system - except
 * stateful, which a clone refuses to be. A stubbed client in a test has no
 * credentials to copy, so the main client is handed back rather than failing
 * the call; the tests that matter here are about what is sent, not where.
 */
export function debugClient(main: ADTClient): ADTClient {
  const state = debugState();
  if (state.client) return state.client;
  try {
    const source = main as unknown as {
      baseUrl: string;
      username: string;
      client: string;
      language: string;
      password?: string;
      fetcher?: unknown;
      options?: { options?: unknown };
    };
    const secret = (source.fetcher || source.password) as string | undefined;
    if (!secret || !source.baseUrl || !source.username) return main;
    const client = new ADTClient(
      source.baseUrl,
      source.username,
      secret,
      source.client,
      source.language,
      source.options?.options as never
    );
    client.stateful = session_types.stateful;
    state.client = client;
    return client;
  } catch {
    return main;
  }
}

/** True when this session opened a debug session of its own. */
export const hasDebugClient = (): boolean => debugState().client !== undefined;

export const listenKey = (args: {
  debuggingMode?: unknown;
  terminalId?: unknown;
  ideId?: unknown;
  user?: unknown;
}): string =>
  [args.debuggingMode, args.terminalId, args.ideId, args.user].map(part => String(part ?? '')).join('|');

/**
 * Remember a listener that was just started.
 *
 * The rejection handler is attached here and not where the waiting happens:
 * a promise nobody is awaiting - which is what a listener becomes the moment
 * a bounded wait gives up - takes the process down with it when it fails.
 */
export function rememberListen(key: string, promise: Promise<unknown>, now: number = Date.now()): PendingListen {
  const pending: PendingListen = { key, promise, startedAt: now, settled: false };
  promise.then(
    value => { pending.settled = true; pending.value = value; },
    error => { pending.settled = true; pending.error = error; }
  );
  debugState().listen = pending;
  return pending;
}

/**
 * The listener this session started, answered or not.
 *
 * A listener that has already answered is still the right one to hand back:
 * its answer is a process standing stopped somewhere, and starting a second
 * listener instead would leave that process there.
 */
export const pendingListen = (key: string): PendingListen | undefined => {
  const listen = debugState().listen;
  return listen && listen.key === key ? listen : undefined;
};

export const clearListen = (): void => {
  debugState().listen = undefined;
};

export type WaitOutcome<T> = { stopped: true; value: T } | { stopped: false };

/**
 * Wait for a listener, but not forever.
 *
 * Giving up returns; it does not cancel. The listener stays registered on the
 * backend and the call stays in flight on the debug session, so the caller
 * gets control back and can ask again, look at something else, or delete the
 * listener.
 */
export async function waitForListen<T>(pending: PendingListen, seconds: number): Promise<WaitOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<WaitOutcome<T>>(resolve => {
    timer = setTimeout(() => resolve({ stopped: false }), Math.max(1, seconds) * 1000);
  });
  try {
    return await Promise.race([
      pending.promise.then(value => ({ stopped: true, value: value as T }) as WaitOutcome<T>),
      expiry
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const setAttached = (debuggeeId: string): void => {
  debugState().attached = { debuggeeId, since: new Date().toISOString() };
};

export const clearAttached = (): void => {
  debugState().attached = undefined;
};

export const attachedDebuggee = (): string | undefined => debugState().attached?.debuggeeId;

/**
 * What to say when a debugger call fails and nothing is attached.
 *
 * Every one of them answers the same way otherwise: 500 AdiFailed with the
 * system language's word for "an exception was raised" - "Обнаружена особая
 * ситуация" on this system - whether the session is missing, the debuggee has
 * gone, or the release does not support the call at all. The one thing this
 * server knows for certain is whether it attached anything, so that is what
 * the message adds.
 */
export const NO_DEBUG_SESSION =
  'no debug session is attached here - set breakpoints, call debuggerListen (it answers when a process stops) ' +
  'and attach to the debuggee it reports';

/** Label for a failure, naming the missing session when there is one. */
export const debugFailure = (label: string): string =>
  attachedDebuggee() ? label : `${label} - ${NO_DEBUG_SESSION}`;

/**
 * End the debug session.
 *
 * Best effort in every step: a logout that fails must not stop the caller,
 * and the state is dropped either way - a client kept after its session died
 * would answer the next debug session with somebody else's 401.
 */
export async function closeDebugSession(): Promise<void> {
  const state = debugState();
  const client = state.client;
  state.client = undefined;
  state.listen = undefined;
  state.attached = undefined;
  if (!client) return;
  try {
    await client.logout();
  } catch {
    // The session may already be gone; that is the state this wanted anyway.
  }
}
