/**
 * Which request the code currently running belongs to.
 *
 * Over stdio a log line needed no attribution: one process, one person, one
 * call at a time. Over HTTP a dozen people share the log, several calls are
 * in flight at once, and a line saying "dropping 2 lock handle(s)" answers
 * none of the questions worth asking - whose, and during what.
 *
 * So every line written while serving a request carries the same short id,
 * the caller and the tool. That is the difference between reading a log and
 * guessing from timestamps.
 *
 * Separate from the session context on purpose: a session outlives the
 * request, and several requests can run on one session at the same time
 * (reads travel on the stateless clone and are not serialised), so a field
 * on the session would be overwritten by whoever started last.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContext {
  /** Short and readable: this ends up on every line, not in a database. */
  id: string;
  user?: string;
  tool?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const newRequestId = (): string => randomUUID().slice(0, 8);

export const currentRequest = (): RequestContext | undefined => storage.getStore();

export const runInRequest = <T>(context: RequestContext, work: () => T): T =>
  storage.run(context, work);

/**
 * Name the tool once it is known.
 *
 * The context is established before the body has been parsed - a request
 * that fails to parse still deserves an id - so the tool is filled in after
 * the fact rather than making the id wait for it.
 */
export const nameTool = (tool: string | undefined): void => {
  const context = storage.getStore();
  if (context && tool) context.tool = tool;
};
