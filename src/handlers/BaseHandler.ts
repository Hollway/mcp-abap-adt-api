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
   * Count one backend call. The numbers live in lib/metrics so healthcheck can
   * report them; the log line is debug, not info, because it used to be
   * written on every single request.
   */
  protected trackRequest(startTime: number, success: boolean): void {
    const duration = performance.now() - startTime;
    metrics.record(this.constructor.name, duration, success);
    this.logger.debug('Request completed', { duration: Math.round(duration), success });
  }

  abstract getTools(): ToolDefinition[];
}
