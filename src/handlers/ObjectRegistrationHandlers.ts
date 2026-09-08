import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';

export class ObjectRegistrationHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'objectRegistrationInfo',
        description: 'Get registration information for an ABAP object',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { type: 'string' }
          },
          required: ['objectUrl']
        }
      },
      {
        name: 'validateNewObject',
        description: 'Validate parameters for a new ABAP object',
        inputSchema: {
          type: 'object',
          properties: {
            options: {
              type: 'object',
              description: 'Validation options: {objtype, objname, packagename, description} for an object, or the group/package variants. A JSON string is accepted too.'
            }
          },
          required: ['options']
        }
      },
      {
        name: 'createObject',
        description: 'Create a new ABAP object',
        inputSchema: {
          type: 'object',
          properties: {
            objtype: { type: 'string' },
            name: { type: 'string' },
            parentName: { type: 'string' },
            description: { type: 'string' },
            parentPath: { type: 'string' },
            responsible: { type: 'string' },
            transport: { type: 'string' }
          },
          required: ['objtype', 'name', 'parentName', 'description', 'parentPath']
        }
      },
      {
        name: 'createInclude',
        description: 'Create a report include (PROG/I). Use this instead of createObject for includes: abap-adt-api builds the creation body without the reference to the main program, so the backend rejects it (400/500) whatever parameters are passed. This posts the include document together with its context reference.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Include name, e.g. ZR_MM_FOO_F01.'
            },
            description: {
              type: 'string',
              description: 'Short description.'
            },
            packageName: {
              type: 'string',
              description: 'Development package, e.g. ZMM_BASE.'
            },
            mainProgram: {
              type: 'string',
              description: 'Main program the include belongs to, e.g. ZR_MM_FOO. This is the reference createObject fails to send.'
            },
            transport: {
              type: 'string',
              description: 'Transport request.'
            },
            responsible: {
              type: 'string',
              description: 'Responsible user; defaults to the logon user.'
            },
            masterLanguage: {
              type: 'string',
              description: 'Master language; defaults to the logon language, or EN.'
            }
          },
          required: ['name', 'description', 'packageName', 'mainProgram']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'objectRegistrationInfo':
        return this.handleObjectRegistrationInfo(args);
      case 'validateNewObject':
        return this.handleValidateNewObject(args);
      case 'createObject':
        return this.handleCreateObject(args);
      case 'createInclude':
        return this.handleCreateInclude(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object registration tool: ${toolName}`);
    }
  }

  private xmlAttr(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Create a program include.
   *
   * abap-adt-api routes PROG/I through its generic createBodySimple, which
   * emits only a packageRef - the include document needs a context reference
   * to its main program as well, so the backend answers 400 or 500 no matter
   * which parentPath is passed (confirmed on separate days, with brand-new
   * names, which rules out a name collision). The document is built here
   * instead and posted through the library's own HTTP client, so cookies, CSRF
   * token and session handling stay exactly as for every other call.
   */
  async handleCreateInclude(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const name = String(args.name || '').toUpperCase();
      const mainProgram = String(args.mainProgram || '').toUpperCase();
      const responsible = String(args.responsible || this.adtclient.username || '').toUpperCase();
      const language = (args.masterLanguage || this.adtclient.language || 'EN').toUpperCase();

      const body = `<?xml version="1.0" encoding="UTF-8"?>
<include:abapInclude xmlns:include="http://www.sap.com/adt/programs/includes"
    xmlns:adtcore="http://www.sap.com/adt/core"
    adtcore:description="${this.xmlAttr(args.description)}"
    adtcore:name="${this.xmlAttr(name)}" adtcore:type="PROG/I"
    adtcore:language="${this.xmlAttr(language)}" adtcore:masterLanguage="${this.xmlAttr(language)}"
    adtcore:responsible="${this.xmlAttr(responsible)}">
  <adtcore:packageRef adtcore:name="${this.xmlAttr(String(args.packageName).toUpperCase())}"/>
  <include:contextRef adtcore:name="${this.xmlAttr(mainProgram)}" adtcore:type="PROG/P"
    adtcore:uri="/sap/bc/adt/programs/programs/${encodeURIComponent(mainProgram.toLowerCase())}"/>
</include:abapInclude>`;

      const qs: Record<string, string> = {};
      if (args.transport) qs.corrNr = args.transport;

      await this.adtclient.httpClient.request('/sap/bc/adt/programs/includes', {
        body,
        headers: { 'Content-Type': 'application/*' },
        method: 'POST',
        qs
      });
      this.trackRequest(startTime, true);

      const url = `/sap/bc/adt/programs/includes/${encodeURIComponent(name.toLowerCase())}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            name,
            mainProgram,
            objectUrl: url,
            sourceUrl: `${url}/source/main`,
            hint: 'Created empty. Write its body with setObjectSource on the sourceUrl (the include needs a lock), and add the INCLUDE statement to the main program.'
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to create include');
    }
  }

  async handleObjectRegistrationInfo(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const info = await this.adtclient.objectRegistrationInfo(args.objectUrl);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            info
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to get registration info');
    }
  }

  async handleValidateNewObject(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const result = await this.adtclient.validateNewObject(this.parseObjectArg(args.options, 'options'));
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            result
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to validate new object');
    }
  }

  async handleCreateObject(args: any): Promise<any> {    
    const startTime = performance.now();
    try {
      const result = await this.adtclient.createObject(
        args.objtype,
        args.name,
        args.parentName,
        args.description,
        args.parentPath,
        args.responsible,
        args.transport
      );
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            result
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to create object');
    }
  }
}
