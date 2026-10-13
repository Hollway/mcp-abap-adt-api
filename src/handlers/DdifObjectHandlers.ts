import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { session_types } from 'abap-adt-api';
import type { ToolDefinition } from '../types/tools';
import { DdifHandlerBase } from './DdifHandlerBase';
import { describeAdtError, wrapAdtError } from '../lib/adtError';
import {
  activationVerdict,
  directorySql,
  failedStep,
  isLocalPackage,
  packageExistsSql,
  packageName as checkedPackage
} from '../lib/ddifWrite';
import { chunkedQueries } from '../lib/queryLimits';
import {
  TABLE_DEFAULTS,
  activeDataElementsPrefix,
  activeFieldsSql,
  appendsSql,
  changeTableSnippet,
  checkTableOfSql,
  createTableSnippet,
  foreignKeyFieldsSql,
  indexFieldsSql,
  parseColumns,
  planFieldChange,
  previewToken,
  searchHelpFieldsSql,
  tableFields,
  tableName,
  tableVersionsSql,
  technicalSettingsSql
} from '../lib/tableDdif';
import type { CurrentField, FieldChange, TableFieldSpec } from '../lib/tableDdif';
import {
  LOCAL_COMPONENT,
  TRANSPORTABLE_COMPONENT,
  TRANSPORTABLE_LAYER,
  packageDdifSnippet,
  packageRowSql
} from '../lib/packageDdif';

const isNotServed = (error: any): boolean =>
  Number(error?.response?.status ?? error?.status) === 404;

/**
 * Dictionary and workbench objects that ADT cannot create on every release,
 * written the way SE11 and SE21 write them - through their own APIs, in a
 * throwaway class (see lib/ddifWrite).
 *
 * Each tool checks before it writes (name free, package and request usable)
 * and reads the result back from the tables afterwards, so the answer is what
 * the system holds rather than what the generated ABAP said it did.
 */
export class DdifObjectHandlers extends DdifHandlerBase {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'createPackage',
        description: 'Create a development package. ADT is tried first; on a release that serves no /sap/bc/adt/packages (404) the package is created the way SE21 does it - CL_PACKAGE_FACTORY create, save, release - in a throwaway class, and the answer says which way it went in "via". A transportable package always gets software component HOME and transport layer Z*; a $ package is local (LOCAL, no layer, no request). Checked first: the name is free, the super package exists and is of the same kind (local under local), the request is an open workbench request - a task number is lifted to its request, and the package entry lands in your own task of it. Read back afterwards: TDEVC, TADIR and the request entry.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Package name, e.g. ZAPP_CORE, or $ZAPP for a local one.' },
            description: { type: 'string', description: 'Short description, up to 60 characters.' },
            superPackage: { type: 'string', description: 'The package it goes under. Omit for a top-level package.' },
            transport: {
              type: 'string',
              description: 'Transport request for a transportable package; a task number is lifted to its request. Not needed for a $ package.'
            },
            language: {
              type: 'string',
              description: 'Master language: the one-character SAP key (R) or the ISO code (RU). Defaults to the logon language.'
            },
            dryRun: { type: 'boolean', description: 'Run the checks and show what would be created, writing nothing.' }
          },
          required: ['name', 'description']
        }
      },
      {
        name: 'createTable',
        description: 'Create a transparent table the way SE11 does - RS_CORR_INSERT, DDIF_TABL_PUT with header, technical settings and fields, DDIF_TABL_ACTIVATE - in a throwaway class. ADT cannot do this on every release (no /ddic/tables), and its DDL text carries no table class or technical settings at all. Defaults, when not passed: client-dependent with MANDT added as the first key field, delivery class A, maintenance allowed, data class APPL2, size category 0, no buffering, not extensible. Checked first: the name is free, every data element exists and is active, the key fields come first, the package and request are usable (a task number is lifted to its request; the entry lands in your own task). Read back afterwards: DD02L/DD09L, every column in the database itself (ADBC), TADIR and the request entry.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Table name, up to 16 characters, e.g. ZAPP_LOG.' },
            description: { type: 'string', description: 'Short description, up to 60 characters.' },
            packageName: { type: 'string', description: 'Development package; $TMP needs no request.' },
            transport: { type: 'string', description: 'Transport request outside a $ package; a task number is lifted to its request.' },
            fields: {
              type: 'array',
              description: 'The fields in order, key fields first: [{name, dataElement, key}]. MANDT is added in front of a client-dependent table when missing.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  dataElement: { type: 'string' },
                  key: { type: 'boolean' }
                },
                required: ['name', 'dataElement']
              }
            },
            clientDependent: { type: 'boolean', description: 'Default true.' },
            deliveryClass: { type: 'string', description: 'A (default), C, L, G, E, S or W.', enum: ['A', 'C', 'L', 'G', 'E', 'S', 'W'] },
            dataMaintenance: { type: 'string', description: 'SE16/SM30 maintenance: allowed (default), restricted, none.', enum: ['allowed', 'restricted', 'none'] },
            dataClass: { type: 'string', description: 'APPL0, APPL1, APPL2 (default) or a USER class.' },
            sizeCategory: { type: 'number', description: '0 (default) to 9.' },
            buffering: { type: 'string', description: 'none (default) or allowedOff (allowed but switched off).', enum: ['none', 'allowedOff'] },
            enhancementCategory: {
              type: 'string',
              description: 'notExtensible (default), characterLike, characterOrNumeric, any, notClassified.',
              enum: ['notExtensible', 'characterLike', 'characterOrNumeric', 'any', 'notClassified']
            },
            language: { type: 'string', description: 'Language of the texts: SAP key (R) or ISO code (RU). Defaults to the logon language.' },
            activate: { type: 'boolean', description: 'Activate at the end, which creates the table in the database (default true).' },
            dryRun: { type: 'boolean', description: 'Run the checks and return the ABAP that would run, writing nothing.' }
          },
          required: ['name', 'description', 'packageName', 'fields']
        }
      },
      {
        name: 'changeTableFields',
        description: 'Add or remove fields of a transparent table, in two calls. The first (no previewToken) writes nothing: it reads the table, checks the change and answers with the new field list and a previewToken. The second, with that token, writes - and only if the table and the change are exactly what was previewed. The write reads the whole definition with DDIF_TABL_GET and puts it back with only the field list changed, so the table class, technical settings, foreign keys and search help assignments stay as they are (ADT cannot do this: it serves a table as structure DDL, and writing that back turns the table into a structure). A table with data takes only new non-key fields; removing a field or adding a key field needs a table empty in every client, which the write checks again itself. Refused outright: includes or appends, the client field, a field used by a foreign key, an index or a search help. If the activation fails (for instance because the change would need a conversion) the definition read before is written back and activated, so the table is left as it was; conversions are SE14 work. Afterwards every added and removed column is checked in the database itself.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The table.' },
            add: {
              type: 'array',
              description: 'Fields to add: [{name, dataElement, key, after, afterKey}]. Without after/afterKey a non-key field goes to the end and a key field to the end of the key.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  dataElement: { type: 'string' },
                  key: { type: 'boolean' },
                  after: { type: 'string', description: 'Put it right after this field.' },
                  afterKey: { type: 'boolean', description: 'Put it right after the last key field.' }
                },
                required: ['name', 'dataElement']
              }
            },
            remove: { type: 'array', description: 'Names of the fields to remove.', items: { type: 'string' } },
            previewToken: { type: 'string', description: 'The token of the preview this write confirms. Omit it to get the preview.' },
            transport: { type: 'string', description: 'Transport request outside a $ package; a task number is lifted to its request.' },
            language: { type: 'string', description: 'Language for the texts read with the definition. Defaults to the logon language.' }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'createPackage':
        return this.handleCreatePackage(args);
      case 'createTable':
        return this.handleCreateTable(args);
      case 'changeTableFields':
        return this.handleChangeTableFields(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown DDIF tool: ${toolName}`);
    }
  }

  async handleCreatePackage(args: any): Promise<any> {
    let name: string;
    let superPackage = '';
    try {
      name = checkedPackage(args?.name);
      if (args?.superPackage) superPackage = checkedPackage(args.superPackage);
    } catch (error) {
      return this.refuse(error);
    }
    const description = String(args?.description ?? '').trim();
    if (!description) throw new McpError(ErrorCode.InvalidParams, 'Pass a description - a package without one cannot be saved.');
    const local = isLocalPackage(name);

    const [existing] = await this.rows(packageRowSql(name), 1);
    if (existing) {
      return this.answer({
        status: 'error',
        created: false,
        name,
        hint: `${name} already exists${existing.PARENTCL ? ` under ${String(existing.PARENTCL).trim()}` : ''}. Nothing was written.`
      });
    }
    if (superPackage) {
      const [parent] = await this.rows(packageRowSql(superPackage), 1);
      if (!parent) throw new McpError(ErrorCode.InvalidParams, `There is no package ${superPackage} on this system.`);
      if (isLocalPackage(superPackage) !== local) {
        throw new McpError(
          ErrorCode.InvalidParams,
          local
            ? `${name} is local, so it cannot go under the transportable package ${superPackage}.`
            : `${name} is transportable, so it cannot go under the local package ${superPackage}.`
        );
      }
    }
    const { request, fromTask } = await this.requestFor(
      local ? '$' : name,
      args?.transport,
      `The transportable package ${name}`
    );

    const softwareComponent = local ? LOCAL_COMPONENT : TRANSPORTABLE_COMPONENT;
    const transportLayer = local ? undefined : TRANSPORTABLE_LAYER;
    const common = {
      name,
      ...(superPackage ? { superPackage } : {}),
      softwareComponent,
      ...(transportLayer ? { transportLayer } : {}),
      ...(request ? { request } : {}),
      ...(fromTask ? { requestFromTask: fromTask } : {})
    };

    let snippet;
    try {
      snippet = packageDdifSnippet({ name, description, superPackage, request, language: args?.language });
    } catch (error) {
      return this.refuse(error);
    }
    if (args?.dryRun === true) {
      return this.answer({
        status: 'success',
        dryRun: true,
        created: false,
        ...common,
        code: snippet.code,
        note: 'The checks passed and nothing was written. ADT is tried first; this ABAP is the way taken when it answers 404.'
      });
    }

    // ADT first: where /sap/bc/adt/packages is served, that is the supported way.
    const adt = await this.createThroughAdt(name, description, superPackage, request, softwareComponent, transportLayer);
    let via: 'adt' | 'ddif' = 'adt';
    let steps: unknown[] | undefined;
    let failed: { step: string; message?: string; subrc: number } | undefined;
    if (adt.notServed) {
      via = 'ddif';
      const run = await this.runDdif(snippet.code, snippet.exceptions);
      if (!run.ran) {
        return this.answer({
          status: 'error',
          via,
          created: false,
          ...common,
          ...run.snippet,
          hint: 'The throwaway class did not get as far as running, so nothing was written. The steps above say where it stopped.'
        });
      }
      steps = run.print.steps;
      failed = failedStep(run.print);
    } else if (adt.error) {
      throw wrapAdtError(adt.error, `Failed to create package ${name}`);
    }

    const [row] = await this.rows(packageRowSql(name), 1);
    const [entry] = await this.rows(directorySql('DEVC', name), 1);
    const recorded = request ? await this.recordedIn('DEVC', name, request) : undefined;

    let hint: string;
    if (!row) {
      hint = failed
        ? `The package was not created: ${failed.step} failed${failed.message ? ` (${failed.message})` : ` (subrc ${failed.subrc})`}.`
        : 'No TDEVC row was found for the package afterwards - check it in SE21.';
    } else if (failed) {
      hint = `TDEVC has the package, but ${failed.step} failed${failed.message ? ` (${failed.message})` : ''}. Check it in SE21${failed.step === 'unlock' ? ' - it may still be locked to you' : ''}.`;
    } else if (recorded && !recorded.recorded) {
      hint = `Created, but no entry for R3TR DEVC ${name} was found in ${request} or its tasks - check the request before releasing it.`;
    } else {
      hint = `Created${request ? ` and recorded in ${recorded?.in?.join(', ') || request}` : ' as a local package'}.`;
    }

    return this.answer({
      status: row && !failed ? 'success' : 'error',
      via,
      created: !!row,
      ...common,
      ...(steps ? { steps } : {}),
      tdevc: row || null,
      directoryPackage: entry ? String(entry.DEVCLASS ?? '').trim() : null,
      ...(recorded ? { requestEntry: recorded } : {}),
      hint
    });
  }

  /** The ADT creation, reporting a 404 as "not served" rather than as an error. */
  private async createThroughAdt(
    name: string,
    description: string,
    superPackage: string,
    request: string | undefined,
    swcomp: string,
    transportLayer: string | undefined
  ): Promise<{ notServed?: boolean; error?: unknown }> {
    const startTime = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.createObject({
        objtype: 'DEVC/K',
        name,
        parentName: superPackage || name,
        description,
        parentPath: `/sap/bc/adt/packages/${encodeURIComponent((superPackage || name).toLowerCase())}`,
        responsible: this.adtclient.username,
        transport: request,
        swcomp,
        transportLayer: transportLayer || '',
        packagetype: 'development'
      } as any);
      this.trackRequest(startTime, true);
      return {};
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (isNotServed(error)) return { notServed: true };
      this.logger.debug('ADT package creation failed', { error: describeAdtError(error).error });
      return { error };
    }
  }

  /** The names in the list that DD04L has no active data element for. */
  private async missingDataElements(names: string[]): Promise<string[]> {
    const wanted = [...new Set(names)];
    if (!wanted.length) return [];
    const found = new Set<string>();
    for (const sql of chunkedQueries(activeDataElementsPrefix, wanted)) {
      for (const row of await this.rows(sql, 500)) found.add(String(row.ROLLNAME ?? '').trim());
    }
    return wanted.filter(name => !found.has(name));
  }

  /** The rows of one SELECT, mapped to one trimmed upper-case column. */
  private async column(sql: string, name: string): Promise<string[]> {
    return (await this.rows(sql, 1000)).map(row => String(row[name] ?? '').trim().toUpperCase());
  }

  async handleCreateTable(args: any): Promise<any> {
    let name: string;
    let packageName: string;
    let fields: TableFieldSpec[];
    try {
      name = tableName(args?.name);
      packageName = checkedPackage(args?.packageName);
      fields = tableFields(
        this.parseObjectArg(args?.fields, 'fields'),
        args?.clientDependent ?? TABLE_DEFAULTS.clientDependent
      );
    } catch (error) {
      return this.refuse(error);
    }

    const versions = await this.rows(tableVersionsSql(name), 5);
    const [directory] = await this.rows(directorySql('TABL', name), 1);
    if (versions.length || directory) {
      return this.answer({
        status: 'error',
        created: false,
        name,
        hint: `${name} already exists${directory ? ` in package ${String(directory.DEVCLASS ?? '').trim()}` : ''}. Nothing was written; changeTableFields changes an existing table.`
      });
    }
    if (!isLocalPackage(packageName)) {
      const [known] = await this.rows(packageExistsSql(packageName), 1);
      if (!known) throw new McpError(ErrorCode.InvalidParams, `There is no package ${packageName} on this system.`);
    }
    const missing = await this.missingDataElements(fields.map(field => field.dataElement));
    if (missing.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No active data element ${missing.join(', ')}. Create and activate it first (createDataElement), or pick an existing one.`
      );
    }
    const { request, fromTask } = await this.requestFor(packageName, args?.transport, `The table ${name} in ${packageName}`);

    let snippet;
    try {
      snippet = createTableSnippet({
        name,
        description: args?.description,
        packageName,
        request,
        language: args?.language,
        fields,
        clientDependent: args?.clientDependent,
        deliveryClass: args?.deliveryClass,
        dataMaintenance: args?.dataMaintenance,
        dataClass: args?.dataClass,
        sizeCategory: args?.sizeCategory,
        buffering: args?.buffering,
        enhancementCategory: args?.enhancementCategory,
        activate: args?.activate
      });
    } catch (error) {
      return this.refuse(error);
    }
    const common = {
      name,
      packageName,
      ...(request ? { request } : {}),
      ...(fromTask ? { requestFromTask: fromTask } : {}),
      fields: snippet.fields
    };
    if (args?.dryRun === true) {
      return this.answer({
        status: 'success',
        dryRun: true,
        created: false,
        ...common,
        code: snippet.code,
        note: 'The checks passed and nothing was written. Without dryRun this ABAP runs in a throwaway class.'
      });
    }

    const run = await this.runDdif(snippet.code, snippet.exceptions);
    if (!run.ran) {
      return this.answer({
        status: 'error',
        created: false,
        ...common,
        ...run.snippet,
        hint: 'The throwaway class did not get as far as running, so nothing was written. The steps above say where it stopped.'
      });
    }
    const failed = failedStep(run.print);
    const columns = parseColumns(run.output);
    const after = await this.rows(tableVersionsSql(name), 5);
    const [settings] = await this.rows(technicalSettingsSql(name), 1);
    const [entry] = await this.rows(directorySql('TABL', name), 1);
    const recorded = request ? await this.recordedIn('TABL', name, request) : undefined;
    const active = after.some(row => String(row.AS4LOCAL ?? '').trim() === 'A');
    const missingColumns = snippet.fields.map(field => field.name).filter(field => columns[field]?.present !== true);
    const activateWanted = args?.activate !== false;

    let hint: string;
    if (failed?.step === 'transport') {
      hint = `RS_CORR_INSERT refused the table (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}), so nothing was written.`;
    } else if (failed?.step === 'put') {
      hint = `The table is registered but DDIF_TABL_PUT refused the definition (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}). The directory entry stays until it is deleted in SE11.`;
    } else if (failed?.step === 'activate') {
      hint = `${activationVerdict(failed.rc)} The table does not exist in the database yet; check the activation log in SE11.`;
    } else if (!activateWanted) {
      hint = 'Written to the inactive version and not activated, as asked - the database table is created by the activation.';
    } else if (!active || missingColumns.length) {
      hint = `The snippet reported success, but ${!active ? 'DD02L has no active version' : `the database lacks ${missingColumns.join(', ')}`}. Check the table in SE11/SE14.`;
    } else if (recorded && !recorded.recorded) {
      hint = `Active and in the database, but no entry for R3TR TABL ${name} was found in ${request} or its tasks - check the request before releasing it.`;
    } else {
      hint = `Active, in the database with all ${snippet.fields.length} columns${request ? `, recorded in ${recorded?.in?.join(', ') || request}` : ' as a local object'}.`;
    }

    return this.answer({
      status: failed || (activateWanted && (!active || missingColumns.length)) ? 'error' : 'success',
      created: run.print.steps.some(step => step.step === 'transport' && step.ok),
      written: run.print.steps.some(step => step.step === 'put' && step.ok),
      activated: activateWanted && active && !failed,
      ...common,
      ...(run.print.info.task ? { task: run.print.info.task } : {}),
      steps: run.print.steps,
      dd02lVersions: after.map(row => String(row.AS4LOCAL ?? '').trim()),
      technicalSettings: settings || null,
      ...(Object.keys(columns).length ? { databaseColumns: columns } : {}),
      directoryPackage: entry ? String(entry.DEVCLASS ?? '').trim() : null,
      ...(recorded ? { requestEntry: recorded } : {}),
      hint
    });
  }

  /**
   * Everything the field change is checked against, read fresh. Called for
   * the preview and again for the write, so the write is judged on the table
   * as it is at that moment, not as it was at the preview.
   */
  private async tableState(name: string) {
    const versions = await this.rows(tableVersionsSql(name), 5);
    const active = versions.find(row => String(row.AS4LOCAL ?? '').trim() === 'A');
    const inactive = versions.filter(row => String(row.AS4LOCAL ?? '').trim() !== 'A');
    const current: CurrentField[] = (await this.rows(activeFieldsSql(name), 1000)).map(row => ({
      name: String(row.FIELDNAME ?? '').trim().toUpperCase(),
      key: String(row.KEYFLAG ?? '').trim() === 'X',
      dataElement: String(row.ROLLNAME ?? '').trim().toUpperCase()
    }));
    const [directory] = await this.rows(directorySql('TABL', name), 1);
    const stampOf = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : String(value ?? '').trim();
    return {
      active,
      inactive,
      tableClass: String(active?.TABCLASS ?? '').trim(),
      stamp: active ? `${stampOf(active.AS4DATE)}|${stampOf(active.AS4TIME)}` : '',
      current,
      packageName: directory ? String(directory.DEVCLASS ?? '').trim() : '',
      appends: await this.column(appendsSql(name), 'TABNAME'),
      context: {
        foreignKeyFields: new Set(await this.column(foreignKeyFieldsSql(name), 'FIELDNAME')),
        indexFields: new Set(await this.column(indexFieldsSql(name), 'FIELDNAME')),
        searchHelpFields: new Set(await this.column(searchHelpFieldsSql(name), 'FIELDNAME')),
        checkTableOf: (await this.column(checkTableOfSql(name), 'TABNAME')).filter(table => table !== name)
      }
    };
  }

  async handleChangeTableFields(args: any): Promise<any> {
    let name: string;
    let change: FieldChange;
    try {
      name = tableName(args?.name);
      change = {
        add: args?.add === undefined ? undefined : this.parseObjectArg(args.add, 'add'),
        remove: args?.remove === undefined ? undefined : this.parseObjectArg(args.remove, 'remove')
      };
    } catch (error) {
      return this.refuse(error);
    }

    const state = await this.tableState(name);
    const refusal = (hint: string) => this.answer({ status: 'error', written: false, name, hint });
    if (!state.active) return refusal(`${name} has no active version - there is no table to change.`);
    if (state.tableClass !== 'TRANSP') {
      return refusal(`${name} is a ${state.tableClass || 'dictionary object'} table class, not a transparent table. This tool changes TRANSP tables only.`);
    }
    if (state.inactive.length) {
      return refusal(`${name} has an inactive version: somebody is in the middle of changing it. Activate or discard that in SE11 first - a write here would overwrite it.`);
    }
    if (state.appends.length) {
      return refusal(`${name} has append structures (${state.appends.join(', ')}); the field list is not the table's alone. Change it in SE11.`);
    }

    let plan;
    try {
      plan = planFieldChange(state.current, change, state.context);
    } catch (error) {
      return this.refuse(error);
    }
    const addedElements = (change.add || []).map(addition => String(addition?.dataElement ?? '').trim().toUpperCase());
    const missing = await this.missingDataElements(addedElements);
    if (missing.length) {
      throw new McpError(ErrorCode.InvalidParams, `No active data element ${missing.join(', ')}. Create and activate it first.`);
    }
    const token = previewToken(name, state.stamp, state.current, change);
    const view = (fields: { name: string; key: boolean; dataElement: string }[], marks?: Set<string>) =>
      fields.map((field, index) => ({
        position: index + 1,
        name: field.name,
        key: field.key,
        dataElement: field.dataElement,
        ...(marks?.has(field.name) ? { added: true } : {})
      }));

    if (!args?.previewToken) {
      let rowsHere: boolean | undefined;
      try {
        rowsHere = (await this.rows(`SELECT * FROM ${name}`, 1)).length > 0;
      } catch {
        rowsHere = undefined;
      }
      return this.answer({
        status: 'success',
        preview: true,
        written: false,
        name,
        packageName: state.packageName,
        current: view(state.current),
        planned: view(plan.fields, new Set(plan.added)),
        added: plan.added,
        removed: plan.removed,
        requiresEmptyTable: plan.requiresEmpty,
        ...(plan.requiresEmpty ? { emptyBecause: plan.emptyBecause } : {}),
        ...(rowsHere !== undefined ? { rowsInThisClient: rowsHere } : {}),
        previewToken: token,
        hint: plan.requiresEmpty
          ? `Nothing written. ${plan.emptyBecause.join(' and ')} needs a table with no rows in any client${rowsHere ? ' - and this client already has rows, so the write will stop' : ''}; the write counts every client before it changes anything. Call again with previewToken to write.`
          : 'Nothing written. Call again with this previewToken to write exactly this change.'
      });
    }

    if (String(args.previewToken).trim() !== token) {
      return refusal(
        'The previewToken does not match: the table changed since the preview, or this is not the change that was previewed. Nothing was written - preview again.'
      );
    }
    const { request, fromTask } = await this.requestFor(
      state.packageName || '$',
      args?.transport,
      `The table ${name} in ${state.packageName}`
    );

    let snippet;
    try {
      snippet = changeTableSnippet({
        name,
        packageName: state.packageName,
        request,
        language: args?.language,
        expected: state.current.map(field => field.name),
        plan
      });
    } catch (error) {
      return this.refuse(error);
    }
    const run = await this.runDdif(snippet.code, snippet.exceptions);
    const common = {
      name,
      packageName: state.packageName,
      ...(request ? { request } : {}),
      ...(fromTask ? { requestFromTask: fromTask } : {}),
      added: plan.added,
      removed: plan.removed
    };
    if (!run.ran) {
      return this.answer({
        status: 'error',
        written: false,
        ...common,
        ...run.snippet,
        hint: 'The throwaway class did not get as far as running, so the table was not touched. The steps above say where it stopped.'
      });
    }

    const step = (stepName: string) => run.print.steps.find(candidate => candidate.step === stepName);
    const failed = failedStep(run.print);
    const columns = parseColumns(run.output);
    const versionsAfter = (await this.rows(tableVersionsSql(name), 5)).map(row => String(row.AS4LOCAL ?? '').trim());
    const fieldsAfter = (await this.rows(activeFieldsSql(name), 1000)).map(row => String(row.FIELDNAME ?? '').trim().toUpperCase());
    const plannedNames = plan.fields.map(field => field.name);
    const orderMatches = fieldsAfter.join(',') === plannedNames.join(',');
    const columnTrouble = [
      ...plan.added.filter(field => columns[field]?.present !== true).map(field => `${field} is missing in the database`),
      ...plan.removed.filter(field => columns[field]?.present !== false).map(field => `${field} is still in the database`)
    ];
    const recorded = request ? await this.recordedIn('TABL', name, request) : undefined;
    const rolledBack = step('rollback_put') !== undefined;
    const rollbackOk = rolledBack && step('rollback_put')?.ok === true && step('rollback_activate')?.ok === true;

    let hint: string;
    if (failed?.step === 'transport') {
      hint = `RS_CORR_INSERT refused the table (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}) - it may be locked in somebody else's request. The table was not touched.`;
    } else if (failed?.step === 'compare') {
      hint = `The table changed between the checks and the write (${failed.message}). Nothing was written - preview again.`;
    } else if (failed?.step === 'rows') {
      hint = `Stopped before writing: ${failed.message}, and ${plan.emptyBecause.join(' and ')} needs an empty table. A change on a table with data is SE11/SE14 work.`;
    } else if (failed?.step === 'put') {
      hint = `DDIF_TABL_PUT refused the new definition (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}). The active table is unchanged.`;
    } else if (rolledBack) {
      const reason = step('activate');
      hint = rollbackOk
        ? `The activation failed (rc ${reason?.rc}${reason?.message ? `: ${reason.message}` : ''}) - the new definition has errors, or would need a database conversion - so the definition read before was written back and activated: the table is as it was. The activation log in SE11 says why; a conversion is done in SE14.`
        : `The activation failed AND putting the old definition back did not finish cleanly. Check ${name} in SE11 now: it may have an inactive version${versionsAfter.length > 1 ? ' (DD02L shows ' + versionsAfter.join('/') + ')' : ''}.`;
    } else if (versionsAfter.join() !== 'A' || !orderMatches || columnTrouble.length) {
      hint = `Written and activated, but the read-back disagrees: ${[
        versionsAfter.join() !== 'A' ? `DD02L versions ${versionsAfter.join('/')}` : '',
        !orderMatches ? `fields are ${fieldsAfter.join(', ')}` : '',
        ...columnTrouble
      ].filter(Boolean).join('; ')}. Check the table in SE11/SE14.`;
    } else if (recorded && !recorded.recorded) {
      hint = `Changed and active, but no entry for R3TR TABL ${name} was found in ${request} or its tasks - check the request before releasing it.`;
    } else {
      hint = `Changed and active; the database has ${plan.added.length ? `the new ${plan.added.join(', ')}` : ''}${plan.added.length && plan.removed.length ? ' and ' : ''}${plan.removed.length ? `no more ${plan.removed.join(', ')}` : ''}${request ? `. Recorded in ${recorded?.in?.join(', ') || request}` : ''}.`;
    }

    const clean = !failed && versionsAfter.join() === 'A' && orderMatches && columnTrouble.length === 0;
    return this.answer({
      status: clean ? 'success' : 'error',
      written: clean,
      ...(rolledBack ? { rolledBack: rollbackOk } : {}),
      ...common,
      ...(run.print.info.task ? { task: run.print.info.task } : {}),
      ...(run.print.info.rows !== undefined ? { rowsAllClients: Number(run.print.info.rows) } : {}),
      steps: run.print.steps,
      dd02lVersions: versionsAfter,
      fields: fieldsAfter,
      ...(Object.keys(columns).length ? { databaseColumns: columns } : {}),
      ...(recorded ? { requestEntry: recorded } : {}),
      hint
    });
  }
}
