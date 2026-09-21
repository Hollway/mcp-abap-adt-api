import type { ToolDefinition } from "../types/tools";
import type { ADTClient } from "abap-adt-api";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { performance } from 'perf_hooks';
import { createLogger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { wrapAdtError } from '../lib/adtError';

export abstract class BaseHandler {
  protected readonly adtclient: ADTClient;
  protected readonly logger = createLogger(this.constructor.name);

  constructor(adtclient: ADTClient) {
    this.adtclient = adtclient;
  }

  /**
   * Client for calls that only read.
   *
   * The main client is stateful, because locks and source writes require it -
   * and abap-adt-api deliberately skips its re-login retry while a client is
   * stateful (AdtHTTP.request guards it with !this.isStateful). A long stretch
   * of reads on the stateful session is therefore exactly how that session
   * used to rot and take every later call down with it.
   *
   * statelessClone is a separate client with its own session: reads recover on
   * their own and never disturb the session holding the locks. Flipping the
   * main client's session type per call is NOT an option - sending
   * X-sap-adt-sessiontype: stateless ends the stateful session and releases
   * every lock with it.
   *
   * The debugger uses neither: it opens a stateful session of its own, so
   * that a listener waiting for a breakpoint does not hold this one. See
   * lib/debugSession.
   */
  protected get readClient(): ADTClient {
    try {
      // statelessClone needs credentials to build, and a stubbed client in a
      // test may not have it at all - fall back rather than fail the call.
      return this.adtclient.statelessClone || this.adtclient;
    } catch {
      return this.adtclient;
    }
  }

  /**
   * Count one backend call. The numbers live in lib/metrics so healthcheck can
   * report them; the log line is debug, not info, because it used to be
   * written on every single request.
   */
  protected trackRequest(startTime: number, success: boolean): void {
    const duration = performance.now() - startTime;
    metrics.record(this.constructor.name, duration, success);
    this.logger.debug('Request completed', { duration: Math.round(duration), success });
  }

  /**
   * The wire envelope every tool answer shares: one text block carrying the
   * payload as JSON. Compact, not pretty-printed - the client parses it back
   * into an object and never shows the raw text to a person.
   */
  protected answer(payload: Record<string, unknown>): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  /**
   * The shape nearly every handler method repeats: time a backend call,
   * count it on both paths, and turn a thrown error into an AdtToolError
   * that keeps SAP's own diagnosis. `label` is the old human-readable prefix
   * ("Failed to lock object") - or a function of the caught error, for the
   * few call sites whose message depends on what actually failed (a 404 that
   * means "not on this system" rather than a real error, say).
   */
  protected async tracked<T>(
    label: string | ((error: unknown) => string),
    fn: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now();
    try {
      const result = await fn();
      this.trackRequest(startTime, true);
      return result;
    } catch (error) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, typeof label === 'function' ? label(error) : label);
    }
  }

  /**
   * The ADT object type argument, defaulted and normalised: most callers
   * work with a class and never pass one at all.
   */
  protected objectTypeArg(args: any, key = 'objectType'): string {
    return String(args?.[key] || 'CLAS/OC').trim().toUpperCase();
  }

  /**
   * A required identifier argument, trimmed and upper-cased - or the "which
   * one? pass this" refusal every tool needs when the caller left it out.
   */
  protected requireUpper(args: any, key: string, message: string): string {
    const value = String(args?.[key] || '').trim().toUpperCase();
    if (!value) throw new McpError(ErrorCode.InvalidParams, message);
    return value;
  }

  /**
   * Accept a structured argument either as JSON already parsed by the client
   * or as a JSON string. Several tools declared object/array parameters as
   * plain strings and handed them to abap-adt-api unparsed, which meant the
   * library read properties off a string and silently did the wrong thing.
   */
  protected parseObjectArg<T>(value: unknown, name: string): T {
    if (typeof value !== 'string') return value as T;
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `Parameter '${name}' is not valid JSON`);
    }
  }

  abstract getTools(): ToolDefinition[];
}
