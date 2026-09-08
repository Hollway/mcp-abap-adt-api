import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';

/**
 * Whether this system has the RAP generator at all.
 *
 * The library wraps the whole generator - validate, preview, generate,
 * publish - but none of that is worth exposing against a system that does not
 * have it, and a classic ERP system does not. This one call answers that
 * question for a couple of hundred milliseconds, and the rest can be wrapped
 * when there is a system to try it on.
 */
export class RapHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'rapGenIsAvailable',
        description: 'Whether the RAP generator (business service generation) answers on this system. False on a classic ERP system, true on a recent S/4 - ask this before assuming a RAP-based approach is possible here. Only the check is wrapped; the generator itself is not.',
        inputSchema: {
          type: 'object',
          properties: {
            generatorId: {
              type: 'string',
              description: 'Which generator to ask about. Defaults to "uiservice", the one that generates a UI service from a table or CDS view.'
            }
          }
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'rapGenIsAvailable':
        return this.handleRapGenIsAvailable(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown RAP tool: ${toolName}`);
    }
  }

  async handleRapGenIsAvailable(args: any): Promise<any> {
    const startTime = performance.now();
    const generatorId = args?.generatorId || 'uiservice';
    try {
      const available = await this.readClient.rapGenIsAvailable(generatorId);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            generatorId,
            available,
            note: available
              ? 'The generator answers. The generation calls themselves are not wrapped by this server.'
              : 'This system has no RAP generator - a classic ERP release, or the service is switched off.'
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to ask whether the RAP generator is available');
    }
  }
}
