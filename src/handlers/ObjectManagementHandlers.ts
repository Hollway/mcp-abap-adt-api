import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';

interface InactiveObject {
  "adtcore:uri": string;
  "adtcore:type": string;
  "adtcore:name": string;
  "adtcore:parentUri": string;
}

interface ActivationResultMessage {
  objDescr: string;
  type: string;
  line: number;
  href: string;
  forceSupported: boolean;
  shortText: string;
}

interface ActivationResult {
  success: boolean;
  messages: ActivationResultMessage[];
  inactive: InactiveObjectRecord[];
}

interface InactiveObjectElement extends InactiveObject {
  user: string;
  deleted: boolean;
}

interface InactiveObjectRecord {
  object?: InactiveObjectElement;
  transport?: InactiveObjectElement;
}

export class ObjectManagementHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'activateObjects',
        description: 'Activate ABAP objects using object references',
        inputSchema: {
          type: 'object',
          properties: {
            objects: {
              type: 'array',
              description: 'Objects to activate, ideally exactly the rows returned by inactiveObjects. A JSON string is accepted too.',
              items: {
                type: 'object',
                properties: {
                  'adtcore:uri': { type: 'string' },
                  'adtcore:type': { type: 'string' },
                  'adtcore:name': { type: 'string' },
                  'adtcore:parentUri': { type: 'string' }
                },
                required: ['adtcore:uri', 'adtcore:type', 'adtcore:name', 'adtcore:parentUri']
              }
            },
            preauditRequested: {
              type: 'boolean',
              description: 'Whether to perform pre-audit checks'
            }
          },
          required: ['objects']
        }
      },
      {
        name: 'activateByName',
        description: 'Activate an ABAP object using name and URL',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Name of the object'
            },
            objectUrl: {
              type: 'string',
              description: 'URL of the object'
            },
            mainInclude: {
              type: 'string',
              description: 'Main include context'
            },
            preauditRequested: {
              type: 'boolean',
              description: 'Whether to perform pre-audit checks'
            }
          },
          required: ['objectName', 'objectUrl']
        }
      },
      {
        name: 'inactiveObjects',
        description: 'Get list of inactive objects',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'activateSafe',
        description: 'Activate an object and prove it worked. Reads inactiveObjects, activates exactly those entries (class plus its method fragments, sections and test include), then re-reads inactiveObjects and fails if anything is still inactive. Prefer this over activateByName, which can answer success:true without activating anything.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Name of the object to activate, e.g. ZCL_MM. Used to pick its rows out of the inactive list; omit to activate everything inactive.'
            },
            objectUrl: {
              type: 'string',
              description: 'Object URL, e.g. /sap/bc/adt/oo/classes/zcl_mm. An alternative way to select the rows.'
            },
            parentUri: {
              type: 'string',
              description: 'Package URI (/sap/bc/adt/packages/<package>), used to fill in adtcore:parentUri where the inactive list leaves it empty - activation rejects entries with an empty parentUri.'
            },
            objects: {
              type: 'array',
              description: 'Explicit entries to activate instead of what inactiveObjects reports. Same shape as activateObjects.',
              items: { type: 'object' }
            },
            preauditRequested: {
              type: 'boolean',
              description: 'Ask the backend to list the fragments it would activate. Useful on a large live class: it is the only diff available here.'
            }
          },
          required: []
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'activateObjects':
        return this.handleActivateObjects(args);
      case 'activateByName':
        return this.handleActivateByName(args);
      case 'inactiveObjects':
        return this.handleInactiveObjects(args);
      case 'activateSafe':
        return this.handleActivateSafe(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object management tool: ${toolName}`);
    }
  }

  /** Rows of the inactive list that belong to one object. */
  private selectInactive(
    records: InactiveObjectRecord[],
    objectName?: string,
    objectUrl?: string
  ): InactiveObjectElement[] {
    const elements = records
      .map(r => r.object)
      .filter((e): e is InactiveObjectElement => !!e && !!e['adtcore:uri']);
    if (!objectName && !objectUrl) return elements;

    const name = objectName?.toUpperCase();
    const url = objectUrl?.toLowerCase();
    return elements.filter(e => {
      // Fragments are named "<OBJECT>  <METHOD>" and their URIs extend the
      // object URI with a #type=... suffix, so both matches are prefix-based.
      const byName = name ? (e['adtcore:name'] || '').toUpperCase().startsWith(name) : false;
      const byUrl = url ? (e['adtcore:uri'] || '').toLowerCase().startsWith(url) : false;
      return byName || byUrl;
    });
  }

  /**
   * Activate and then verify, because neither answer alone can be trusted:
   * activateByName has been seen to return success:true for a class that stayed
   * inactive, and activating only the CLAS/OC entry can leave changed method
   * fragments inactive - so the old implementation keeps running while the new
   * signature is already active. An empty inactive list afterwards is the only
   * proof, so this tool insists on it.
   */
  private async handleActivateSafe(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const before: InactiveObjectRecord[] = await this.adtclient.inactiveObjects();
      const explicit = args?.objects
        ? this.parseObjectArg<InactiveObject[]>(args.objects, 'objects')
        : undefined;

      const selected = explicit
        ? explicit
        : this.selectInactive(before, args?.objectName, args?.objectUrl);

      if (selected.length === 0) {
        this.trackRequest(startTime, true);
        return this.answer({
          status: 'success',
          success: true,
          activated: [],
          note: args?.objectName || args?.objectUrl
            ? 'Nothing inactive matches that object - it is already active, or the edit never reached the system.'
            : 'Nothing is inactive; there was nothing to activate.'
        });
      }

      const parentUri = args?.parentUri;
      const objects: InactiveObject[] = selected.map(e => ({
        'adtcore:uri': e['adtcore:uri'],
        'adtcore:type': e['adtcore:type'],
        'adtcore:name': e['adtcore:name'],
        'adtcore:parentUri': e['adtcore:parentUri'] || parentUri || ''
      }));

      const missingParent = objects.filter(o => !o['adtcore:parentUri']);
      if (missingParent.length > 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Activation needs a non-empty adtcore:parentUri, and the inactive list left it empty for: ${
            missingParent.map(o => o['adtcore:name']).join(', ')
          }. Pass parentUri=/sap/bc/adt/packages/<package>.`
        );
      }

      const result: ActivationResult = await this.adtclient.activate(objects, args?.preauditRequested);

      const after: InactiveObjectRecord[] = await this.adtclient.inactiveObjects();
      const stillInactive = this.selectInactive(after, args?.objectName, args?.objectUrl)
        .map(e => ({ name: e['adtcore:name'], type: e['adtcore:type'] }));

      const success = result.success && stillInactive.length === 0;
      this.trackRequest(startTime, true);
      return this.answer({
        status: success ? 'success' : 'error',
        success,
        activated: objects.map(o => ({ name: o['adtcore:name'], type: o['adtcore:type'] })),
        messages: result.messages,
        stillInactive,
        hint: success
          ? undefined
          : stillInactive.length > 0
            ? 'Some parts are still inactive - read the messages, fix the source and run activateSafe again.'
            : 'The backend reported a failure; the messages carry the syntax or activation errors.'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to activate object safely');
    }
  }

  private answer(payload: Record<string, unknown>) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload)
      }]
    };
  }

  async handleActivateObjects(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      if (!args.objects) {
        throw new McpError(ErrorCode.InvalidParams, "objects parameter is required");
      }

      let objects: InactiveObject[];
      try {
        objects = this.parseObjectArg<InactiveObject[]>(args.objects, 'objects');
        if (!Array.isArray(objects)) {
          throw new Error("objects must be an array");
        }
        
        // Validate each object has required properties
        objects.forEach((obj, index) => {
          if (!obj["adtcore:uri"] || !obj["adtcore:type"] || 
              !obj["adtcore:name"] || !obj["adtcore:parentUri"]) {
            throw new Error(`Object at index ${index} is missing required properties`);
          }
        });
      } catch (parseError: any) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid objects JSON: ${parseError.message}`
        );
      }

      const result = await this.adtclient.activate(objects, args.preauditRequested);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) {
        throw error;
      }
      throw wrapAdtError(error, 'Failed to activate objects');
    }
  }

  async handleActivateByName(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      if (!args.objectName || !args.objectUrl) {
        throw new McpError(ErrorCode.InvalidParams, "objectName and objectUrl parameters are required");
      }

      const result = await this.adtclient.activate(
        args.objectName,
        args.objectUrl,
        args.mainInclude,
        args.preauditRequested
      );
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) {
        throw error;
      }
      throw wrapAdtError(error, 'Failed to activate object');
    }
  }

  async handleInactiveObjects(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const result: InactiveObjectRecord[] = await this.adtclient.inactiveObjects();
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) {
        throw error;
      }
      throw wrapAdtError(error, 'Failed to get inactive objects');
    }
  }
}
