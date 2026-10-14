import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCache } from '../lib/sourceCache';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, session_types } from "abap-adt-api";
import { takeLock } from '../lib/lockCycle';
import { MessageDeletionHandlers } from './MessageDeletionHandlers';

/** A message class URL, and a message inside one - which is deleted with deleteMessages. */
const MESSAGE_CLASS_URL = /^\/sap\/bc\/adt\/messageclass\/([^/?#]+)\/?(?:[?#].*)?$/i;
const MESSAGE_URL = /^\/sap\/bc\/adt\/messageclass\/[^/?#]+\/messages\//i;

export class ObjectDeletionHandlers extends BaseHandler {
  private messageDeletion?: MessageDeletionHandlers;

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'deleteObject',
        description: 'Delete an object. It takes the edit lock itself when this server is not already holding one, and outside $TMP it needs a transport request. Deleting does not release the lock - the backend leaves it, pointing at an object that no longer exists - so this releases it and forgets it, and drops the cached source with it. Not undoable from here: the object is gone and only a transport of the deletion travels on. A message class is the exception and takes two calls: ADT deletes one leaving the long texts of every message behind, and on a transportable class it can answer success with the class still there, so it is deleted as SE91 does it - the first call previews the class (messages, languages, long texts, where it is used) and returns a previewToken, the second, with that token, deletes the class with its texts and long texts and records R3TR MSAG with function D in your task.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { 
              type: 'string',
              description: 'URL of the object to delete'
            },
            lockHandle: { 
              type: 'string',
              description: 'Lock handle for the object; omit to use the one this server recorded for it (see listLocks), or to have the lock taken here'
            },
            transport: {
              type: 'string',
              description: 'Transport request number'
            },
            previewToken: {
              type: 'string',
              description: 'Message classes only: the token of the preview this deletion confirms. Omit it to get the preview.'
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
    const objectUrl = String(args?.objectUrl || '').trim();
    if (!objectUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass objectUrl - the ADT URL of the object to delete.');
    }
    if (MESSAGE_URL.test(objectUrl)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'That is a message inside a class, which ADT does not delete. Use deleteMessages with the class and the number.'
      );
    }
    const messageClass = MESSAGE_CLASS_URL.exec(objectUrl);
    if (messageClass) return this.deleteMessageClass(objectUrl, decodeURIComponent(messageClass[1]), args);

    const held = lockRegistry.forUrl(objectUrl);
    let lockHandle = args?.lockHandle || held?.lockHandle;
    // Nothing held, nothing passed: take the lock rather than refuse. Demanding
    // a separate lock call first was friction with no safety in it - the caller
    // has already asked for the object to be deleted - and it made the obvious
    // cleanup after a createAndWrite fail, because that call releases its lock
    // when it is done.
    if (!lockHandle) {
      try {
        const taken = await takeLock(this.adtclient, objectUrl, 'MODIFY', (t, ok) => this.trackRequest(t, ok));
        lockHandle = taken.lockHandle;
      } catch (error: any) {
        // A release without an ADT address for domains or tables answers 404 on
        // the lock already; deleteDdicObject reaches them without one.
        const ddic = /\/sap\/bc\/adt\/ddic\/(domains|dataelements|tables|structures)\//i.test(objectUrl);
        const missing = describeAdtError(error).status === 404;
        throw wrapAdtError(
          error,
          `Could not lock ${objectUrl} for deletion` +
            (ddic && missing ? ' - this system serves no ADT address for it; use deleteDdicObject with the type and name' : '')
        );
      }
    }

    return this.tracked('Failed to delete object', async () => {
      // dropSession/logout reset the client to stateless; deletion requires a stateful session
      this.adtclient.stateful = session_types.stateful;
      const result = await this.adtclient.deleteObject(
        objectUrl,
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
        await this.adtclient.unLock(objectUrl, lockHandle);
        lockReleased = true;
      } catch (unlockError: any) {
        lockError = describeAdtError(unlockError).error;
      }
      lockRegistry.forget(objectUrl);
      // The source cache would otherwise still hold the text of the object -
      // and a syntax check reusing that text reports an object that no longer
      // exists as fine.
      const sourceCacheDropped = sourceCache.forgetUnder(objectUrl);
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
    });
  }

  /**
   * A message class goes the SE91 way (MessageDeletionHandlers). That takes
   * the SE91 lock, which an ADT lock this server holds on the class would
   * refuse - so the deletion itself releases it first; the preview leaves it.
   */
  private async deleteMessageClass(objectUrl: string, name: string, args: any): Promise<any> {
    if (args?.previewToken) {
      const held = lockRegistry.forUrl(objectUrl);
      if (held) {
        try {
          await this.adtclient.unLock(objectUrl, held.lockHandle);
        } catch {
          // Gone already, or not ours to release: the deletion reports a lock it still meets.
        }
        lockRegistry.forget(objectUrl);
      }
    }
    this.messageDeletion ||= new MessageDeletionHandlers(this.adtclient);
    const result = await this.messageDeletion.deleteMessageClassCore(name, args);
    try {
      if (JSON.parse(result?.content?.[0]?.text ?? '{}').deleted === true) sourceCache.forgetUnder(objectUrl);
    } catch {
      // Not JSON: nothing to read the outcome from, and nothing cached is at stake.
    }
    return result;
  }
}
