import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from '../types/tools';
import { DdifHandlerBase } from './DdifHandlerBase';
import { describeAdtError } from '../lib/adtError';
import { messageClassUrl, messageUrl } from '../lib/messageClass';
import { trimUsageRow } from '../lib/usageReferences';
import { failedStep } from '../lib/ddifWrite';
import {
  MAX_NUMBERS,
  MAX_USAGE_LOOKUPS,
  authorsSql,
  classExistsSql,
  classPackageSql,
  deleteMessagesSnippet,
  deletionToken,
  expectedCounts,
  longTextsSql,
  messageClassName,
  messageNumbers,
  messageState,
  recordedSql,
  supplementsSql,
  textsSql,
  transportName,
  wholeClassSql
} from '../lib/messageDelete';
import type { MessageState } from '../lib/messageDelete';
import {
  TransportRegistrationError,
  chooseTask,
  diagnose,
  headerSql,
  isLocalPackage,
  tasksSql,
  transportNumber
} from '../lib/transportRegistration';
import type { TransportHeaderRow } from '../lib/transportRegistration';
import { requestArgument } from '../lib/transportHygiene';

/** Usage sites listed per message in the preview; the count covers them all. */
const SITES_SHOWN = 5;

/**
 * Deleting messages from a message class (SE91's delete).
 *
 * setMessages adds and changes, and nothing in ADT removes a message - the
 * class document is upserted by number. This does what SE91 does, in two
 * calls: the first shows what would go (every language of the text, the long
 * text, where the message is used) and hands out a token; the second deletes
 * exactly that, and only if nothing changed in between. lib/messageDelete has
 * the tables and the order.
 */
export class MessageDeletionHandlers extends DdifHandlerBase {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'deleteMessages',
        description: `Delete messages from a message class, as SE91 does - the one thing setMessages cannot do. Two calls. Without previewToken nothing is written: the answer shows each message in every language, its long text, and where it is used (where-used per number, plus code that raises messages of the class with the number in a variable, which a per-number search cannot see), and returns a previewToken. Called again with that token, it deletes exactly those messages - T100 in every language, T100U, T100X and the long text (DOKHL/DOKTL/DOKIL) - under the SE91 lock and in one database transaction, so a failed step leaves everything as it was. Outside a $ package the deletion is recorded in your own task of the request as LIMU MESS <class><number> with function D, which is what makes the import delete the message in the next system. A token from another preview, or one taken before somebody changed these messages, is refused. At most ${MAX_NUMBERS} numbers per call. Usages are shown, not enforced: deleting a message that code still raises leaves that code showing a bare class and number.`,
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'Message class, e.g. ZAPP_NOCOND.' },
            numbers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Message numbers to delete, e.g. ["007","012"]. Leading zeros are added for you.'
            },
            transport: {
              type: 'string',
              description: 'Transport request (or your task in it). Required outside a $ package; your own open task in the request records the deletion.'
            },
            previewToken: {
              type: 'string',
              description: 'The token of the preview this deletion confirms. Omit it to get the preview.'
            }
          },
          required: ['className', 'numbers']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'deleteMessages':
        return this.handleDeleteMessages(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown message deletion tool: ${toolName}`);
    }
  }

  private async rowsOf(queries: string[]): Promise<Record<string, any>[]> {
    const all: Record<string, any>[] = [];
    for (const query of queries) all.push(...(await this.rows(query, 5000)));
    return all;
  }

  /** The messages as the tables have them now. */
  private async readState(className: string, numbers: string[]): Promise<MessageState> {
    return messageState(className, {
      texts: await this.rowsOf(textsSql(className, numbers)),
      authors: await this.rowsOf(authorsSql(className, numbers)),
      supplements: await this.rowsOf(supplementsSql(className, numbers)),
      longTexts: await this.rowsOf(longTextsSql(className, numbers))
    });
  }

  /**
   * Where the messages are used, for the preview.
   *
   * Per number, the backend answers with the sites that name it. Code that
   * raises a message of the class with the number in a variable names the
   * class alone, so it is found by asking about the class and keeping the
   * sites without a number. A failed lookup is reported, not fatal: the
   * preview is still worth having without it.
   */
  private async usagesOf(className: string, numbers: string[]) {
    const perNumber: Record<string, unknown> = {};
    for (const number of numbers.slice(0, MAX_USAGE_LOOKUPS)) {
      try {
        const rows = await this.readClient.usageReferences(messageUrl(className, number));
        const sites = rows.filter(row => !!row.objectIdentifier);
        perNumber[number] = {
          sites: sites.length,
          ...(sites.length ? { first: sites.slice(0, SITES_SHOWN).map(trimUsageRow) } : {})
        };
      } catch (error) {
        perNumber[number] = { error: describeAdtError(error).error };
      }
    }
    let byVariable: unknown;
    try {
      const rows = await this.readClient.usageReferences(messageClassUrl(className));
      const sites = rows.filter(row => !!row.objectIdentifier && !/\\MN:/i.test(String(row.objectIdentifier)));
      byVariable = {
        sites: sites.length,
        ...(sites.length ? { first: sites.slice(0, SITES_SHOWN).map(trimUsageRow) } : {})
      };
    } catch (error) {
      byVariable = { error: describeAdtError(error).error };
    }
    return {
      perNumber,
      ...(numbers.length > MAX_USAGE_LOOKUPS
        ? { notLookedUp: numbers.slice(MAX_USAGE_LOOKUPS) }
        : {}),
      numberInVariable: byVariable
    };
  }

  /** The caller's own task in the request, for a transportable class. */
  private async taskFor(className: string, packageName: string, transport: unknown) {
    if (isLocalPackage(packageName)) return undefined;
    const given = String(transport ?? '').trim();
    if (!given) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${className} is in package ${packageName || '(unknown)'}, so the deletion has to be recorded in a transport request. Pass transport.`
      );
    }
    try {
      const number = transportNumber(given);
      const [header] = await this.rows(headerSql(number), 1);
      const tasks = header && !String(header.STRKORR ?? '').trim() ? await this.rows(tasksSql(number), 200) : [];
      return chooseTask(
        number,
        header as TransportHeaderRow | undefined,
        tasks as TransportHeaderRow[],
        String(this.adtclient.username || '')
      );
    } catch (error) {
      if (error instanceof TransportRegistrationError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }
  }

  async handleDeleteMessages(args: any): Promise<any> {
    let className: string;
    let numbers: string[];
    try {
      className = messageClassName(args?.className ?? args?.name);
      numbers = messageNumbers(args?.numbers ?? args?.number);
    } catch (error) {
      return this.refuse(error);
    }
    const refusal = (hint: string, extra: Record<string, unknown> = {}) =>
      this.answer({ status: 'error', deleted: false, className, ...extra, hint });

    if (!(await this.rows(classExistsSql(className), 1)).length) {
      return refusal(`There is no message class ${className}.`);
    }
    const [directory] = await this.rows(classPackageSql(className), 1);
    const packageName = String(directory?.DEVCLASS ?? '').trim();
    const state = await this.readState(className, numbers);
    const missing = numbers.filter(number => !state.texts[number]);
    if (missing.length) {
      return refusal(
        `${className} has no message ${missing.join(', ')}. Nothing was deleted; pass only numbers that exist (getMessages lists them).`,
        { notFound: missing }
      );
    }

    const token = deletionToken(className, numbers, state);
    const messages = numbers.map(number => ({
      number,
      texts: state.texts[number],
      ...(state.authors[number] ? state.authors[number] : {}),
      ...(state.longTexts[number] ? { documentation: state.longTexts[number] } : {})
    }));

    if (!args?.previewToken) {
      return this.answer({
        status: 'success',
        preview: true,
        deleted: false,
        className,
        packageName,
        messages,
        usages: await this.usagesOf(className, numbers),
        ...(isLocalPackage(packageName)
          ? {}
          : {
            transportEntries: numbers.map(number => `LIMU MESS ${transportName(className, number)} (function D)`),
            transportNote: `If the request already carries R3TR MSAG ${className}, the class travels whole and these entries are not added - the module takes them and writes none.`
          }),
        previewToken: token,
        hint: 'Nothing deleted. Call again with this previewToken to delete exactly these messages' +
          (isLocalPackage(packageName) ? '.' : ', and pass transport: the deletion is recorded in your task of that request.')
      });
    }

    if (String(args.previewToken).trim() !== token) {
      return refusal(
        'The previewToken does not match: these messages changed since the preview, or this is not the list that was previewed. Nothing was deleted - preview again.'
      );
    }
    const choice = await this.taskFor(className, packageName, requestArgument(args));

    let snippet;
    try {
      snippet = deleteMessagesSnippet({
        className,
        numbers,
        task: choice?.task,
        expected: expectedCounts(state)
      });
    } catch (error) {
      return this.refuse(error);
    }
    const run = await this.runDdif(snippet.code, snippet.exceptions);
    const common = {
      className,
      packageName,
      numbers,
      ...(choice ? { task: choice.task, ...(choice.request ? { request: choice.request } : {}) } : {})
    };
    if (!run.ran) {
      return this.answer({
        status: 'error',
        deleted: false,
        ...common,
        ...run.snippet,
        hint: 'The throwaway class did not get as far as running, so nothing was deleted. The steps above say where it stopped.'
      });
    }

    const failed = failedStep(run.print);
    const after = await this.readState(className, numbers);
    const left = numbers.filter(number => after.texts[number] || after.longTexts[number]);
    const recorded = choice
      ? (await this.rowsOf(recordedSql(choice.task, className, numbers)))
        .map(row => ({ name: String(row.OBJ_NAME ?? '').trim(), function: String(row.OBJFUNC ?? '').trim() }))
      : [];
    // The whole class in this request or one of its tasks covers its parts:
    // the module then writes no LIMU entries, and the deletion travels with it.
    let wholeClassIn: string[] = [];
    if (choice) {
      const request = choice.request || choice.task;
      const mine = new Set([
        request,
        ...(await this.rows(tasksSql(request), 200)).map(row => String(row.TRKORR ?? '').trim())
      ]);
      wholeClassIn = (await this.rows(wholeClassSql(className), 200))
        .map(row => String(row.TRKORR ?? '').trim())
        .filter(number => mine.has(number));
    }
    const unrecorded = choice && !wholeClassIn.length
      ? numbers.filter(number => !recorded.some(entry => entry.name === transportName(className, number) && entry.function === 'D'))
      : [];
    const counts = Object.fromEntries(
      ['texts', 'authors', 'supplements', 'docHeaders', 'docLines', 'docIndex']
        .filter(key => run.print.info[key] !== undefined)
        .map(key => [key, Number(run.print.info[key])])
    );

    let hint: string;
    if (failed?.step === 'enqueue') {
      hint = `${className} is locked (${failed.exception || `subrc ${failed.subrc}`}) - somebody has it open in SE91 or ADT, or this server holds a lock on it (listLocks, then unLock). Nothing was deleted.`;
    } else if (failed?.step === 'compare') {
      hint = `The messages changed between the preview and the delete (${failed.message}). Nothing was deleted - preview again.`;
    } else if (failed?.step === 'transport') {
      hint = `The task refused the entries (${failed.exception ? `${failed.exception}: ${diagnose(failed.exception)}` : `subrc ${failed.subrc}`}). Nothing was deleted.`;
    } else if (failed?.step === 'verify') {
      hint = `The delete did not take (${failed.message}); it was rolled back. Nothing was deleted.`;
    } else if (failed) {
      hint = `Stopped at ${failed.step} (subrc ${failed.subrc}${failed.message ? `: ${failed.message}` : ''}). Check the class with getMessages.`;
    } else if (left.length) {
      hint = `The snippet reported success, but ${left.join(', ')} ${left.length > 1 ? 'are' : 'is'} still there. Check the class in SE91.`;
    } else if (unrecorded.length) {
      hint = `Deleted, but no LIMU MESS entry with function D was found in ${choice?.task} for ${unrecorded.join(', ')} - the next system keeps ${unrecorded.length > 1 ? 'them' : 'it'}. Check the task in SE09.`;
    } else {
      hint = `Deleted ${numbers.join(', ')} with their texts in every language${counts.docHeaders ? ' and their long texts' : ''}` +
        (!choice
          ? '; a local class, so nothing to transport.'
          : wholeClassIn.length && !recorded.length
            ? `; the request already carries the whole class (R3TR MSAG ${className} in ${wholeClassIn.join(', ')}), so the class travels whole and no LIMU entries were added.`
            : `; recorded in task ${choice.task}${choice.request ? ` of ${choice.request}` : ''}.`);
    }

    const clean = !failed && left.length === 0 && unrecorded.length === 0;
    return this.answer({
      status: clean ? 'success' : 'error',
      deleted: !failed && left.length === 0,
      ...common,
      ...(Object.keys(counts).length ? { rowsDeleted: counts } : {}),
      ...(left.length ? { stillThere: left } : {}),
      ...(choice ? { transportEntries: recorded } : {}),
      ...(wholeClassIn.length ? { wholeClassIn } : {}),
      steps: run.print.steps,
      hint
    });
  }
}
