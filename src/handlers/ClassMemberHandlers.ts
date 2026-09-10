import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { ObjectSourceHandlers } from './ObjectSourceHandlers.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import type { ADTClient } from 'abap-adt-api';
import { classSourceUrl } from '../lib/symbolPosition';
import {
  planAddMethod,
  planAddAttribute,
  planDeleteMethod,
  ClassEditError
} from '../lib/classEdit';
import type { MethodSpec, AttributeSpec, Visibility } from '../lib/classEdit';

/**
 * Members of a class as one operation each.
 *
 * A method lives in two places in one source: the declaration in a visibility
 * section and the implementation in the IMPLEMENTATION part. Adding one by
 * hand means reading the source, finding both places, matching the class's own
 * indentation, and writing two edits whose line numbers must both still hold -
 * and then the same lock/write/unlock/activate sequence as any other change.
 *
 * The edits are planned here (lib/classEdit) and handed to editObject, so the
 * lock cycle, the diff and the activation check are the ones already proven
 * rather than a second implementation of them.
 */

const PARAMETER_SCHEMA = {
  type: 'array',
  description: 'Parameters as data: [{name, type, optional?, default?}].',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', description: 'ABAP type, e.g. i, string, mara-matnr, ztt_foo.' },
      optional: { type: 'boolean', description: 'IMPORTING only: mark it OPTIONAL.' },
      default: { type: 'string', description: 'IMPORTING only: DEFAULT <this>, e.g. abap_true.' }
    },
    required: ['name', 'type']
  }
};

export class ClassMemberHandlers extends BaseHandler {
  private readonly editor: ObjectSourceHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.editor = new ObjectSourceHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'addMethod',
        description: 'Add a method to a class: the declaration goes into the visibility section, the implementation before the closing ENDCLASS, and the whole lock/write/unlock/activate sequence follows. The signature is passed as data and the ABAP is built here, in the indentation the class already uses. This is otherwise two patchObjectSource edits into two different parts of one source, with line numbers that both have to be right. A method that is already there is refused with the line it is on, rather than declared twice. Pass dryRun to see the diff without writing.',
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'Class name, e.g. ZCL_APP.' },
            methodName: { type: 'string', description: 'Name of the new method.' },
            visibility: {
              type: 'string',
              description: 'public, protected or private. Default public.'
            },
            static: { type: 'boolean', description: 'CLASS-METHODS rather than METHODS.' },
            importing: PARAMETER_SCHEMA,
            exporting: PARAMETER_SCHEMA,
            changing: PARAMETER_SCHEMA,
            returning: {
              type: 'object',
              description: 'Returning parameter: {name, type}. Becomes RETURNING VALUE(name) TYPE type.',
              properties: { name: { type: 'string' }, type: { type: 'string' } }
            },
            raising: {
              type: 'array',
              description: 'Exception classes, e.g. ["cx_sy_zerodivide"].',
              items: { type: 'string' }
            },
            implementation: {
              type: 'array',
              description: 'Body lines, without METHOD/ENDMETHOD. Omit and a TODO comment is left in their place.',
              items: { type: 'string' }
            },
            declaration: {
              type: 'string',
              description: 'Declaration text to use verbatim instead of building one from the parameters above. For a signature this cannot express.'
            },
            transport: {
              type: 'string',
              description: 'Transport request. The number of the REQUEST, not of a task inside it.'
            },
            activate: { type: 'boolean', description: 'Activate afterwards (default true).' },
            dryRun: { type: 'boolean', description: 'Show the diff without locking or writing.' }
          },
          required: ['className', 'methodName']
        }
      },
      {
        name: 'deleteMethod',
        description: 'Remove a method from a class - both its declaration and its implementation - and activate. A declaration inside a METHODS: chain is handled: the entry goes, and if it was the last one the chain is closed so it still compiles. What it will not do is guess at a line that declares two methods at once; that is refused and named, because rewriting it wrong takes somebody else\'s method with it. Pass dryRun to see the diff first, and check usageReferences before removing a method that anything calls.',
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'Class name, e.g. ZCL_APP.' },
            methodName: { type: 'string', description: 'Method to remove.' },
            transport: { type: 'string', description: 'Transport request for the change.' },
            activate: { type: 'boolean', description: 'Activate afterwards (default true).' },
            dryRun: { type: 'boolean', description: 'Show the diff without locking or writing.' }
          },
          required: ['className', 'methodName']
        }
      },
      {
        name: 'addAttribute',
        description: 'Add an attribute or a constant to a class - DATA, CLASS-DATA or CONSTANTS - into the section you name, then activate. Defaults to a private DATA, which is what an attribute usually is; a constant needs a value, and READ-ONLY is only accepted on a public one. Pass dryRun to see the diff without writing.',
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'Class name, e.g. ZCL_APP.' },
            attributeName: { type: 'string', description: 'Name of the new attribute.' },
            type: { type: 'string', description: 'ABAP type, e.g. string, i, mara-matnr, ztt_foo.' },
            visibility: {
              type: 'string',
              description: 'public, protected or private. Default private.'
            },
            static: { type: 'boolean', description: 'CLASS-DATA rather than DATA.' },
            constant: { type: 'boolean', description: 'CONSTANTS rather than DATA; needs a value.' },
            value: {
              type: 'string',
              description: `VALUE for the declaration, written as ABAP: 'X' with the quotes, or 42.`
            },
            readOnly: { type: 'boolean', description: 'READ-ONLY. Public attributes only.' },
            transport: { type: 'string', description: 'Transport request for the change.' },
            activate: { type: 'boolean', description: 'Activate afterwards (default true).' },
            dryRun: { type: 'boolean', description: 'Show the diff without locking or writing.' }
          },
          required: ['className', 'attributeName', 'type']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'addMethod':
        return this.handleAddMethod(args);
      case 'deleteMethod':
        return this.handleDeleteMethod(args);
      case 'addAttribute':
        return this.handleAddAttribute(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown class member tool: ${toolName}`);
    }
  }

  private className(args: any): string {
    const name = String(args?.className || '').trim();
    if (!name) throw new McpError(ErrorCode.InvalidParams, 'Pass className.');
    return name.toUpperCase();
  }

  private visibility(value: unknown, fallback: Visibility): Visibility {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return fallback;
    if (text !== 'public' && text !== 'protected' && text !== 'private') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `visibility must be public, protected or private; got "${value}".`
      );
    }
    return text;
  }

  /** The working version of the class source - the one about to be changed. */
  private async readSource(className: string): Promise<{ sourceUrl: string; source: string }> {
    const sourceUrl = classSourceUrl(className);
    try {
      const source = await this.readClient.getObjectSource(sourceUrl);
      return { sourceUrl, source };
    } catch (error: any) {
      throw wrapAdtError(error, `Failed to read the source of ${className}`);
    }
  }

  /**
   * Hand the planned edits to editObject and report what it did, with what was
   * planned in front of it. A ClassEditError is the caller's mistake, not a
   * backend failure, so it comes back as an invalid-parameter refusal.
   */
  private async applyEdits(
    args: any,
    sourceUrl: string,
    edits: unknown[],
    member: Record<string, unknown>
  ): Promise<any> {
    const result = await this.editor.handleEditObject({
      objectSourceUrl: sourceUrl,
      edits,
      transport: args?.transport,
      activate: args?.activate,
      dryRun: args?.dryRun === true
    });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result.content[0].text);
    } catch {
      return result;
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...payload, member }, null, 2)
      }]
    };
  }

  private planned<T>(plan: () => T): T {
    try {
      return plan();
    } catch (error: any) {
      if (error instanceof ClassEditError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  }

  async handleAddMethod(args: any): Promise<any> {
    const className = this.className(args);
    const methodName = String(args?.methodName || '').trim();
    if (!methodName) throw new McpError(ErrorCode.InvalidParams, 'Pass methodName.');

    const spec: MethodSpec = {
      name: methodName,
      visibility: this.visibility(args?.visibility, 'public'),
      static: args?.static === true,
      importing: this.parseObjectArg(args?.importing, 'importing'),
      exporting: this.parseObjectArg(args?.exporting, 'exporting'),
      changing: this.parseObjectArg(args?.changing, 'changing'),
      returning: this.parseObjectArg(args?.returning, 'returning'),
      raising: this.parseObjectArg(args?.raising, 'raising'),
      implementation: this.parseObjectArg(args?.implementation, 'implementation'),
      declaration: args?.declaration
    };

    const { sourceUrl, source } = await this.readSource(className);
    const edits = this.planned(() => planAddMethod(source, spec));
    return this.applyEdits(args, sourceUrl, edits, {
      action: 'addMethod',
      className,
      methodName: methodName.toUpperCase(),
      visibility: spec.visibility,
      static: spec.static === true
    });
  }

  async handleDeleteMethod(args: any): Promise<any> {
    const className = this.className(args);
    const methodName = String(args?.methodName || '').trim();
    if (!methodName) throw new McpError(ErrorCode.InvalidParams, 'Pass methodName.');

    const { sourceUrl, source } = await this.readSource(className);
    const edits = this.planned(() => planDeleteMethod(source, methodName));
    return this.applyEdits(args, sourceUrl, edits, {
      action: 'deleteMethod',
      className,
      methodName: methodName.toUpperCase(),
      removed: edits.map(edit => (edit as any).describe)
    });
  }

  async handleAddAttribute(args: any): Promise<any> {
    const className = this.className(args);
    const attributeName = String(args?.attributeName || '').trim();
    const type = String(args?.type || '').trim();
    if (!attributeName) throw new McpError(ErrorCode.InvalidParams, 'Pass attributeName.');
    if (!type) throw new McpError(ErrorCode.InvalidParams, 'Pass type.');

    const spec: AttributeSpec = {
      name: attributeName,
      type,
      visibility: this.visibility(args?.visibility, 'private'),
      static: args?.static === true,
      constant: args?.constant === true,
      value: args?.value,
      readOnly: args?.readOnly === true
    };

    const { sourceUrl, source } = await this.readSource(className);
    const edits = this.planned(() => planAddAttribute(source, spec));
    return this.applyEdits(args, sourceUrl, edits, {
      action: 'addAttribute',
      className,
      attributeName: attributeName.toUpperCase(),
      visibility: spec.visibility,
      kind: spec.constant ? 'constant' : spec.static ? 'class-data' : 'data'
    });
  }
}
