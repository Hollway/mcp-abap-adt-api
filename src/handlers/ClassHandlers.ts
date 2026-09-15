import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import { classIncludeRows, pageClassComponents, classUrl } from '../lib/classShape';
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
                            description: 'The class name, e.g. CL_SALV_TABLE, or its URL.'
                        }
                    },
                    required: ['clas']
                }
            },
            {
                name: 'classComponents',
                description: 'What a class is made of: its methods with their visibility, its attributes, its types and its interfaces - read from the class rather than from its source. This is the cheap answer to "what can this class do"; the source of one method is then found with fragmentMappings or read whole with getObjectSource. The backend tree runs to some 13,500 characters for a large class, so the answer is a summary plus one filtered page of components.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The class name, e.g. CL_SALV_TABLE, or its URL.'
                        },
                        name: {
                            type: 'string',
                            description: 'Substring of the component name, case-insensitive.'
                        },
                        type: {
                            type: 'string',
                            description: 'Substring of the ADT type, e.g. CLAS/OM for methods, CLAS/OA for attributes.'
                        },
                        visibility: {
                            type: 'string',
                            description: 'public, protected or private.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Components to return, default 100.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Components to skip before the page, default 0.'
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

    private json(payload: unknown) {
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    /**
     * The library method is a pure function over a class structure, not over a
     * name: handed the name this tool takes, it threw "clas.includes is not
     * iterable" on every call. The structure is read here first.
     */
    async handleClassIncludes(args: any): Promise<any> {
        const startTime = performance.now();
        const url = classUrl(args?.clas);
        try {
            const structure: any = await this.readClient.objectStructure(url);
            if (!Array.isArray(structure?.includes)) {
                this.trackRequest(startTime, true);
                return this.json({
                    status: 'success',
                    found: false,
                    clas: args?.clas,
                    url,
                    objectType: structure?.['adtcore:type'],
                    reason: 'This object has no include structure - includes are a property of classes, and this is not one.',
                    hint: 'For a program and its includes use mainPrograms or sourceOutline.'
                });
            }
            const includes = classIncludeRows(structure, ADTClient.classIncludes(structure));
            this.trackRequest(startTime, true);
            return this.json({
                status: 'success',
                found: true,
                clas: structure?.['adtcore:name'] ?? args?.clas,
                url,
                includes,
                result: Object.fromEntries(includes.map(i => [i.includeType, i.url]))
            });
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to get class includes for ${url}`);
        }
    }

    async handleClassComponents(args: any): Promise<any> {
        const startTime = performance.now();
        const url = classUrl(args?.url);
        try {
            const result = await this.readClient.classComponents(url);
            this.trackRequest(startTime, true);
            return this.json({
                status: 'success',
                url,
                ...pageClassComponents(result, {
                    name: args?.name,
                    type: args?.type,
                    visibility: args?.visibility,
                    maxResults: args?.maxResults,
                    offset: args?.offset
                })
            });
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to get class components for ${url}`);
        }
    }

}
