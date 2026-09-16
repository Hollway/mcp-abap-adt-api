/**
 * Keep stdout for the protocol, whoever writes to it.
 *
 * Over stdio, stdout carries JSON-RPC: one message per line, nothing else. Our
 * own logger has always written to stderr (lib/logger), but a dependency does
 * not know that. abap-adt-api prints its change-package refactoring object with
 * a plain console.log (build/api/refactor.js), so every changePackagePreview
 * pushed a line of `changePackageRefactoring here { ... }` into the message
 * stream and the client failed to parse the answer it was waiting for.
 *
 * Rather than patch around that one call, take the channel away from console
 * entirely: everything console prints goes to stderr, where a log belongs.
 * console.error already does, and is left alone.
 */

type ConsoleWriter = (...args: unknown[]) => void;

let restore: (() => void) | undefined;

/**
 * Route console.log/info/warn/debug to stderr. Returns a function that puts
 * the original methods back - tests use it; the server never does.
 */
export function protectStdout(target: Console = console): () => void {
  if (restore) return restore;

  const saved: Partial<Record<'log' | 'info' | 'warn' | 'debug', ConsoleWriter>> = {
    log: target.log.bind(target),
    info: target.info.bind(target),
    warn: target.warn.bind(target),
    debug: target.debug.bind(target)
  };

  const toStderr = target.error.bind(target) as ConsoleWriter;
  target.log = toStderr;
  target.info = toStderr;
  target.warn = toStderr;
  target.debug = toStderr;

  restore = () => {
    if (saved.log) target.log = saved.log;
    if (saved.info) target.info = saved.info;
    if (saved.warn) target.warn = saved.warn;
    if (saved.debug) target.debug = saved.debug;
    restore = undefined;
  };
  return restore;
}
