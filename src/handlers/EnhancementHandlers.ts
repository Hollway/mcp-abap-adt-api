import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';

/**
 * Enhancement implementations sitting on an object.
 *
 * Reading a standard include and reasoning about what it does is wrong
 * whenever an enhancement is active on it: the code that runs is the include
 * plus whatever the implementations inject, and none of that is visible in the
 * source the other read tools return. This is the only way to see it from
 * here.
 */
export class EnhancementHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'objectEnhancements',
        description: 'Enhancement implementations active on an ABAP source, with the position each one is injected at and, with includeSource, its code. Read this before drawing conclusions from a standard include: the code that actually runs is the include plus its enhancements, and the source itself does not show them. For a program include, pass contextUri (the main program) - one include can belong to several programs.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceMainPath: {
              type: 'string',
              description: 'ADT path of the object, e.g. /sap/bc/adt/programs/includes/mv45afzz/source/main. The /source/main part is added when it is missing.'
            },
            contextUri: {
              type: 'string',
              description: 'The containing program, for a program include: /sap/bc/adt/programs/programs/sapmv45a. Not needed for classes, interfaces or function groups.'
            },
            includeSource: {
              type: 'boolean',
              description: 'Decode and return the ABAP source of each enhancement (default false).'
            }
          },
          required: ['sourceMainPath']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'objectEnhancements':
        return this.handleObjectEnhancements(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown enhancement tool: ${toolName}`);
    }
  }

  async handleObjectEnhancements(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const result: any = await this.readClient.objectEnhancements(
        args.sourceMainPath,
        args.contextUri,
        args.includeSource === true
      );
      this.trackRequest(startTime, true);

      const implementations = result?.implementations || [];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            sourceMainPath: args.sourceMainPath,
            count: implementations.length,
            elementCount: implementations.reduce(
              (n: number, i: any) => n + (i?.elements || []).length,
              0
            ),
            implementations,
            ...(implementations.length === 0
              ? {
                note: 'No enhancement implementations came back, which for most objects is simply the truth. ' +
                  'For a program include it can also mean the wrong context: pass contextUri with the main ' +
                  'program the include belongs to. To find objects that do carry one, ask runQuery for ' +
                  "SELECT ENHNAME, PROGRAMNAME, FULL_NAME FROM ENHINCINX WHERE VERSION = 'A' AND ENHMODE = 'S'" +
                  ' - FULL_NAME says which class, method or form is enhanced.'
              }
              : {})
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to read the enhancements of the object');
    }
  }
}
