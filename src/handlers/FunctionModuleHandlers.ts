import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { ObjectRegistrationHandlers } from './ObjectRegistrationHandlers.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import type { ADTClient } from 'abap-adt-api';
import {
  parseFunctionSource,
  buildFunctionSource,
  signatureCounts,
  FunctionModuleError
} from '../lib/functionModule';
import type { FunctionParameter } from '../lib/functionModule';

/**
 * Function modules as objects in their own right.
 *
 * Everything about them was reachable only if you already knew where they
 * live: the source URL needs the function GROUP
 * (/sap/bc/adt/functions/groups/<group>/fmodules/<module>/source/main), and a
 * caller reading `CALL FUNCTION 'Z_APP_GET_INVOICE'` has the module name and
 * nothing else. The signature was worse: ADT serves it as the first statement
 * of the source, so answering "what does this module take" meant reading a
 * 1,100-line source and reading the ABAP by eye.
 */

const PARAMETER_SCHEMA = (what: string) => ({
  type: 'array',
  description: `${what} as data: [{name, type, byValue?, optional?, default?}]. byValue writes VALUE(NAME); the default is by reference, which is what ADT writes for a bare name.`,
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', description: 'ABAP type, e.g. LGNUM, STRING, ZAPP_INVOICE_LIST_TT.' },
      byValue: { type: 'boolean', description: 'Pass by value: VALUE(NAME).' },
      optional: { type: 'boolean', description: 'OPTIONAL.' },
      default: { type: 'string', description: `DEFAULT <this>, written as ABAP: 'X', SPACE, ABAP_TRUE.` },
      structure: { type: 'string', description: 'TABLES only: STRUCTURE <dictionary type>, the older form.' },
      like: { type: 'string', description: 'LIKE <data object>, for an interface written that way.' }
    },
    required: ['name']
  }
});

export class FunctionModuleHandlers extends BaseHandler {
  private readonly registration: ObjectRegistrationHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.registration = new ObjectRegistrationHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getFunctionModule',
        description: 'A function module by name alone: which group it lives in, its package, and its signature as data - importing, exporting, changing, tables and exceptions, with types, defaults and which parameters are passed by value. The name is all that is needed; the group is looked up. Without this, reading a module meant knowing its group to build the URL and then reading the interface out of the ABAP by eye, because ADT serves the signature as the first statement of the source (not as the *"-block SE37 shows). Pass includeSource for the body as well - it is often a thousand lines, so it is off by default.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Function module name, e.g. Z_APP_GET_INVOICE.' },
            functionGroup: {
              type: 'string',
              description: 'The group, if you know it. Saves the lookup; required only when the search cannot find the module.'
            },
            includeSource: {
              type: 'boolean',
              description: 'Also return the body. Default false.'
            },
            startLine: { type: 'number', description: 'With includeSource: first line of the body to return.' },
            maxLines: { type: 'number', description: 'With includeSource: how many lines of the body to return.' },
            version: {
              type: 'string',
              description: 'Which version to read: "active" (what runs) or "inactive" (the working copy, the ADT default).'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'listFunctionGroup',
        description: 'What is in a function group: its modules, its includes, and the global data and types declared in its TOP include. nodeContents answers this, but each row carries a SAPGUI bridge URI padded with spaces to 30 characters, so a group of thirty modules costs about 14,000 characters to list; here it is the names and the source URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            functionGroup: { type: 'string', description: 'Group name, e.g. ZAPP_CORE_FM.' },
            includeGlobals: {
              type: 'boolean',
              description: 'Also list the global data and types of the TOP include. Default true.'
            }
          },
          required: ['functionGroup']
        }
      },
      {
        name: 'createFunctionModule',
        description: 'Create a function module in an existing group and give it its signature and body in one call: create, write, activate, verify. The signature is passed as data and the ABAP interface is built here - which is how it is set at all, since ADT keeps the interface in the source text. The group has to exist (create one with createAndWrite for FUGR/F) and a group outside $TMP needs a transport request.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the new module, e.g. Z_APP_DO_THING.' },
            functionGroup: { type: 'string', description: 'The group it goes into. Must exist.' },
            description: { type: 'string', description: 'Short text for the module.' },
            importing: PARAMETER_SCHEMA('Importing parameters'),
            exporting: PARAMETER_SCHEMA('Exporting parameters'),
            changing: PARAMETER_SCHEMA('Changing parameters'),
            tables: PARAMETER_SCHEMA('Tables parameters'),
            exceptions: {
              type: 'array',
              description: 'Classic exceptions, e.g. ["NOT_FOUND","NO_AUTHORITY"].',
              items: { type: 'string' }
            },
            implementation: {
              type: 'array',
              description: 'Body lines, without FUNCTION/ENDFUNCTION. Omit and a TODO comment is left in their place.',
              items: { type: 'string' }
            },
            transport: {
              type: 'string',
              description: 'Transport request - the REQUEST, not a task inside it. Not needed for a group in $TMP.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Return the source that would be written, without creating anything.'
            }
          },
          required: ['name', 'functionGroup', 'description']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'getFunctionModule':
        return this.handleGetFunctionModule(args);
      case 'listFunctionGroup':
        return this.handleListFunctionGroup(args);
      case 'createFunctionModule':
        return this.handleCreateFunctionModule(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown function module tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  private lower = (name: string): string => encodeURIComponent(String(name).trim().toLowerCase());

  private moduleUrl(functionGroup: string, name: string): string {
    return `/sap/bc/adt/functions/groups/${this.lower(functionGroup)}/fmodules/${this.lower(name)}`;
  }

  /**
   * Find one object by name in the repository search, and keep only the row
   * of the type wanted.
   *
   * The type filter is deliberately not passed to the backend: searching with
   * objType=FUGR/FF answers with an empty list on this system, while the same
   * query with no filter returns the module with adtcore:type FUGR/FF - the
   * quick search does not take that sub-type. FUGR/F does work, but filtering
   * here costs nothing and cannot be wrong.
   */
  private async searchByName(name: string, type: string): Promise<any | undefined> {
    let results: any[] = [];
    try {
      results = await this.readClient.searchObject(name, undefined, 20) as any[];
    } catch (error: any) {
      throw wrapAdtError(error, `Failed to look up ${name}`);
    }
    return (results || []).find(row =>
      String(row?.['adtcore:name'] || '').toUpperCase() === name.toUpperCase()
      && String(row?.['adtcore:type'] || '').toUpperCase() === type.toUpperCase());
  }

  /**
   * The group a module lives in. The repository search knows it - the module
   * URI carries the group - and it is the only thing that does: no endpoint
   * addresses a function module without its group.
   */
  private async findGroup(name: string): Promise<{ functionGroup: string; packageName?: string; description?: string }> {
    const exact = await this.searchByName(name, 'FUGR/FF');
    const uri = String(exact?.['adtcore:uri'] || '');
    const group = /\/functions\/groups\/([^/]+)\/fmodules\//i.exec(uri);
    if (!group) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No function module ${name} was found in this system. If it is there but the search does not see it, pass functionGroup.`
      );
    }
    return {
      functionGroup: decodeURIComponent(group[1]).toUpperCase(),
      packageName: exact?.['adtcore:packageName'],
      description: exact?.['adtcore:description']
    };
  }

  async handleGetFunctionModule(args: any): Promise<any> {
    const name = String(args?.name || '').trim().toUpperCase();
    if (!name) throw new McpError(ErrorCode.InvalidParams, 'Pass name - the function module to read.');

    const startTime = performance.now();
    try {
      let functionGroup = String(args?.functionGroup || '').trim().toUpperCase();
      let packageName: string | undefined;
      let description: string | undefined;
      if (!functionGroup) {
        const found = await this.findGroup(name);
        functionGroup = found.functionGroup;
        packageName = found.packageName;
        description = found.description;
      }

      const sourceUrl = `${this.moduleUrl(functionGroup, name)}/source/main`;
      const version = String(args?.version || '').trim();
      const source = await this.readClient.getObjectSource(
        sourceUrl,
        version ? ({ version } as any) : undefined
      );
      const parsed = parseFunctionSource(source);

      let body: string[] | undefined;
      if (args?.includeSource === true) {
        const startLine = Math.max(1, Number(args?.startLine) || 1);
        const maxLines = Number(args?.maxLines) > 0 ? Number(args.maxLines) : undefined;
        body = parsed.body.slice(startLine - 1, maxLines ? startLine - 1 + maxLines : undefined);
      }

      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        name,
        functionGroup,
        ...(packageName ? { package: packageName } : {}),
        ...(description ? { description } : {}),
        sourceUrl,
        ...(version ? { version } : {}),
        signature: parsed.signature,
        counts: signatureCounts(parsed.signature),
        bodyLines: parsed.bodyLines,
        ...(body
          ? {
            body: body.join('\n'),
            bodyReturnedLines: body.length,
            bodyHasMore: (Number(args?.startLine) || 1) - 1 + body.length < parsed.bodyLines
          }
          : {})
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      if (error instanceof FunctionModuleError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw wrapAdtError(error, `Failed to read function module ${name}`);
    }
  }

  async handleListFunctionGroup(args: any): Promise<any> {
    const functionGroup = String(args?.functionGroup || '').trim().toUpperCase();
    if (!functionGroup) throw new McpError(ErrorCode.InvalidParams, 'Pass functionGroup.');

    const startTime = performance.now();
    try {
      const contents: any = await this.readClient.nodeContents('FUGR/F', functionGroup);
      const nodes: any[] = contents?.nodes || [];
      if (nodes.length === 0) {
        // An unknown group and an empty one answer the same way; the search
        // tells them apart.
        const exists = !!(await this.searchByName(functionGroup, 'FUGR/F'));
        this.trackRequest(startTime, true);
        return this.answer({
          status: exists ? 'success' : 'error',
          functionGroup,
          ...(exists
            ? { modules: [], includes: [], note: 'The group is there and has no modules.' }
            : { error: `No function group ${functionGroup} in this system.` })
        });
      }

      const pick = (type: RegExp) => nodes.filter(node => type.test(String(node?.OBJECT_TYPE || '')));
      const modules = pick(/^FUGR\/FF$/i).map(node => ({
        name: String(node.OBJECT_NAME || '').toUpperCase(),
        sourceUrl: `${this.moduleUrl(functionGroup, String(node.OBJECT_NAME || ''))}/source/main`
      }));
      const includes = pick(/^FUGR\/I$/i).map(node => ({
        name: String(node.OBJECT_NAME || '').toUpperCase(),
        sourceUrl: String(node.OBJECT_URI || '')
      }));
      const globalData = pick(/^FUGR\/PD$/i).map(node => String(node.OBJECT_NAME || '').toUpperCase());
      const globalTypes = pick(/^FUGR\/PY$/i).map(node => String(node.OBJECT_NAME || '').toUpperCase());

      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        functionGroup,
        counts: {
          modules: modules.length,
          includes: includes.length,
          globalData: globalData.length,
          globalTypes: globalTypes.length
        },
        modules,
        includes,
        ...(args?.includeGlobals === false ? {} : { globalData, globalTypes })
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      throw wrapAdtError(error, `Failed to list function group ${functionGroup}`);
    }
  }

  async handleCreateFunctionModule(args: any): Promise<any> {
    const name = String(args?.name || '').trim().toUpperCase();
    const functionGroup = String(args?.functionGroup || '').trim().toUpperCase();
    const description = String(args?.description || '').trim();
    if (!name || !functionGroup || !description) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass name, functionGroup and description.');
    }

    let source: string;
    try {
      source = buildFunctionSource({
        name,
        importing: this.parseObjectArg<FunctionParameter[]>(args?.importing, 'importing'),
        exporting: this.parseObjectArg<FunctionParameter[]>(args?.exporting, 'exporting'),
        changing: this.parseObjectArg<FunctionParameter[]>(args?.changing, 'changing'),
        tables: this.parseObjectArg<FunctionParameter[]>(args?.tables, 'tables'),
        exceptions: this.parseObjectArg<string[]>(args?.exceptions, 'exceptions'),
        implementation: this.parseObjectArg<string[]>(args?.implementation, 'implementation')
      });
    } catch (error: any) {
      if (error instanceof FunctionModuleError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }

    if (args?.dryRun === true) {
      return this.answer({
        status: 'success',
        dryRun: true,
        name,
        functionGroup,
        source
      });
    }

    // The group's package is where the module lands; createAndWrite wants it
    // named, and the answer of a missing group is worth saying plainly.
    let packageName = '';
    try {
      const group = await this.searchByName(functionGroup, 'FUGR/F');
      packageName = String(group?.['adtcore:packageName'] || '').toUpperCase();
    } catch {
      // The search failing is not fatal: createAndWrite will refuse clearly.
    }
    if (!packageName) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No function group ${functionGroup} in this system. A module needs an existing group - create one with createAndWrite (objtype FUGR/F).`
      );
    }

    const result = await this.registration.handleCreateAndWrite({
      objtype: 'FUGR/FF',
      name,
      description,
      packageName,
      functionGroup,
      parentName: functionGroup,
      source,
      transport: args?.transport
    });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result.content[0].text);
    } catch {
      return result;
    }
    return this.answer({ ...payload, functionGroup, package: packageName });
  }
}
