import type { ToolDefinition } from "../types/tools";
import type { ADTClient } from "abap-adt-api";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { performance } from 'perf_hooks';
import { createLogger } from '../lib/logger';
import { metrics } from '../lib/metrics';

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
   * The debugger keeps using the stateful client: its reads only mean anything
   * inside the attached session.
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
