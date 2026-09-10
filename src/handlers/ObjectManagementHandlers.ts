import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import { activateAndVerify, selectInactive } from '../lib/activation';
import type {
  ActivationResult,
  InactiveObject,
  InactiveObjectRecord,
  ObjectRef
} from '../lib/activation';
import type { ToolDefinition } from '../types/tools';

export class ObjectManagementHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'activateObjects',
        description: 'Activate the objects you name, as rows shaped like the ones inactiveObjects returns. Prefer activateSafe, which activates and then proves it: this call can answer success:true while the object stays inactive, and activating only the class row leaves changed method fragments behind, so the old implementation keeps running under an already-active signature. Every row needs a non-empty adtcore:parentUri, which the inactive list leaves empty for programs.',
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
        description: 'Activate an ABAP object by name and URL, then check the inactive list to see whether it really happened. The backend call behind this answers success:true for objects that stay inactive - notably a freshly created class - so the answer carries verified/stillInactive as well, and success is lowered to false when anything is left inactive. activateSafe is still the better tool: it activates exactly the rows inactiveObjects reports, including method fragments.',
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
        description: 'The objects that are written but not activated. Read in the session this server does its writing in, because the sessions disagree: a read from elsewhere can still report an object as inactive after it has been activated. Use it as the proof that an edit went live - an empty list for your object is that proof.',
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
              description: 'Name of the object to activate, e.g. ZCL_APP. Used to pick its rows out of the inactive list; omit to activate everything inactive.'
            },
            objectUrl: {
              type: 'string',
              description: 'Object URL, e.g. /sap/bc/adt/oo/classes/zcl_app. An alternative way to select the rows.'
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
      const outcome = await activateAndVerify(this.adtclient, {
        objectName: args?.objectName,
        objectUrl: args?.objectUrl,
        parentUri: args?.parentUri,
        objects: args?.objects
          ? this.parseObjectArg<InactiveObject[]>(args.objects, 'objects')
          : undefined,
        preauditRequested: args?.preauditRequested
      });
      this.trackRequest(startTime, true);
      return this.answer({
        status: outcome.success ? 'success' : 'error',
        ...outcome
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

  /**
   * What is still inactive for this object after an activation attempt.
   *
   * A failure to read the list must not turn a successful activation into an
   * error, so an unreachable inactive list is reported as "not verified"
   * rather than thrown.
   */
  private async verifyActivation(
    objectName?: string,
    objectUrl?: string
  ): Promise<ObjectRef[] | undefined> {
    try {
      // Deliberately the stateful client - see handleInactiveObjects: the two
      // sessions answer differently, and only the one that did the editing
      // answers about it.
      const after: InactiveObjectRecord[] = await this.adtclient.inactiveObjects();
      return selectInactive(after, objectName, objectUrl)
        .map(e => ({ name: e['adtcore:name'], type: e['adtcore:type'] }));
    } catch (error: any) {
      this.logger.warn('Could not read the inactive list to verify the activation', {
        error: error?.message
      });
      return undefined;
    }
  }

  async handleActivateByName(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      if (!args.objectName || !args.objectUrl) {
        throw new McpError(ErrorCode.InvalidParams, "objectName and objectUrl parameters are required");
      }

      const result: ActivationResult = await this.adtclient.activate(
        args.objectName,
        args.objectUrl,
        args.mainInclude,
        args.preauditRequested
      );

      // The library's answer alone is not evidence: activateByName has been
      // seen returning success:true, inactive:[] for a class that was still
      // inactive afterwards, so the old code kept running while the caller was
      // told the activation had worked. The inactive list is the only proof.
      const stillInactive = await this.verifyActivation(args.objectName, args.objectUrl);
      const verified = stillInactive ? stillInactive.length === 0 : undefined;

      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            success: verified === false ? false : result.success,
            reportedSuccess: result.success,
            verified,
            stillInactive,
            hint: verified === true
              ? undefined
              : verified === false
                ? 'Still inactive after the call. activateByName does not activate every object; use activateSafe, which passes the rows from inactiveObjects.'
                : 'The inactive list could not be read, so this answer is unverified - and this call is known to report success without activating anything.'
          })
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

  /**
   * The inactive list, read in the session that does the editing.
   *
   * This is a read, and every other read here goes through the stateless
   * clone - but this one must not. The two sessions disagree: after a text
   * element write and its activation, the writing session reports nothing
   * inactive while the clone kept reporting the program as inactive, three
   * consecutive reads apart and with the object provably active (it deleted
   * without complaint, and the activation verified itself as clean). Answering
   * from the clone turns a finished edit into "still inactive", which is the
   * one thing this list is asked for.
   */
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
