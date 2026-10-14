import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from '../types/tools';
import { DdifHandlerBase } from './DdifHandlerBase';
import { failedStep, isLocalPackage } from '../lib/ddifWrite';
import {
  createTransactionSnippet,
  deleteTransactionSnippet,
  directorySql,
  guiSql,
  packageSql,
  parametersSql,
  programFits,
  programSql,
  recordedSql,
  rolesSql,
  screenSql,
  textsSql,
  transactionCode,
  transactionSpec,
  transactionToken,
  tstcSql,
  variantSql
} from '../lib/transaction';
import { tasksSql } from '../lib/transportRegistration';
import { requestArgument } from '../lib/transportHygiene';

const clean = (value: unknown): string => String(value ?? '').trim().toUpperCase();

/** Roles listed in the preview; the count covers them all. */
const ROLES_SHOWN = 10;

/**
 * Transactions as SE93 makes and removes them (RPY_TRANSACTION_INSERT and
 * _DELETE), for a system whose ADT has no transaction editor. Creating is one
 * call with a dry run, as the other creators here; deleting is two, preview
 * and token, as every deletion here. lib/transaction has what the modules
 * check and what they leave to the caller.
 */
export class TransactionHandlers extends DdifHandlerBase {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'createTransaction',
        description: 'Create a transaction as SE93 does (RPY_TRANSACTION_INSERT) - ADT has no transaction editor here. type report starts an executable program on its selection screen, optionally with a variant; type dialog starts a program on a screen. The module itself checks nothing about the program, so this does first: the program must be active and of a fitting type (1 for a report, 1/M/F for a dialog), the screen must exist (1000 for a report), the variant must exist, and the code must be new and in the customer namespace (Y, Z or /NS/). Outside a $ package the transaction goes into your task of the request. GUI flags default to SAP GUI for Windows and HTML on, as SE93 proposes. dryRun runs the checks and returns the ABAP without writing.',
        inputSchema: {
          type: 'object',
          properties: {
            transaction: { type: 'string', description: 'Transaction code, up to 20 characters, e.g. ZAPP_REPORT.' },
            type: { type: 'string', enum: ['report', 'dialog'], description: 'report (default) or dialog.' },
            program: { type: 'string', description: 'The program the transaction starts.' },
            screen: { type: 'string', description: 'Dialog transactions: the screen number to start on. A report transaction always starts on 1000.' },
            variant: { type: 'string', description: 'Report transactions: a variant of the program to start with.' },
            shortText: { type: 'string', description: 'Title, up to 36 characters.' },
            packageName: { type: 'string', description: 'Package; $TMP for a local transaction.' },
            transport: { type: 'string', description: 'Transport request outside a $ package (a task number is lifted to its request).' },
            language: { type: 'string', description: 'Language of the title: SAP key (R) or ISO code (RU). Defaults to the logon language.' },
            winGui: { type: 'boolean', description: 'Runs in SAP GUI for Windows (default true).' },
            html: { type: 'boolean', description: 'Runs in SAP GUI for HTML (default true).' },
            dryRun: { type: 'boolean', description: 'Run the checks and return the ABAP that would run, writing nothing.' }
          },
          required: ['transaction', 'program', 'shortText', 'packageName']
        }
      },
      {
        name: 'deleteTransaction',
        description: 'Delete a transaction as SE93 does (RPY_TRANSACTION_DELETE). Two calls. Without previewToken nothing is written: the answer shows the transaction (program, screen, title, GUI flags), its package and requests, and the roles that still hand it out (AGR_TCODES) - deleting it leaves them pointing at nothing - and returns a previewToken. Called again with that token, it deletes; outside a $ package the deletion is recorded in your task of the request as R3TR TRAN, which the export then finds gone. A local transaction leaves no directory entry behind.',
        inputSchema: {
          type: 'object',
          properties: {
            transaction: { type: 'string', description: 'Transaction code.' },
            transport: { type: 'string', description: 'Transport request outside a $ package.' },
            previewToken: { type: 'string', description: 'The token of the preview this deletion confirms. Omit it to get the preview.' }
          },
          required: ['transaction']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'createTransaction':
        return this.handleCreateTransaction(args);
      case 'deleteTransaction':
        return this.handleDeleteTransaction(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown transaction tool: ${toolName}`);
    }
  }

  /** The transaction as TSTC, its texts, its GUI flags, TADIR and the requests have it. */
  private async readTransaction(code: string) {
    const [tstc] = await this.rows(tstcSql(code), 1);
    if (!tstc) return undefined;
    const [gui] = await this.rows(guiSql(code), 1);
    const [directory] = await this.rows(directorySql(code), 1);
    return {
      program: clean(tstc.PGMNA),
      screen: clean(tstc.DYPNO),
      texts: Object.fromEntries((await this.rows(textsSql(code), 50)).map(row => [clean(row.SPRSL), String(row.TTEXT ?? '').trim()])),
      parameters: (await this.rows(parametersSql(code), 5)).map(row => String(row.PARAM ?? '').trim()),
      ...(gui ? { gui: { html: clean(gui.S_WEBGUI), winGui: clean(gui.S_WIN32), java: clean(gui.S_PLATIN) } } : {}),
      packageName: clean(directory?.DEVCLASS),
      ...(directory ? { directory: { author: clean(directory.AUTHOR), deletionFlag: clean(directory.DELFLAG) } } : {}),
      entries: (await this.rows(recordedSql(code), 200)).map(row => ({ in: clean(row.TRKORR), function: clean(row.OBJFUNC) }))
    };
  }

  /** The entries of the transaction in the request or one of its tasks. */
  private async entriesIn(code: string, request: string) {
    const mine = new Set([request, ...(await this.rows(tasksSql(request), 200)).map(row => clean(row.TRKORR))]);
    return (await this.rows(recordedSql(code), 200))
      .map(row => ({ in: clean(row.TRKORR), function: clean(row.OBJFUNC) }))
      .filter(entry => mine.has(entry.in));
  }

  async handleCreateTransaction(args: any): Promise<any> {
    let spec;
    try {
      spec = transactionSpec(args);
    } catch (error) {
      return this.refuse(error);
    }
    const refusal = (hint: string) => this.answer({ status: 'error', created: false, transaction: spec.code, hint });

    if ((await this.rows(tstcSql(spec.code), 1)).length) return refusal(`${spec.code} exists already. Nothing was created.`);
    if (!spec.packageName) return refusal('Pass packageName: $TMP for a local transaction.');
    if (!isLocalPackage(spec.packageName) && !(await this.rows(packageSql(spec.packageName), 1)).length) {
      return refusal(`There is no package ${spec.packageName}.`);
    }
    const [program] = await this.rows(programSql(spec.program), 1);
    if (!program) return refusal(`There is no active program ${spec.program}. Activate it first, or check the name.`);
    const subc = clean(program.SUBC);
    if (!programFits(spec.kind, subc)) {
      return refusal(`${spec.program} is of type ${subc}; a ${spec.kind} transaction needs ${spec.kind === 'report' ? 'an executable program (1)' : 'type 1, M or F'}.`);
    }
    if (!(await this.rows(screenSql(spec.program, spec.screen), 1)).length) {
      return refusal(`${spec.program} has no screen ${spec.screen}${spec.kind === 'report' ? ' - a report transaction starts on the selection screen 1000, so the program needs PARAMETERS or SELECT-OPTIONS' : ''}.`);
    }
    if (spec.variant && !(await this.rows(variantSql(spec.program, spec.variant), 1)).length) {
      return refusal(`${spec.program} has no variant ${spec.variant}.`);
    }
    const { request, fromTask } = await this.requestFor(spec.packageName, requestArgument(args), `A transaction in ${spec.packageName}`);

    let snippet;
    try {
      snippet = createTransactionSnippet({ ...spec, ...(request ? { request } : {}) });
    } catch (error) {
      return this.refuse(error);
    }
    if (args?.dryRun === true) {
      return this.answer({ status: 'success', dryRun: true, created: false, transaction: spec.code, ...(request ? { request } : {}), code: snippet.code });
    }

    const run = await this.runDdif(snippet.code, snippet.exceptions);
    const common = {
      transaction: spec.code,
      type: spec.kind,
      program: spec.program,
      screen: spec.screen,
      packageName: spec.packageName,
      ...(request ? { request, ...(fromTask ? { fromTask } : {}) } : {})
    };
    if (!run.ran) {
      return this.answer({ status: 'error', created: false, ...common, ...run.snippet, hint: 'The throwaway class did not get as far as running, so nothing was created.' });
    }
    const failed = failedStep(run.print);
    const after = await this.readTransaction(spec.code);
    const recorded = request ? await this.entriesIn(spec.code, request) : [];

    let hint: string;
    if (failed?.step === 'insert') {
      hint = `RPY_TRANSACTION_INSERT refused (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}). Nothing was created.`;
    } else if (failed) {
      hint = `Stopped at ${failed.step} (${failed.message || `subrc ${failed.subrc}`}). It was rolled back.`;
    } else if (!after) {
      hint = `The snippet reported success, but TSTC has no ${spec.code}. Check SE93.`;
    } else if (request && !recorded.length) {
      hint = `Created, but ${spec.code} is in no task of ${request} - it stays on this system. Check SE09, or registerInTransport R3TR TRAN ${spec.code}.`;
    } else {
      hint = `Created ${spec.code}: ${spec.kind === 'report' ? `report transaction for ${spec.program}${spec.variant ? ` with variant ${spec.variant}` : ''}` : `dialog transaction for ${spec.program} screen ${spec.screen}`}` +
        (request ? `, recorded in ${recorded.map(entry => entry.in).join(', ')}.` : ', a local object.');
    }
    const created = !failed && !!after;
    return this.answer({
      status: created && !(request && !recorded.length) ? 'success' : 'error',
      created,
      ...common,
      ...(after ? { stored: after } : {}),
      ...(request ? { transportEntries: recorded } : {}),
      steps: run.print.steps,
      hint
    });
  }

  async handleDeleteTransaction(args: any): Promise<any> {
    let code: string;
    try {
      code = transactionCode(args?.transaction ?? args?.name);
    } catch (error) {
      return this.refuse(error);
    }
    const before = await this.readTransaction(code);
    if (!before) return this.answer({ status: 'error', deleted: false, transaction: code, hint: `There is no transaction ${code}.` });
    if (!before.directory) {
      return this.answer({ status: 'error', deleted: false, transaction: code, hint: `${code} has no TADIR entry - an SAP-internal or generated transaction. Not deleted here.` });
    }
    const roles = (await this.rows(rolesSql(code), 1000)).map(row => clean(row.AGR_NAME));
    const token = transactionToken({ code, before, roles });
    const packageName = before.packageName;

    if (!args?.previewToken) {
      return this.answer({
        status: 'success',
        preview: true,
        deleted: false,
        transaction: code,
        ...before,
        roles: { count: roles.length, ...(roles.length ? { first: roles.slice(0, ROLES_SHOWN) } : {}) },
        previewToken: token,
        hint: (roles.length ? `${roles.length} role(s) still hand ${code} out; they keep the entry after the deletion. ` : '') +
          `Nothing deleted. Call again with this previewToken to delete ${code}` +
          (isLocalPackage(packageName) ? '.' : '; pass transport: the deletion is recorded in your task of that request.')
      });
    }
    if (String(args.previewToken).trim() !== token) {
      return this.answer({
        status: 'error',
        deleted: false,
        transaction: code,
        hint: 'The previewToken does not match: the transaction or the roles changed since the preview. Nothing was deleted - preview again.'
      });
    }
    const { request, fromTask } = await this.requestFor(packageName, requestArgument(args), `Transaction ${code} in ${packageName}`);

    let snippet;
    try {
      snippet = deleteTransactionSnippet({ code, packageName, ...(request ? { request } : {}) });
    } catch (error) {
      return this.refuse(error);
    }
    const run = await this.runDdif(snippet.code, snippet.exceptions);
    const common = { transaction: code, packageName, ...(request ? { request, ...(fromTask ? { fromTask } : {}) } : {}) };
    if (!run.ran) {
      return this.answer({ status: 'error', deleted: false, ...common, ...run.snippet, hint: 'The throwaway class did not get as far as running, so nothing was deleted.' });
    }
    const failed = failedStep(run.print);
    const after = await this.readTransaction(code);
    const [directory] = await this.rows(directorySql(code), 1);
    const recorded = request ? await this.entriesIn(code, request) : [];

    let hint: string;
    if (failed?.step === 'delete') {
      hint = `RPY_TRANSACTION_DELETE refused (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}). Nothing was deleted.`;
    } else if (failed?.step === 'verify') {
      hint = `${failed.message}; rolled back. Nothing was deleted.`;
    } else if (after) {
      hint = `The snippet reported success, but TSTC still holds ${code}. Check SE93.`;
    } else if (isLocalPackage(packageName) && directory) {
      hint = `Deleted, but the TADIR entry is still there${failed ? ` (${failed.step}: ${failed.message || `subrc ${failed.subrc}`})` : ''}. Remove it in SE03.`;
    } else if (request && !recorded.length) {
      hint = `Deleted, but ${code} is in no task of ${request} - the next system keeps it. Check SE09.`;
    } else {
      hint = `Deleted ${code}` + (request ? `; recorded in ${recorded.map(entry => entry.in).join(', ')}.` : '; a local object, so nothing to transport.') +
        (roles.length ? ` ${roles.length} role(s) still list it.` : '');
    }
    const deleted = !after && failed?.step !== 'delete' && failed?.step !== 'verify';
    return this.answer({
      status: deleted && !(isLocalPackage(packageName) && directory) && !(request && !recorded.length) ? 'success' : 'error',
      deleted,
      ...common,
      ...(request ? { transportEntries: recorded } : {}),
      ...(directory ? { directory: { packageName: clean(directory.DEVCLASS), deletionFlag: clean(directory.DELFLAG) } } : {}),
      steps: run.print.steps,
      hint
    });
  }
}
