import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { activateAndVerify, selectInactive } from '../lib/activation';
import {
  descriptionTarget,
  checkedDescription,
  parseDescriptionDocument,
  withDescription,
  DescriptionError,
  MAX_DESCRIPTION,
  type DescriptionTarget,
  type DescriptionDocument
} from '../lib/objectDescription';

const CONTENT_TYPES: Record<DescriptionTarget['type'], string> = {
  CLAS: 'application/vnd.sap.adt.oo.classes.v2+xml',
  INTF: 'application/vnd.sap.adt.oo.interfaces.v2+xml'
};

interface ReadDocument {
  xml: string;
  contentType: string;
  parsed: DescriptionDocument;
}

/**
 * The description of a class or an interface, written the way Eclipse writes
 * it: the metadata document read, its description replaced, PUT back under a
 * lock and activated. See lib/objectDescription for what the backend does with
 * it and why the document is never built from scratch.
 */
export class ObjectDescriptionHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'setObjectDescription',
        description: `Change the description of a class or an interface - the text SE24 shows under Properties and SE80 shows in the package tree. It is metadata, not source, so editObject cannot reach it. The metadata document is read, only its description is replaced, and it is written back under a lock with the transport, the way Eclipse does it, and the class builder saves it. The write leaves the object inactive, so it is activated afterwards - and because an activation takes every inactive part of the object along, an object that already has inactive changes is refused unless activate is false. At most ${MAX_DESCRIPTION} characters. The text is written in the logon language. Outside $TMP a transport request is required.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Class or interface name, e.g. ZCL_APP or ZIF_APP.'
            },
            description: {
              type: 'string',
              description: `The new description, at most ${MAX_DESCRIPTION} characters.`
            },
            objectType: {
              type: 'string',
              description: 'CLAS or INTF. Only needed when the name does not say it (CL_/CX_ is a class, IF_ an interface).'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. Required outside $TMP.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate afterwards (default true). With false the object is left inactive and other inactive changes of it are no reason to refuse.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Read the current description and check the new one, without locking or writing.'
            }
          },
          required: ['name', 'description']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'setObjectDescription':
        return this.answer(await this.setObjectDescriptionCore(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object description tool: ${toolName}`);
    }
  }

  private checked<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error: any) {
      if (error instanceof DescriptionError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }
  }

  /**
   * Read the metadata document on the stateful client: the read decides what
   * gets written, so it belongs to the session that will hold the lock.
   */
  private async readDocument(target: DescriptionTarget): Promise<ReadDocument> {
    const startTime = performance.now();
    try {
      const response = await this.adtclient.httpClient.request(target.objectUrl, { method: 'GET' });
      this.trackRequest(startTime, true);
      const xml = String(response.body ?? '');
      const contentType = String(response.headers?.['content-type'] ?? '').split(';')[0].trim();
      return {
        xml,
        contentType: contentType || CONTENT_TYPES[target.type],
        parsed: this.checked(() => parseDescriptionDocument(xml))
      };
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      this.trackRequest(startTime, false);
      throw wrapAdtError(
        error,
        describeAdtError(error).status === 404
          ? `${target.name} does not exist as ${target.type === 'CLAS' ? 'a class' : 'an interface'}`
          : `Failed to read the metadata of ${target.name}`
      );
    }
  }

  async setObjectDescriptionCore(args: any): Promise<Record<string, unknown>> {
    const target = this.checked(() => descriptionTarget(args?.name ?? args?.className, args?.objectType));
    const description = this.checked(() => checkedDescription(args?.description));
    const activate = args?.activate !== false;
    const transport = args?.transport ? String(args.transport).trim().toUpperCase() : '';
    const logonLanguage = String(this.adtclient.language || '').trim().toUpperCase();

    const before = await this.readDocument(target);
    const { packageName, masterLanguage } = before.parsed;
    const base = {
      name: target.name,
      type: target.adtType,
      objectUrl: target.objectUrl,
      packageName,
      before: before.parsed.description,
      after: description,
      language: logonLanguage || before.parsed.language,
      ...(masterLanguage && logonLanguage && masterLanguage.toUpperCase() !== logonLanguage
        ? { note: `The master language of ${target.name} is ${masterLanguage} and the text is written in the logon language ${logonLanguage}, so SE24 in ${masterLanguage} keeps showing the old one.` }
        : {})
    };

    if (before.parsed.description === description) {
      return {
        status: 'success',
        ...base,
        written: false,
        hint: 'The description is already this text. Nothing was written.'
      };
    }

    if (packageName && !packageName.startsWith('$') && !transport) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${target.name} is in package ${packageName}, so changing its description needs a transport request (the request itself, not a developer task).`
      );
    }

    if (activate) {
      const inactive = selectInactive(await this.adtclient.inactiveObjects(), target.name, target.objectUrl);
      if (inactive.length) {
        return {
          status: 'error',
          ...base,
          written: false,
          inactive: inactive.map(e => ({ name: e['adtcore:name'], type: e['adtcore:type'] })),
          hint: `${target.name} already has inactive changes, and activating the new description would activate them too. Nothing was written. Activate or discard them first, or pass activate: false and activate later yourself.`
        };
      }
    }

    if (args?.dryRun === true) {
      return {
        status: 'success',
        ...base,
        dryRun: true,
        written: false,
        hint: 'Checked and not written. Run again without dryRun to write it.'
      };
    }

    const steps: Record<string, unknown>[] = [];
    let lockHandle: string;
    let takenHere: boolean;
    try {
      const lock = await takeLock(this.adtclient, target.objectUrl, undefined, (start, ok) => this.trackRequest(start, ok));
      lockHandle = lock.lockHandle;
      takenHere = lock.taken;
    } catch (error: any) {
      steps.push({ step: 'lock', error: describeAdtError(error).error });
      return {
        status: 'error',
        ...base,
        written: false,
        steps,
        hint: 'Nothing was written: the object could not be locked. Somebody may be editing it.'
      };
    }
    steps.push({ step: 'lock', reused: !takenHere });

    const writeStart = performance.now();
    try {
      const qs: Record<string, string> = { lockHandle };
      if (transport) qs.corrNr = transport;
      await this.adtclient.httpClient.request(target.objectUrl, {
        method: 'PUT',
        qs,
        headers: { 'Content-Type': before.contentType },
        body: withDescription(before.xml, description)
      });
      this.trackRequest(writeStart, true);
      steps.push({ step: 'write' });
    } catch (error: any) {
      this.trackRequest(writeStart, false);
      steps.push({ step: 'write', error: describeAdtError(error).error });
      if (takenHere) steps.push({ step: 'unlock', ...(await this.release(target.objectUrl, lockHandle)) });
      return {
        status: 'error',
        ...base,
        written: false,
        steps,
        hint: 'The backend refused the write, so the description is unchanged.'
      };
    }

    let released = true;
    if (takenHere) {
      const unlock = await this.release(target.objectUrl, lockHandle);
      released = unlock.released;
      steps.push({ step: 'unlock', ...unlock });
    }

    let activated = false;
    if (activate && released) {
      const startTime = performance.now();
      try {
        const outcome = await activateAndVerify(this.adtclient, {
          objectUrl: target.objectUrl,
          objectName: target.name
        });
        this.trackRequest(startTime, true);
        activated = outcome.success;
        steps.push({ step: 'activate', ...outcome });
      } catch (error: any) {
        this.trackRequest(startTime, false);
        steps.push({ step: 'activate', error: describeAdtError(error).error });
      }
    }

    const after = await this.readDocument(target);
    const landed = after.parsed.description === description;
    const ok = landed && (activated || !activate);
    return {
      status: ok ? 'success' : 'error',
      ...base,
      written: landed,
      activated,
      readBack: after.parsed.description,
      steps,
      hint: !landed
        ? `The backend accepted the write but the description reads back as '${after.parsed.description}'. Check the transport request and SE24.`
        : !activate
          ? 'Written; the object is inactive until it is activated (activateSafe).'
          : !released
            ? 'Written, but the lock would not come off, so it was not activated. Release it (unlockAll) and run activateSafe.'
            : activated
              ? 'Written and active, saved by the class builder with the transport given.'
              : 'Written but the activation did not finish - see the activate step, then run activateSafe.'
    };
  }

  private async release(objectUrl: string, lockHandle: string) {
    return releaseLock(this.adtclient, objectUrl, lockHandle, (start, ok) => this.trackRequest(start, ok));
  }
}
