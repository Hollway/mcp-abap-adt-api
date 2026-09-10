import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types, textElementsUrl } from 'abap-adt-api';
import type { TextElement, TextElementCategory } from 'abap-adt-api';
import { lockRegistry } from '../lib/lockRegistry';
import { describeAdtError } from '../lib/adtError';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { activateAndVerify } from '../lib/activation';

/**
 * Not every release serves text elements over REST.
 *
 * On the ERP system these tools were written against, /sap/bc/adt/textelements
 * does not exist at all: objectStructure offers text elements only as a SAPGUI
 * link. A bare 404 there reads like a wrong object name, which is the wrong
 * thing to go and check.
 */
const missingEndpointHint = (error: unknown): string | undefined => {
  const info = describeAdtError(error);
  if (info.status !== 404) return undefined;
  return 'This release does not serve text elements over ADT: /sap/bc/adt/textelements is not there at all, ' +
    'and ADT itself offers them only through the SAPGUI bridge (transaction SE38 -> Goto -> Text elements). ' +
    'Nothing is wrong with the object name.';
};

const CATEGORIES: TextElementCategory[] = ['symbols', 'selections', 'headings'];

/**
 * Text symbols, selection texts and list headings.
 *
 * These live outside the source: a report's TEXT-001 and the label of a
 * PARAMETERS field are stored per language and are invisible to
 * getObjectSource, so a program written through this server used to come out
 * with numbered fields and empty selection screens no matter how complete its
 * code was.
 */
export class TextElementHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getTextElements',
        description: 'Read the text elements of a program, class or function group: text symbols (TEXT-001), selection texts (the labels of PARAMETERS and SELECT-OPTIONS) or list headings. These are stored per language outside the source, so getObjectSource never shows them.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZR_APP_FOO.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type of the object: PROG/P, CLAS/OC, FUGR/F. Defaults to PROG/P.'
            },
            category: {
              type: 'string',
              description: 'Which set to read: "symbols" (default), "selections" or "headings".',
              enum: [...CATEGORIES]
            },
            url: {
              type: 'string',
              description: 'Escape hatch: the text elements base URL, e.g. /sap/bc/adt/textelements/programs/zr_app_foo.'
            }
          }
        }
      },
      {
        name: 'setTextElements',
        description: 'Write the text elements of a program, class or function group. The write replaces the whole set for that category, so pass every element you want to keep - read them first with getTextElements. The lock is taken on the text elements resource - not on the object - and released again, unless you pass a handle or this server already holds one; outside $TMP a transport request is needed. Pass activate to finish the job, or run activateSafe afterwards: a text write leaves both the object and its text pool inactive.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZR_APP_FOO.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type of the object: PROG/P, CLAS/OC, FUGR/F. Defaults to PROG/P.'
            },
            category: {
              type: 'string',
              description: 'Which set to write: "symbols" (default), "selections" or "headings".',
              enum: [...CATEGORIES]
            },
            elements: {
              type: 'array',
              description: 'The complete set for this category: [{id, text, maxLength, ddicReference}]. For selection texts the id is the field name, e.g. P_WERKS; for text symbols the three-character number, e.g. 001.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  maxLength: { type: 'number' },
                  ddicReference: { type: 'string' }
                },
                required: ['id', 'text']
              }
            },
            objectUrl: {
              type: 'string',
              description: 'Object URL, used for the activation; derived from objectName and objectType when omitted. The lock is not taken on this - it goes on the text elements resource.'
            },
            lockHandle: {
              type: 'string',
              description: 'Lock handle. Omit it: the one this server holds for the object is used, and with none held the lock is taken and released here.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate the object after the write (default false). Only possible when this tool took the lock itself - activation is refused while a session holds one.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task.'
            },
            url: {
              type: 'string',
              description: 'Escape hatch: the text elements base URL.'
            }
          },
          required: ['elements']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'getTextElements':
        return this.handleGetTextElements(args);
      case 'setTextElements':
        return this.handleSetTextElements(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown text element tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  private category(args: any): TextElementCategory {
    const given = String(args?.category || 'symbols');
    if (!CATEGORIES.includes(given as TextElementCategory)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown category '${given}'. It is one of: ${CATEGORIES.join(', ')}.`
      );
    }
    return given as TextElementCategory;
  }

  /** The text elements base URL, built from the object unless given outright. */
  private textUrl(args: any): { url: string; objectType: string } {
    const objectType = String(args?.objectType || 'PROG/P').toUpperCase();
    if (typeof args?.url === 'string' && args.url.trim()) {
      return { url: args.url.trim(), objectType };
    }
    const name = String(args?.objectName || '').trim();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Which object? Pass objectName (and objectType), or url.');
    }
    return { url: textElementsUrl(objectType, name), objectType };
  }

  /**
   * The object URL the lock belongs to. Text elements have their own URL
   * space, but the lock is taken on the object itself, so the two are not
   * interchangeable.
   */
  private objectUrl(args: any, objectType: string): string {
    if (typeof args?.objectUrl === 'string' && args.objectUrl.trim()) return args.objectUrl.trim();
    const name = String(args?.objectName || '').trim().toLowerCase();
    if (!name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Which object holds the lock? Pass objectName, or objectUrl.'
      );
    }
    const encoded = name.includes('/') ? encodeURIComponent(name) : name;
    if (objectType.startsWith('CLAS')) return `/sap/bc/adt/oo/classes/${encoded}`;
    if (objectType.startsWith('FUGR')) return `/sap/bc/adt/functions/groups/${encoded}`;
    return `/sap/bc/adt/programs/programs/${encoded}`;
  }

  async handleGetTextElements(args: any): Promise<any> {
    const { url } = this.textUrl(args);
    const category = this.category(args);
    const startTime = performance.now();
    try {
      const result = await this.readClient.getTextElements(url, category);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        url,
        category,
        count: (result?.textElements || []).length,
        ...result
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      const missing = missingEndpointHint(error);
      throw wrapAdtError(
        error,
        missing
          ? `Failed to read the ${category} of ${url}. ${missing}`
          : `Failed to read the ${category} of ${url}`
      );
    }
  }

  async handleSetTextElements(args: any): Promise<any> {
    const { url, objectType } = this.textUrl(args);
    const category = this.category(args);
    const elements: TextElement[] = this.parseObjectArg(args.elements, 'elements');
    if (!Array.isArray(elements)) {
      throw new McpError(ErrorCode.InvalidParams, 'elements must be an array of {id, text}.');
    }

    // The lock goes on the text elements resource itself, not on the object.
    // That is the opposite of what this handler assumed for as long as no
    // system served the endpoint: with a lock on the program, the write is
    // refused with 423 "Resource REPT ZFOO is not locked (invalid lock
    // handle)", naming REPT - the text pool - rather than the program.
    const objectUrl = this.objectUrl(args, objectType);
    const { lockHandle, from, taken } = await this.lockFor(url, args);

    const startTime = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setTextElements(url, category, elements, lockHandle, args?.transport);
      this.trackRequest(startTime, true);
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (taken) {
        await releaseLock(this.adtclient, url, lockHandle, (start, ok) => this.trackRequest(start, ok));
      }
      const missing = missingEndpointHint(error);
      throw wrapAdtError(
        error,
        missing
          ? `Failed to write the ${category} of ${url}. ${missing}`
          : `Failed to write the ${category} of ${url}`
      );
    }

    const steps: Record<string, unknown>[] = [];
    let released = !taken;
    if (taken) {
      const unlock = await releaseLock(
        this.adtclient,
        url,
        lockHandle,
        (start, ok) => this.trackRequest(start, ok)
      );
      released = unlock.released;
      steps.push({ step: 'unlock', ...unlock });
    }

    const common = {
      written: true,
      url,
      objectUrl,
      category,
      count: elements.length,
      lockHandleFrom: from
    };

    if (args?.activate !== true) {
      return this.answer({
        status: 'success',
        ...common,
        activated: false,
        ...(steps.length ? { steps } : {}),
        hint: taken
          ? `The whole set of ${category} was replaced and the lock is back off. Activate the object with activateSafe.`
          : `The whole set of ${category} was replaced. The lock is the one you hold, so release it before activating with activateSafe.`
      });
    }
    if (!released) {
      return this.answer({
        status: 'error',
        ...common,
        activated: false,
        steps,
        hint: 'Written, but the lock would not come off and activation fails while it is held. Release it (unlockAll) and run activateSafe.'
      });
    }

    const activateStart = performance.now();
    try {
      // A text write leaves TWO rows inactive: the object (PROG/P) and its text
      // pool (PROG/PX). Activating by name catches both, which activating the
      // object URL alone would not.
      const outcome = await activateAndVerify(this.adtclient, {
        objectUrl,
        objectName: String(args?.objectName || '').trim().toUpperCase() || undefined
      });
      this.trackRequest(activateStart, true);
      steps.push({ step: 'activate', ...outcome });
      return this.answer({
        status: outcome.success ? 'success' : 'error',
        ...common,
        activated: outcome.success,
        steps,
        hint: outcome.success
          ? `The whole set of ${category} was replaced and the object is active.`
          : 'Written but not active, so the texts are not the ones in use yet. Run activateSafe.'
      });
    } catch (error: any) {
      this.trackRequest(activateStart, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        ...common,
        activated: false,
        steps,
        hint: 'Written but not active. Nothing was rolled back; run activateSafe.'
      });
    }
  }

  /**
   * The lock to write with, taken on the text elements resource.
   *
   * A handle the caller passed, or one this process holds for that resource, is
   * used as it stands and left alone. With neither, the lock is taken here and
   * given back after the write - demanding a separate lock call made writing
   * one selection text a three-call sequence, and the URL it has to be taken on
   * is not the object's, which is exactly the mistake this handler used to make
   * itself.
   */
  private async lockFor(
    objectUrl: string,
    args: any
  ): Promise<{ lockHandle: string; from: string; taken: boolean }> {
    if (typeof args?.lockHandle === 'string' && args.lockHandle.trim()) {
      return { lockHandle: args.lockHandle.trim(), from: 'argument', taken: false };
    }
    const held = lockRegistry.forUrl(objectUrl);
    if (held) return { lockHandle: held.lockHandle, from: 'lockRegistry', taken: false };

    const lock = await takeLock(
      this.adtclient,
      objectUrl,
      undefined,
      (start, ok) => this.trackRequest(start, ok)
    );
    return { lockHandle: lock.lockHandle, from: 'takenHere', taken: lock.taken };
  }
}
