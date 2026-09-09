import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { ObjectRegistrationHandlers } from './ObjectRegistrationHandlers.js';
import { describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { session_types } from 'abap-adt-api';
import type { ADTClient } from 'abap-adt-api';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { lockRegistry } from '../lib/lockRegistry';
import { buildSnippetClass, snippetClassName, snippetOutput, summariseDump, SnippetError } from '../lib/snippet';

/**
 * Running a piece of ABAP and reading what it printed.
 *
 * The system has no "evaluate this" endpoint, and runQuery only reads with
 * SELECT - so anything that needs logic (call this function module and show
 * what comes back, check what a class method does with this input, count what
 * a nested loop counts) had no answer through this server at all.
 *
 * What ADT does have is runClass: F9 on a class that implements
 * IF_OO_ADT_CLASSRUN. So the snippet is wrapped in such a class, created,
 * activated, run, and deleted again - and the class is deleted whichever step
 * failed, because the alternative is leaving throwaway classes behind.
 */
export class SnippetHandlers extends BaseHandler {
  private readonly registration: ObjectRegistrationHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.registration = new ObjectRegistrationHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'runSnippet',
        description: 'Run a piece of ABAP on the system and return what it printed. The snippet is wrapped in a throwaway class implementing IF_OO_ADT_CLASSRUN, created in $TMP, activated, executed with runClass and deleted again - which is the only way ADT executes ABAP at all. Write output with out->write( lv_x ) or out->write_text( `...` ); `out` is the console object the interface hands to main. It answers the questions no read can: what a function module returns for these inputs, what a class method does with this data, what a calculation comes to. It runs code on the target system as your user, so a snippet that writes changes data - it counts as a writing tool and is refused in read-only mode. On a syntax error the activation messages come back with the source, and the class is removed either way.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'array',
              description: 'The ABAP to run, line by line, as it would stand inside a method. `out` is available for output.',
              items: { type: 'string' }
            },
            declarations: {
              type: 'array',
              description: 'Class-level declarations the snippet needs: TYPES, CONSTANTS, DATA. They go into the private section.',
              items: { type: 'string' }
            },
            className: {
              type: 'string',
              description: 'Name for the throwaway class. Default: ZMCP_SNIP_<timestamp in base 36>.'
            },
            packageName: {
              type: 'string',
              description: 'Where to create it. Default $TMP, which needs no transport; anything else does.'
            },
            transport: {
              type: 'string',
              description: 'Transport request, needed only outside $TMP.'
            },
            keepClass: {
              type: 'boolean',
              description: 'Leave the class on the system instead of deleting it - for a snippet to run again or open in ADT. Default false.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Return the class source that would be created, without touching the system.'
            }
          },
          required: ['code']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'runSnippet':
        return this.handleRunSnippet(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown snippet tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  /**
   * The creation, as one line rather than as its whole nested report.
   *
   * createAndWrite answers with every step it took, which is right when it is
   * called on its own and about 4,000 characters of noise here - except for
   * the activation messages, which are the whole answer when a snippet does
   * not compile.
   */
  private summariseCreate(created: Record<string, any>): Record<string, unknown> {
    const activate = (created.steps || []).find((step: any) => step?.step === 'activate');
    const messages = (activate?.messages || [])
      .map((message: any) => ({
        type: message?.type,
        line: message?.line,
        text: message?.shortText,
        ...(message?.objDescr ? { where: message.objDescr } : {})
      }));
    return {
      step: 'create',
      created: created.created === true,
      written: created.written === true,
      activated: created.activated === true,
      ...(created.objectUrl ? { objectUrl: created.objectUrl } : {}),
      ...(messages.length ? { activationMessages: messages } : {}),
      ...(created.status === 'error' && !messages.length && created.hint ? { hint: created.hint } : {})
    };
  }

  /**
   * The dump a failed run left behind.
   *
   * runClass answers a runtime error with a bare 500 (ERR_BAD_RESPONSE), so
   * the reason the snippet died is nowhere in that answer - it is in ST22.
   * The dump feed has it, and the newest entry for this user, seen seconds
   * ago, is the one.
   */
  private async lastDump(): Promise<Record<string, unknown> | undefined> {
    try {
      const feed: any = await this.readClient.dumps();
      const dump = (feed?.dumps || [])[0];
      return summariseDump(dump) as Record<string, unknown> | undefined;
    } catch {
      // The feed is a courtesy; failing to read it must not replace the
      // original error with one about reading dumps.
      return undefined;
    }
  }

  private async deleteOnce(objectUrl: string): Promise<{ lockReleased: boolean }> {
    const lock = await takeLock(
      this.adtclient,
      objectUrl,
      undefined,
      (start, ok) => this.trackRequest(start, ok)
    );
    this.adtclient.stateful = session_types.stateful;
    await this.adtclient.deleteObject(objectUrl, lock.lockHandle);
    // Deleting does not release the lock, and the registry would keep
    // pointing at an object that is gone.
    const released = await releaseLock(this.adtclient, objectUrl, lock.lockHandle);
    return { lockReleased: released.released };
  }

  /**
   * Take the class off the system again, reporting rather than throwing.
   *
   * A dump takes the session with it: the run answers 500, and the next call
   * on that session is refused with a bare 400. That is exactly when the
   * clean-up matters, so a failed attempt logs on again and tries once more -
   * without that, every snippet that dumped left its class in $TMP.
   */
  private async removeClass(objectUrl: string): Promise<Record<string, unknown>> {
    try {
      const first = await this.deleteOnce(objectUrl);
      return { step: 'delete', deleted: true, lockReleased: first.lockReleased };
    } catch (error: any) {
      const firstError = describeAdtError(error).error;
      try {
        lockRegistry.forget(objectUrl);
        await this.adtclient.login();
        const second = await this.deleteOnce(objectUrl);
        return {
          step: 'delete',
          deleted: true,
          lockReleased: second.lockReleased,
          afterRelogin: true
        };
      } catch (retryError: any) {
        return {
          step: 'delete',
          deleted: false,
          error: describeAdtError(retryError).error,
          firstError,
          hint: `The class is still on the system: delete it with deleteObject on ${objectUrl}.`
        };
      }
    }
  }

  async handleRunSnippet(args: any): Promise<any> {
    const code = this.parseObjectArg<string[]>(args?.code, 'code');
    const declarations = this.parseObjectArg<string[]>(args?.declarations, 'declarations');
    const lines = Array.isArray(code) ? code : typeof code === 'string' ? [code] : [];
    if (lines.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass code - the ABAP to run, line by line.');
    }

    const className = String(args?.className || '').trim().toUpperCase() || snippetClassName();
    const packageName = String(args?.packageName || '$TMP').trim().toUpperCase();

    let source: string;
    try {
      source = buildSnippetClass({ className, code: lines, declarations });
    } catch (error: any) {
      if (error instanceof SnippetError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }

    if (args?.dryRun === true) {
      return this.answer({ status: 'success', dryRun: true, className, packageName, source });
    }

    const objectUrl = `/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}`;
    const steps: Record<string, unknown>[] = [];

    // Create, write and activate in one call: that handler carries the whole
    // lock cycle and the activation check.
    const result = await this.registration.handleCreateAndWrite({
      objtype: 'CLAS/OC',
      name: className,
      description: `MCP snippet ${className}`,
      packageName,
      source,
      transport: args?.transport
    });
    const created = JSON.parse(result.content[0].text);
    steps.push(this.summariseCreate(created));

    if (created.activated !== true) {
      // A snippet that does not compile is the common case, and the messages
      // are the answer. The class goes either way.
      const cleanup = created.created === true && args?.keepClass !== true
        ? await this.removeClass(objectUrl)
        : undefined;
      return this.answer({
        status: 'error',
        className,
        packageName,
        ran: false,
        steps: [...steps, ...(cleanup ? [cleanup] : [])],
        source,
        hint: 'The class was created but not activated, so nothing ran. The activation messages above name the line; correct the snippet and try again.'
      });
    }

    const startTime = performance.now();
    let output: string | undefined;
    let runError: Record<string, unknown> | undefined;
    try {
      const run = await this.adtclient.runClass(className);
      output = snippetOutput(run);
      this.trackRequest(startTime, true);
      steps.push({ step: 'run', ran: true, characters: output.length });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      // A dump or a raised exception arrives as a failed call: that message is
      // what the snippet did, not a broken tool.
      runError = describeAdtError(error) as unknown as Record<string, unknown>;
      // A runtime error comes back as a bare 500; the reason is in the dump.
      const dump = await this.lastDump();
      if (dump) runError.dump = dump;
      steps.push({ step: 'run', ran: false, error: runError.error });
    }

    const cleanup = args?.keepClass === true ? undefined : await this.removeClass(objectUrl);
    if (cleanup) steps.push(cleanup);

    return this.answer({
      status: runError ? 'error' : 'success',
      className,
      packageName,
      ran: !runError,
      ...(output !== undefined ? { output } : {}),
      ...(runError
        ? {
          runError,
          hint: runError.status === 500
            ? 'runClass answers a runtime error with a bare 500, so the reason is the dump above (ST22 has the full one).'
            : undefined
        }
        : {}),
      ...(args?.keepClass === true
        ? {
          kept: true,
          objectUrl,
          hint: 'The class was left on the system; remove it with deleteObject when you are done with it.'
        }
        : {}),
      steps
    });
  }
}
