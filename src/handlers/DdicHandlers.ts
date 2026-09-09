import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, PackageValueHelpType } from 'abap-adt-api';

export class DdicHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'annotationDefinitions',
                description: 'The CDS annotations this system defines, with their value ranges - what may be written in a DDLS source before an activation refuses it.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'ddicElement',
                description: 'A dictionary element as the DDIC sees it: a data element, a domain or a type, with its properties. For a table or structure with its fields use getStructureSource.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'The path to the DDIC element.'
                        },
                        getTargetForAssociation: {
                            type: 'boolean',
                            description: 'Whether to get the target for association.'
                        },
                        getExtensionViews: {
                            type: 'boolean',
                            description: 'Whether to get extension views.'
                        },
                        getSecondaryObjects: {
                            type: 'boolean',
                            description: 'Whether to get secondary objects.'
                        }
                    },
                    required: ['path']
                }
            },
            {
                name: 'ddicRepositoryAccess',
                description: 'Read dictionary metadata through the DDIC repository access endpoint - types, fields and domains as the dictionary itself sees them.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'The path to the DDIC element.'
                        }
                    },
                    required: ['path']
                }
            },
            {
                name: 'packageSearchHelp',
                description: 'Search help for package names, as the input help in ADT offers them - a name check before a creation that would fail on the package.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            description: 'The package value help type.'
                        },
                        name: {
                            type: 'string',
                            description: 'The package name.'
                        }
                    },
                    required: ['type']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'annotationDefinitions':
                return this.handleAnnotationDefinitions(args);
            case 'ddicElement':
                return this.handleDdicElement(args);
            case 'ddicRepositoryAccess':
                return this.handleDdicRepositoryAccess(args);
            case 'packageSearchHelp':
                return this.handlePackageSearchHelp(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown DDIC tool: ${toolName}`);
        }
    }

    async handleAnnotationDefinitions(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.annotationDefinitions();
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
            throw wrapAdtError(error, 'Failed to get annotation definitions');
        }
    }

    async handleDdicElement(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.ddicElement(
                args.path,
                args.getTargetForAssociation,
                args.getExtensionViews,
                args.getSecondaryObjects
            );
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
            throw wrapAdtError(error, 'Failed to get DDIC element');
        }
    }

    async handleDdicRepositoryAccess(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.ddicRepositoryAccess(args.path);
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
            throw wrapAdtError(error, 'Failed to access DDIC repository');
        }
    }

    async handlePackageSearchHelp(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.packageSearchHelp(args.type, args.name);
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
            throw wrapAdtError(error, 'Failed to get package search help');
        }
    }
}
