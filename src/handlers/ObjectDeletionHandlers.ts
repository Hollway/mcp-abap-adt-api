import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import { lockRegistry } from '../lib/lockRegistry';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, session_types } from "abap-adt-api";

export class ObjectDeletionHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'deleteObject',
        description: 'Deletes an ABAP object from the system',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { 
              type: 'string',
              description: 'URL of the object to delete'
            },
            lockHandle: { 
              type: 'string',
              description: 'Lock handle for the object'
            },
            transport: { 
              type: 'string',
              description: 'Transport request number'
            }
          },
          required: ['objectUrl', 'lockHandle']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'deleteObject':
        return this.handleDeleteObject(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object deletion tool: ${toolName}`);
    }
  }

  async handleDeleteObject(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      // dropSession/logout reset the client to stateless; deletion requires a stateful session
      this.adtclient.stateful = session_types.stateful;
      const result = await this.adtclient.deleteObject(
        args.objectUrl,
        args.lockHandle,
        args.transport
      );
      // Deleting an object does not release its lock: the lock survives, and
      // the registry would keep pointing at an object that no longer exists.
      // Release it here (best effort - the deletion itself has succeeded, so a
      // failure to unlock must not turn into a failed call).
      let lockReleased = false;
      let lockError: string | undefined;
      try {
        await this.adtclient.unLock(args.objectUrl, args.lockHandle);
        lockReleased = true;
      } catch (unlockError: any) {
        lockError = describeAdtError(unlockError).error;
      }
      lockRegistry.forget(args.objectUrl);

      this.trackRequest(startTime, true);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              result,
              lockReleased,
              ...(lockError ? { lockError } : {}),
              locksHeld: lockRegistry.count(),
              message: 'Object deleted successfully'
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to delete object');
    }
  }
}
