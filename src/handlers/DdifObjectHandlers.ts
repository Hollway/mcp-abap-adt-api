import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { session_types } from 'abap-adt-api';
import type { ToolDefinition } from '../types/tools';
import { DdifHandlerBase } from './DdifHandlerBase';
import { describeAdtError, wrapAdtError } from '../lib/adtError';
import { directorySql, failedStep, isLocalPackage, packageName as checkedPackage } from '../lib/ddifWrite';
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
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'createPackage':
        return this.handleCreatePackage(args);
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
}
