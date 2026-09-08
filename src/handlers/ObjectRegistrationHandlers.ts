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
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object registration tool: ${toolName}`);
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
