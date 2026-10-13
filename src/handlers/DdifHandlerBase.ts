import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler';
import { SnippetHandlers } from './SnippetHandlers';
import { describeAdtError } from '../lib/adtError';
import {
  DdifError,
  isLocalPackage,
  parseDdifPrint,
  recordedSql,
  requestFrom,
  requestHeaderSql,
  tasksOfSql
} from '../lib/ddifWrite';
import type { DdifPrint, RequestHeader } from '../lib/ddifWrite';

export interface DdifRun {
  /** The class ran; false means the snippet never got as far as the first call. */
  ran: boolean;
  print: DdifPrint;
  /** The snippet report, trimmed to what explains a failure to run. */
  snippet?: Record<string, unknown>;
}

/**
 * What every tool that writes the dictionary through DDIF_* needs.
 *
 * The generated ABAP runs in a throwaway class (runSnippet's machinery), the
 * transport number is resolved before anything is generated, and the outcome
 * is read back from the tables rather than taken from the snippet's word for
 * it - a snippet that says "activated" is a claim, a row in DD02L is a fact.
 */
export abstract class DdifHandlerBase extends BaseHandler {
  protected readonly snippets: SnippetHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.snippets = new SnippetHandlers(client);
  }

  /** A DdifError is a refusal of the arguments, and is reported as one. */
  protected refuse(error: unknown): never {
    if (error instanceof DdifError) throw new McpError(ErrorCode.InvalidParams, error.message);
    throw error;
  }

  /** Rows of a SELECT, as objects. */
  protected async rows(sql: string, rowNumber = 100): Promise<Record<string, any>[]> {
    const startTime = performance.now();
    try {
      const result: any = await this.readClient.runQuery(sql, rowNumber);
      this.trackRequest(startTime, true);
      return Array.isArray(result?.values) ? result.values : [];
    } catch (error) {
      this.trackRequest(startTime, false);
      throw error;
    }
  }

  /**
   * The request to record the object in, or none for a local package.
   *
   * A task number is lifted to its request: RS_CORR_INSERT answers a task
   * with TK 886 and the write then goes through with nothing recorded.
   */
  protected async requestFor(
    packageName: string,
    transport: unknown
  ): Promise<{ request?: string; fromTask?: string }> {
    if (isLocalPackage(packageName)) return {};
    const given = String(transport ?? '').trim().toUpperCase();
    if (!given) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `A dictionary object in ${packageName} needs a transport request. Only a $ package goes without one.`
      );
    }
    try {
      const [header] = await this.rows(requestHeaderSql(given), 1);
      const parentNumber = String(header?.STRKORR ?? '').trim();
      const [parent] = parentNumber ? await this.rows(requestHeaderSql(parentNumber), 1) : [];
      return requestFrom(given, header as RequestHeader | undefined, parent as RequestHeader | undefined);
    } catch (error) {
      return this.refuse(error);
    }
  }

  /** Run the generated ABAP and read its steps back. */
  protected async runDdif(code: string[], exceptions: Record<string, string[]>): Promise<DdifRun> {
    const answer: any = await this.snippets.runSnippetCore({ code });
    const print = parseDdifPrint(String(answer?.output ?? ''), exceptions);
    if (answer?.ran === true) return { ran: true, print };
    return {
      ran: false,
      print,
      snippet: {
        steps: answer?.steps,
        ...(answer?.runError ? { runError: answer.runError } : {})
      }
    };
  }

  /**
   * Whether the object is recorded in the request or one of its tasks.
   *
   * Dictionary objects are written onto the request itself, not into a task -
   * either is fine for the transport, and the answer says which.
   */
  protected async recordedIn(
    objectType: string,
    name: string,
    request: string
  ): Promise<{ recorded: boolean; in?: string[]; error?: string }> {
    try {
      const entries = (await this.rows(recordedSql(objectType, name), 200))
        .map(row => String(row.TRKORR ?? '').trim());
      const tasks = (await this.rows(tasksOfSql(request), 200))
        .map(row => String(row.TRKORR ?? '').trim());
      const mine = new Set([request, ...tasks]);
      const hits = entries.filter(entry => mine.has(entry));
      return { recorded: hits.length > 0, ...(hits.length ? { in: hits } : {}) };
    } catch (error) {
      return { recorded: false, error: describeAdtError(error).error };
    }
  }
}
