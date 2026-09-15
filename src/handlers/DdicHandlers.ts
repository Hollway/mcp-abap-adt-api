import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, isMissingCollection } from '../lib/adtError';
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
                description: 'The fields of a dictionary entity and what each one is made of - key flag, data element, type, length - in one call. It answers for a table, a structure or a CDS entity: T000 comes back with its 17 fields. It does NOT answer for a data element or a domain, whatever its name suggests: the endpoint behind it is the CDS element-info one, and a data element name answers with an empty shell rather than an error. Use getDataElementProperties and getDomainProperties for those, and getStructureSource for the DDL text of a table.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Name of the table, structure or CDS entity, e.g. T000. A field path like T000-MANDT is accepted and answers for the whole table.'
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
            throw wrapAdtError(error, isMissingCollection(error)
                ? 'This system does not serve the CDS annotation definitions: the /sap/bc/adt/ddic/cds/annotation/definitions collection is absent, as it is on a classic ERP release'
                : 'Failed to get annotation definitions');
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
            // An entity this endpoint knows nothing about is answered with an
            // empty shell and status 200 - the same answer a name that does
            // not exist gets, and the same one a data element gets, which is
            // what the tool used to say it was for.
            const found = !!(result && (result.name || (result.children || []).length > 0));
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found,
                            fields: (result?.children || []).length,
                            result: found ? result : undefined,
                            hint: found
                                ? undefined
                                : `Nothing here for "${args.path}". This endpoint answers for tables, structures and CDS entities; a data element or a domain answers exactly like a name that does not exist. For those use getDataElementProperties or getDomainProperties, and searchObject to check the name is real.`
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
