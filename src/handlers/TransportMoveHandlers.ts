import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from '../types/tools';
import { DdifHandlerBase } from './DdifHandlerBase';
import { DdifError, failedStep } from '../lib/ddifWrite';
import {
  MAX_OBJECTS,
  entriesOfSql,
  headerEntries,
  headerEntriesSql,
  headerKeysSql,
  locksSql,
  moveToTaskSnippet,
  moveToken,
  selectEntries
} from '../lib/transportMove';
import type { HeaderEntry } from '../lib/transportMove';
import {
  TransportRegistrationError,
  chooseTask,
  diagnose,
  headerSql,
  tasksSql,
  transportNumber
} from '../lib/transportRegistration';
import type { TransportHeaderRow } from '../lib/transportRegistration';
import { requestArgument } from '../lib/transportHygiene';

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

/**
 * Moving objects that sit on a request's header into a task (SE09 by hand:
 * delete the entry, add it to the task).
 *
 * Two calls, like every write here that cannot be undone by the next call:
 * the first lists what is on the header and where it would go, with a token;
 * the second moves exactly that. lib/transportMove has the modules and why
 * the objects end up on the header in the first place.
 */
export class TransportMoveHandlers extends DdifHandlerBase {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'moveToTask',
        description: `Move objects recorded on a transport request itself into a task - the entries SE09 shows under the request but in nobody's task, where a task release does not cover them and they are easy to miss. Two calls. Without previewToken nothing is written: the answer lists the entries on the request header (with how many E071K keys each carries), which of them would move and into which task, and returns a previewToken. Called again with that token, it takes each entry off the request and appends it with its keys to the task (TR_DELETE_COMM_OBJECT_KEYS, then TR_APPEND_TO_COMM_OBJS_KEYS) in one database transaction - if the append fails, nothing was taken off - and reads E071 and TLOCK back. The task defaults to your own open task in the request. Entries on the header after a task was released got there by the release, which is normal; the preview says when the request has released tasks. At most ${MAX_OBJECTS} entries per call.`,
        inputSchema: {
          type: 'object',
          properties: {
            transport: { type: 'string', description: 'The request whose header holds the objects.' },
            task: {
              type: 'string',
              description: 'Task of that request to move them into. Defaults to your own open task in it.'
            },
            objects: {
              type: 'array',
              description: 'Which entries to move: [{pgmid, object, objName}], pgmid defaulting to R3TR. Omit to move every entry on the header.',
              items: {
                type: 'object',
                properties: {
                  pgmid: { type: 'string', description: 'R3TR (default) or LIMU.' },
                  object: { type: 'string', description: 'Object type, e.g. DOMA, TABL.' },
                  objName: { type: 'string', description: 'Object name.' }
                },
                required: ['object', 'objName']
              }
            },
            previewToken: {
              type: 'string',
              description: 'The token of the preview this move confirms. Omit it to get the preview.'
            }
          },
          required: ['transport']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'moveToTask':
        return this.handleMoveToTask(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown transport move tool: ${toolName}`);
    }
  }

  private invalid(error: unknown): never {
    if (error instanceof TransportRegistrationError || error instanceof DdifError) {
      throw new McpError(ErrorCode.InvalidParams, (error as Error).message);
    }
    throw error;
  }

  /** The request, its tasks, and the task the entries go into. */
  private async target(requestGiven: unknown, taskGiven: unknown) {
    let request: string;
    try {
      request = transportNumber(requestGiven);
    } catch (error) {
      return this.invalid(error);
    }
    const [header] = await this.rows(headerSql(request), 1) as TransportHeaderRow[];
    if (!header) throw new McpError(ErrorCode.InvalidParams, `${request} does not exist on this system.`);
    if (clean(header.STRKORR)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${request} is a task of ${clean(header.STRKORR)}. Pass the request: the objects to move sit on it, not on a task.`
      );
    }
    if (clean(header.TRSTATUS) !== 'D') {
      throw new McpError(ErrorCode.InvalidParams, `${request} is released (status ${clean(header.TRSTATUS) || 'unknown'}); nothing in it can be moved.`);
    }
    const tasks = await this.rows(tasksSql(request), 200) as TransportHeaderRow[];
    const user = String(this.adtclient.username || '');
    try {
      if (taskGiven !== undefined && String(taskGiven).trim()) {
        const task = transportNumber(taskGiven);
        const row = tasks.find(candidate => clean(candidate.TRKORR) === task);
        if (!row) throw new TransportRegistrationError(`${task} is not a task of ${request}.`);
        const choice = chooseTask(task, row, [], user);
        return { request, task: choice.task, tasks };
      }
      const choice = chooseTask(request, header, tasks, user);
      return { request, task: choice.task, tasks };
    } catch (error) {
      return this.invalid(error);
    }
  }

  private async header(request: string): Promise<HeaderEntry[]> {
    return headerEntries(
      await this.rows(headerEntriesSql(request), 5000),
      await this.rows(headerKeysSql(request), 5000)
    );
  }

  async handleMoveToTask(args: any): Promise<any> {
    const { request, task, tasks } = await this.target(requestArgument(args), args?.task);
    const header = await this.header(request);
    let entries: HeaderEntry[];
    try {
      entries = selectEntries(header, this.parseObjectArg(args?.objects, 'objects'));
    } catch (error) {
      return this.invalid(error);
    }
    const token = moveToken(request, task, entries);
    const released = tasks.filter(row => clean(row.TRSTATUS) !== 'D').map(row => clean(row.TRKORR));
    const view = (entry: HeaderEntry) => ({
      pgmid: entry.PGMID,
      object: entry.OBJECT,
      objName: entry.OBJ_NAME,
      ...(entry.OBJFUNC ? { function: entry.OBJFUNC } : {}),
      ...(entry.keys ? { keys: entry.keys } : {})
    });

    if (!args?.previewToken) {
      return this.answer({
        status: 'success',
        preview: true,
        moved: false,
        request,
        task,
        onHeader: header.length,
        toMove: entries.map(view),
        ...(released.length ? { releasedTasks: released } : {}),
        previewToken: token,
        hint: 'Nothing moved. Call again with this previewToken to move exactly these entries into ' + task + '.' +
          (released.length
            ? ` ${request} has released tasks (${released.join(', ')}); their objects were merged into the request by the release, which is normal - pass objects to move only the ones that never were in a task.`
            : '')
      });
    }

    if (String(args.previewToken).trim() !== token) {
      return this.answer({
        status: 'error',
        moved: false,
        request,
        task,
        hint: 'The previewToken does not match: the request header changed since the preview, or this is not the selection that was previewed. Nothing was moved - preview again.'
      });
    }

    let snippet;
    try {
      snippet = moveToTaskSnippet({ request, task, entries });
    } catch (error) {
      return this.invalid(error);
    }
    const run = await this.runDdif(snippet.code, snippet.exceptions);
    if (!run.ran) {
      return this.answer({
        status: 'error',
        moved: false,
        request,
        task,
        ...run.snippet,
        hint: 'The throwaway class did not get as far as running, so nothing was moved. The steps above say where it stopped.'
      });
    }

    const failed = failedStep(run.print);
    const after = await this.rows(entriesOfSql(request, task), 5000);
    const where = (entry: HeaderEntry) => after
      .filter(row => clean(row.PGMID) === entry.PGMID && clean(row.OBJECT) === entry.OBJECT && clean(row.OBJ_NAME) === entry.OBJ_NAME)
      .map(row => clean(row.TRKORR));
    const placed = entries.map(entry => ({ ...view(entry), in: where(entry) }));
    const notMoved = placed.filter(entry => !(entry.in.includes(task) && !entry.in.includes(request)));
    const locks = (await this.rows(locksSql(request, task), 5000)).map(row => ({
      object: clean(row.OBJECT),
      name: clean(row.HIKEY),
      on: clean(row.TRKORR)
    }));
    const locksOnRequest = locks.filter(lock => lock.on === request);

    let hint: string;
    if (failed?.step === 'read') {
      hint = `TR_READ_REQUEST refused ${request} (${failed.exception || `subrc ${failed.subrc}`}). Nothing was moved.`;
    } else if (failed?.step === 'find') {
      hint = `${failed.message} - somebody changed the request since the preview. Nothing was moved.`;
    } else if (failed?.step === 'take_off') {
      hint = `An entry could not be taken off the request (${failed.exception || `subrc ${failed.subrc}`}); rolled back, nothing was moved.`;
    } else if (failed?.step === 'append') {
      hint = `The task refused the entries (${failed.exception ? `${failed.exception}: ${diagnose(failed.exception)}` : `subrc ${failed.subrc}`}); rolled back` +
        (notMoved.some(entry => !entry.in.length) ? ' - but E071 no longer shows some of them anywhere. Check the request in SE09 now.' : ', nothing was moved.');
    } else if (failed) {
      hint = `Stopped at ${failed.step} (subrc ${failed.subrc}). Check the request in SE09.`;
    } else if (notMoved.length) {
      hint = `The snippet reported success, but E071 disagrees for ${notMoved.map(entry => `${entry.object} ${entry.objName}`).join(', ')}. Check the request in SE09.`;
    } else {
      hint = `Moved ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} from ${request} into ${task}.` +
        (locksOnRequest.length ? ` TLOCK still has ${locksOnRequest.length} on the request itself.` : '');
    }

    return this.answer({
      status: !failed && !notMoved.length ? 'success' : 'error',
      moved: !failed && !notMoved.length,
      request,
      task,
      entries: placed,
      locks,
      steps: run.print.steps,
      hint
    });
  }
}
