import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from 'abap-adt-api';

export class ClassHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'classIncludes',
                description: 'The includes a class is made of - definitions, implementations, macros, test classes - with the URL of each. That is how the test class of a class is read or written separately from its main source, and which include names revisions and getTextElements take.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        clas: {
                            type: 'string',
                            description: 'The class name'
                        }
                    },
                    required: ['clas']
                }
            },
            {
                name: 'classComponents',
                description: 'What a class is made of: its methods with their visibility, its attributes, its types and its interfaces - read from the class rather than from its source. This is the cheap answer to "what can this class do"; the source of one method is then found with fragmentMappings or read whole with getObjectSource.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the class'
                        }
                    },
                    required: ['url']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'classIncludes':
                return this.handleClassIncludes(args);
            case 'classComponents':
                return this.handleClassComponents(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown class tool: ${toolName}`);
        }
    }

    async handleClassIncludes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await ADTClient.classIncludes(args.clas);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get class includes');
        }
    }

    async handleClassComponents(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.classComponents(args.url);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get class components');
        }
    }

}
