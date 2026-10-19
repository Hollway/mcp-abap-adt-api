import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from '../types/tools';
import { DdifHandlerBase } from './DdifHandlerBase';
import { describeAdtError } from '../lib/adtError';
import { trimUsageRow } from '../lib/usageReferences';
import { failedStep, isLocalPackage } from '../lib/ddifWrite';
import {
  DELETABLE_TABLE_CLASSES,
  ddicDeletionToken,
  ddicKind,
  ddicName,
  deleteDdicSnippet,
  directorySql,
  entriesSql,
  headerSql,
  kindInfo,
  requestEntries,
  rowsSql,
  usageSqls,
  withdrawal
} from '../lib/ddicDelete';
import type { DdicKind, DdicState } from '../lib/ddicDelete';
import { diagnose } from '../lib/transportRegistration';
import { requestArgument } from '../lib/transportHygiene';

/** Users listed per kind in the preview; the count covers them all. */
const SHOWN = 5;

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

/**
 * Deleting a domain, a data element, a table or a structure the SE11 way
 * (RS_DD_DELETE_OBJ), for the systems where ADT has no address for them.
 *
 * Two calls, like every deletion here: a preview of what is there, who uses
 * it, the rows a table holds, the requests it is recorded in and whether it
 * can be withdrawn instead - with a token; then the deletion of exactly that.
 * lib/ddicDelete has the module and what it does when it refuses.
 */
export class DdicDeletionHandlers extends DdifHandlerBase {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'deleteDdicObject',
        description: 'Delete a domain, data element, table or structure the way SE11 does (RS_DD_DELETE_OBJ) - for systems where ADT has no address for domains or tables, and deleteObject answers 404. Two calls. Without previewToken nothing is written: the answer shows the versions, who uses the object in the dictionary and in code, the rows of a transparent table in this client, the requests it is recorded in, and whether it can be withdrawn; it returns a previewToken. Called again with that token, it deletes. The module refuses rather than asks: an object that is still used, or a table holding data in any client, is not deleted (the snippet also counts the rows of every client first and stops on any). Outside a $ package the deletion is recorded in your task of the request. withdraw: true is for an object created in a request that is still open and never left this system - instead of recording a deletion it takes the object off its requests and removes its directory entry, so nothing travels and the task can be deleted. The deletion is proven from DD01L/DD04L/DD02L afterwards: the module returns without error from some refusals.',
        inputSchema: {
          type: 'object',
          properties: {
            objectType: {
              type: 'string',
              description: 'DOMA (domain), DTEL (data element) or TABL (table or structure). ADT types such as TABL/DT are taken too.'
            },
            name: { type: 'string', description: 'Name of the object.' },
            transport: {
              type: 'string',
              description: 'Transport request (or your task in it). Required outside a $ package; to withdraw it defaults to the open request holding the object.'
            },
            withdraw: {
              type: 'boolean',
              description: 'Take the object off its open requests and out of TADIR instead of recording a deletion. Only for an object that never left this system; the preview says whether it can.'
            },
            previewToken: {
              type: 'string',
              description: 'The token of the preview this deletion confirms. Omit it to get the preview.'
            }
          },
          required: ['objectType', 'name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'deleteDdicObject':
        return this.handleDeleteDdicObject(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown dictionary deletion tool: ${toolName}`);
    }
  }

  /** The object as the dictionary, TADIR and the requests have it now. */
  private async readState(kind: DdicKind, name: string, withRows: boolean): Promise<DdicState & { users: Record<string, string[]> }> {
    const versions = await this.rows(headerSql(kind, name), 10);
    const [directory] = await this.rows(directorySql(kind, name), 1);
    const entries = requestEntries(await this.rows(entriesSql(kind, name), 200));
    const usages: Record<string, number> = {};
    const users: Record<string, string[]> = {};
    for (const [key, sql] of Object.entries(usageSqls(kind, name))) {
      const rows = await this.rows(sql, 1000);
      usages[key] = rows.length;
      if (rows.length) users[key] = rows.slice(0, SHOWN).map(row => Object.values(row).map(clean).join('-'));
    }
    let rows: number | undefined;
    if (withRows) {
      try {
        const [count] = await this.rows(rowsSql(name), 1);
        rows = Number(count?.CNT ?? 0);
      } catch {
        rows = -1;
      }
    }
    return { kind, name, versions, directory, entries, usages, users, ...(rows !== undefined ? { rows } : {}) };
  }

  /** Where the object is used in code, by ADT's where-used. A failure is reported, not fatal. */
  private async codeUsages(kind: DdicKind, name: string) {
    // A domain is not an ABAP type: code reaches it only through its data
    // elements, which the dictionary usages already list. Asking ADT anyway
    // answered 500 on the release with no domain address.
    if (kind === 'DOMA') {
      return { sites: 0, note: 'A domain is not an ABAP type; code uses it only through the data elements listed under dictionary.' };
    }
    const url = `/sap/bc/adt/${kindInfo(kind).adtCollection}/${encodeURIComponent(name.toLowerCase())}`;
    try {
      const rows = await this.readClient.usageReferences(url);
      const sites = rows.filter(row => !!row.objectIdentifier);
      return { sites: sites.length, ...(sites.length ? { first: sites.slice(0, SHOWN).map(trimUsageRow) } : {}) };
    } catch (error) {
      return { error: describeAdtError(error).error };
    }
  }

  async handleDeleteDdicObject(args: any): Promise<any> {
    let kind: DdicKind;
    let name: string;
    try {
      kind = ddicKind(args?.objectType ?? args?.type);
      name = ddicName(kind, args?.name);
    } catch (error) {
      return this.refuse(error);
    }
    const withdraw = args?.withdraw === true;
    const refusal = (hint: string, extra: Record<string, unknown> = {}) =>
      this.answer({ status: 'error', deleted: false, objectType: kind, name, ...extra, hint });

    const versions = await this.rows(headerSql(kind, name), 10);
    if (!versions.length) return refusal(`There is no ${kindInfo(kind).what} ${name} in the dictionary.`);
    const tableClass = kind === 'TABL' ? clean(versions[0].TABCLASS) : '';
    if (kind === 'TABL' && !DELETABLE_TABLE_CLASSES.includes(tableClass)) {
      return refusal(`${name} is of table class ${tableClass || '(unknown)'}; this deletes transparent tables and structures only. Use SE11.`);
    }
    const transparent = tableClass === 'TRANSP';

    const state = await this.readState(kind, name, transparent);
    const packageName = clean(state.directory?.DEVCLASS);
    const withdrawable = withdrawal(state.entries, clean(state.directory?.SRCSYSTEM), packageName);
    const token = ddicDeletionToken(state, withdraw);
    const used = Object.values(state.usages).some(count => count > 0);

    if (!args?.previewToken) {
      const code = await this.codeUsages(kind, name);
      const blockers = [
        ...(used ? ['it is used in the dictionary'] : []),
        ...('sites' in code && code.sites ? ['it is used in code'] : []),
        ...(state.rows ? [`the table holds ${state.rows < 0 ? 'an uncounted number of' : state.rows} rows in this client`] : [])
      ];
      return this.answer({
        status: 'success',
        preview: true,
        deleted: false,
        objectType: kind,
        name,
        ...(tableClass ? { tableClass } : {}),
        packageName: packageName || '(no TADIR entry)',
        versions: state.versions.map(row => clean(row.AS4LOCAL)),
        usages: { dictionary: state.usages, ...(Object.keys(state.users).length ? { first: state.users } : {}), code },
        ...(state.rows !== undefined ? { rowsInThisClient: state.rows } : {}),
        transportEntries: state.entries,
        withdraw: withdrawable.possible
          ? { possible: true, requests: withdrawable.requests }
          : { possible: false, reason: withdrawable.reason },
        previewToken: token,
        hint: (blockers.length
          ? `RS_DD_DELETE_OBJ will refuse while ${blockers.join(' and ')} - it does not delete a used object or a table with data. `
          : '') +
          `Nothing deleted. Call again with this previewToken${withdraw ? ' and withdraw: true' : ''} to ${withdraw ? 'withdraw' : 'delete'} ${name}` +
          (withdraw && !withdrawable.possible ? ` - but it cannot be withdrawn: ${withdrawable.reason}` : '') +
          (!withdraw && !isLocalPackage(packageName) ? '; pass transport: the deletion is recorded in your task of that request.' : '.')
      });
    }

    if (String(args.previewToken).trim() !== token) {
      return refusal('The previewToken does not match: the object changed since the preview, or the preview was for another call (withdraw or not). Nothing was deleted - preview again.');
    }
    if (withdraw && !withdrawable.possible) return refusal(`It cannot be withdrawn: ${withdrawable.reason}`);
    if (!state.directory) return refusal(`${name} has no TADIR entry, so its package and transport are unknown. Delete it in SE11.`);

    const given = requestArgument(args) || (withdraw && withdrawable.requests.length === 1 ? withdrawable.requests[0] : undefined);
    const { request, fromTask } = await this.requestFor(packageName, given, `The ${kindInfo(kind).what} ${name} in ${packageName}`);

    let snippet;
    try {
      snippet = deleteDdicSnippet({ kind, name, packageName, request, countRows: transparent, withdraw });
    } catch (error) {
      return this.refuse(error);
    }
    const run = await this.runDdif(snippet.code, snippet.exceptions);
    const common = {
      objectType: kind,
      name,
      packageName,
      ...(request ? { request, ...(fromTask ? { fromTask } : {}) } : {}),
      ...(withdraw ? { withdraw: true } : {})
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
    const after = await this.readState(kind, name, false);
    const gone = after.versions.length === 0;
    const [directory] = await this.rows(directorySql(kind, name), 1);
    const deletionRecorded = after.entries.some(entry => entry.objfunc === 'D');
    const task = run.print.info.task || undefined;

    let hint: string;
    if (failed?.step === 'rows') {
      hint = `${failed.message}. Empty it first - deleting a table drops its data in every client.`;
    } else if (failed?.step === 'delete') {
      hint = failed.exception === 'DIALOG_NEEDED'
        ? `RS_DD_DELETE_OBJ refused: ${name} is still used, or the table holds data (${failed.message || 'E2/071'}). Nothing was deleted.`
        : `RS_DD_DELETE_OBJ refused (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}). Nothing was deleted.`;
    } else if (failed?.step === 'database') {
      hint = `${failed.message}. The dictionary definition is gone; the deletion of the database table did not run.`;
    } else if (failed?.step === 'verify') {
      hint = `${failed.message}. It refuses some objects without raising an exception - a table locked for conversion, a generated view. Check it in SE11.`;
    } else if (failed && withdraw) {
      hint = `Deleted, but withdrawing stopped at ${failed.step} (${failed.exception ? `${failed.exception}: ${diagnose(failed.exception)}` : `subrc ${failed.subrc}`}). The entries left are in transportEntries; they now record a deletion. Take them off in SE09 or let the deletion travel.`;
    } else if (failed) {
      hint = `Stopped at ${failed.step} (subrc ${failed.subrc}${failed.message ? `: ${failed.message}` : ''}). Check the object in SE11.`;
    } else if (!gone) {
      hint = `The snippet reported success, but ${name} is still in the dictionary. Check it in SE11.`;
    } else if (withdraw && (after.entries.length || directory)) {
      hint = `Deleted, but ${after.entries.length ? `${after.entries.length} request entries` : ''}${after.entries.length && directory ? ' and ' : ''}${directory ? 'the TADIR entry' : ''} remain. Check SE09 and SE03.`;
    } else if (withdraw) {
      hint = `Deleted and withdrawn: ${name} is off ${withdrawable.requests.join(', ')} and out of TADIR, so nothing travels.`;
    } else if (isLocalPackage(packageName)) {
      hint = directory
        ? `Deleted, but the TADIR entry is still there. Remove it in SE03.`
        : `Deleted ${name}; a local object, so nothing to transport.`;
    } else if (!deletionRecorded && kind === 'TABL') {
      hint = `Deleted, but no entry with function D was found for it - the next system keeps it. Check the request in SE09.`;
    } else {
      hint = `Deleted ${name}; the deletion is in ${task || request}${kind === 'TABL' ? '' : ' (marked as a deletion when the request is exported, as SE11 does for this type)'}.`;
    }

    // The definition is gone unless a step before the proof stopped it; what
    // failed after the proof (the database, the withdrawal) is a remainder.
    const deleted = gone && !(failed && ['rows', 'delete', 'verify'].includes(failed.step));
    return this.answer({
      status: deleted && !failed && !(withdraw && (after.entries.length || directory)) && !(isLocalPackage(packageName) && directory)
        ? 'success'
        : 'error',
      deleted,
      ...common,
      ...(task ? { task } : {}),
      transportEntries: after.entries,
      ...(directory
        ? { directory: { packageName: clean(directory.DEVCLASS), deletionFlag: clean(directory.DELFLAG) } }
        : {}),
      steps: run.print.steps,
      hint
    });
  }
}
