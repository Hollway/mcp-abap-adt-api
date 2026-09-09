import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCache } from '../lib/sourceCache';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, session_types } from "abap-adt-api";

export class ObjectDeletionHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'deleteObject',
        description: 'Delete an object. It needs an edit lock (this server passes the handle it holds, so lock the object first) and, outside $TMP, a transport request. Deleting does not release the lock - the backend leaves it, pointing at an object that no longer exists - so this releases it and forgets it, and drops the cached source with it. Not undoable from here: the object is gone and only a transport of the deletion travels on.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { 
              type: 'string',
              description: 'URL of the object to delete'
            },
            lockHandle: { 
              type: 'string',
              description: 'Lock handle for the object; omit to use the one this server recorded for it (see listLocks)'
            },
            transport: { 
              type: 'string',
              description: 'Transport request number'
            }
          },
          required: ['objectUrl']
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
    // A lock this process already took is the one to delete with: asking for
    // the handle again when the server is holding it is friction, and the
    // backend's answer to a missing handle - "user is already processing this
    // object" - reads like somebody else has it open.
    const held = lockRegistry.forUrl(args?.objectUrl);
    const lockHandle = args?.lockHandle || held?.lockHandle;
    if (!lockHandle) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No lockHandle given and none recorded for ${args?.objectUrl}. Call lock on that URL first.`
      );
    }

    const startTime = performance.now();
    try {
      // dropSession/logout reset the client to stateless; deletion requires a stateful session
      this.adtclient.stateful = session_types.stateful;
      const result = await this.adtclient.deleteObject(
        args.objectUrl,
        lockHandle,
        args.transport
      );
      // Deleting an object does not release its lock: the lock survives, and
      // the registry would keep pointing at an object that no longer exists.
      // Release it here (best effort - the deletion itself has succeeded, so a
      // failure to unlock must not turn into a failed call).
      let lockReleased = false;
      let lockError: string | undefined;
      try {
        await this.adtclient.unLock(args.objectUrl, lockHandle);
        lockReleased = true;
      } catch (unlockError: any) {
        lockError = describeAdtError(unlockError).error;
      }
      lockRegistry.forget(args.objectUrl);
      // The source cache would otherwise still hold the text of the object -
      // and a syntax check reusing that text reports an object that no longer
      // exists as fine.
      const sourceCacheDropped = sourceCache.forgetUnder(args.objectUrl);

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
              ...(sourceCacheDropped ? { sourceCacheDropped } : {}),
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
