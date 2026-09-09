import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import { lockRegistry } from '../lib/lockRegistry';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, session_types } from "abap-adt-api";

export class ObjectLockHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [{
      name: 'lock',
      description: 'Take an edit lock on an object, which every write needs. The handle it returns is what setObjectSource, patchObjectSource and deleteObject take - and it lives and dies with the ADT session, so a lost session voids it and the object has to be locked again. This server remembers the handle per object, so the write tools find it themselves and listLocks shows what is held. The lock must be RELEASED BEFORE ACTIVATING: activation refuses to run while the same session holds it. Prefer editObject, which takes and releases the lock around the change for you.',
      inputSchema: {
        type: 'object',
        properties: {
          objectUrl: { 
            type: 'string',
            description: 'URL of the object to lock'
          },
          accessMode: { 
            type: 'string',
            description: 'Access mode for the lock'
          }
        },
        required: ['objectUrl']
      }
    }, {
      name: 'unLock',
      description: 'Release an edit lock. Pass the handle, or leave it out and the one this server recorded for that object is used (see listLocks). Do it before activating - activation refuses while the session still holds the lock - and remember that deleting an object does NOT release its lock, so deleteObject releases it for you.',
      inputSchema: {
        type: 'object',
        properties: {
          objectUrl: { 
            type: 'string',
            description: 'URL of the object to unlock'
          },
          lockHandle: {
            type: 'string',
            description: 'Lock handle obtained from previous lock operation; omit to use the one this server recorded for the object (see listLocks)'
          }
        },
        required: ['objectUrl']
      }
    }, {
      name: 'listLocks',
      description: 'List the object locks this server currently holds, with their lock handles and when they were taken. Locks are otherwise invisible and outlive the edit that needed them.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }, {
      name: 'unlockAll',
      description: 'Release every lock this server holds. Use it to clean up after an edit that was abandoned; call listLocks first if you want to see what will be released.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }];
  }
  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'lock':
        return this.handleLock(args);
      case 'unLock':
        return this.handleUnlock(args);
      case 'listLocks':
        return this.handleListLocks();
      case 'unlockAll':
        return this.handleUnlockAll();
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object lock tool: ${toolName}`);
    }
  }

  private async handleListLocks(): Promise<any> {
    const locks = lockRegistry.all();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            count: locks.length,
            locks
          })
        }
      ]
    };
  }

  /**
   * Best effort: keep going after a failure so one stale handle cannot block
   * the release of the others, and report each outcome.
   */
  private async handleUnlockAll(): Promise<any> {
    const locks = lockRegistry.all();
    const released: string[] = [];
    const failed: { objectUrl: string; error: string }[] = [];

    for (const lock of locks) {
      const startTime = performance.now();
      try {
        this.adtclient.stateful = session_types.stateful;
        await this.adtclient.unLock(lock.objectUrl, lock.lockHandle);
        lockRegistry.forget(lock.objectUrl);
        released.push(lock.objectUrl);
        this.trackRequest(startTime, true);
      } catch (error: any) {
        this.trackRequest(startTime, false);
        failed.push({
          objectUrl: lock.objectUrl,
          error: describeAdtError(error).error
        });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: failed.length === 0 ? 'success' : 'partial',
            released,
            failed,
            remaining: lockRegistry.count()
          })
        }
      ]
    };
  }

  async handleLock(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      // dropSession/logout reset the client to stateless; locks require a stateful session
      this.adtclient.stateful = session_types.stateful;
      const lockResult = await this.adtclient.lock(args.objectUrl, args.accessMode);
      // Remember it so it can be listed and released later - see lib/lockRegistry.
      lockRegistry.remember(args.objectUrl, lockResult.LOCK_HANDLE, args.accessMode);
      this.trackRequest(startTime, true);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              lockHandle: lockResult.LOCK_HANDLE,
              locksHeld: lockRegistry.count(),
              message: 'Object locked successfully'
            })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to lock object');
    }
  }

  async handleUnlock(args: any): Promise<any> {
    const held = lockRegistry.forUrl(args?.objectUrl);
    const lockHandle = args?.lockHandle || held?.lockHandle;
    if (!lockHandle) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No lockHandle given and none recorded for ${args?.objectUrl}. listLocks shows what this server holds.`
      );
    }

    const startTime = performance.now();
    try {
      // dropSession/logout reset the client to stateless; locks require a stateful session
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.unLock(args.objectUrl, lockHandle);
      lockRegistry.forget(args.objectUrl);
      this.trackRequest(startTime, true);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              locksHeld: lockRegistry.count(),
              message: 'Object unlocked successfully'
            })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to unlock object');
    }
  }
}
