import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types, textElementsUrl } from 'abap-adt-api';
import type { TextElement, TextElementCategory } from 'abap-adt-api';
import { lockRegistry } from '../lib/lockRegistry';
import { describeAdtError } from '../lib/adtError';

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
              description: 'Object name, e.g. ZR_MM_FOO.'
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
              description: 'Escape hatch: the text elements base URL, e.g. /sap/bc/adt/textelements/programs/zr_mm_foo.'
            }
          }
        }
      },
      {
        name: 'setTextElements',
        description: 'Write the text elements of a program, class or function group. The write replaces the whole set for that category, so pass every element you want to keep - read them first with getTextElements. Needs a lock on the object (taken with lock, or already recorded here) and, outside $TMP, a transport request; activate afterwards.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZR_MM_FOO.'
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
              description: 'Object URL the lock was taken on; derived from objectName and objectType when omitted.'
            },
            lockHandle: {
              type: 'string',
              description: 'Lock handle; omit to use the one this server recorded for the object.'
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

    const objectUrl = this.objectUrl(args, objectType);
    const held = lockRegistry.forUrl(objectUrl);
    const lockHandle = args?.lockHandle || held?.lockHandle;
    if (!lockHandle) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No lockHandle given and none recorded for ${objectUrl}. Call lock on that URL first - text elements have their own URL, but the lock belongs to the object.`
      );
    }

    const startTime = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setTextElements(url, category, elements, lockHandle, args?.transport);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        written: true,
        url,
        objectUrl,
        category,
        count: elements.length,
        lockHandleFrom: args?.lockHandle ? 'argument' : 'lockRegistry',
        hint: 'The whole set for this category was replaced. Release the lock with unLock and activate the object.'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      const missing = missingEndpointHint(error);
      throw wrapAdtError(
        error,
        missing
          ? `Failed to write the ${category} of ${url}. ${missing}`
          : `Failed to write the ${category} of ${url}`
      );
    }
  }
}
