import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, isMissingCollection, describeAdtError } from '../lib/adtError';
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
                description: 'Read dictionary metadata through the DDIC repository access endpoint - types, fields and domains as the dictionary itself sees them. Takes a dictionary name, not a URL: an address is answered with an empty list by the backend, which is the same answer a name that exists nowhere gets, so both are reported as found false here.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'The dictionary name, e.g. T000 or a field path like T000-MANDT.'
                        }
                    },
                    required: ['path']
                }
            },
            {
                name: 'packageSearchHelp',
                description: 'The input help behind the package attributes - application components, software components, transport layers, translation relevances - as ADT offers them when a package is created. Not a search for packages: for that use searchObject. The endpoint is absent on a classic ERP release, and that is reported as such rather than as a bad request.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['applicationcomponents', 'softwarecomponents', 'transportlayers', 'translationrelevances'],
                            description: 'Which value help to read. One of applicationcomponents, softwarecomponents, transportlayers, translationrelevances - the endpoint has no others.'
                        },
                        name: {
                            type: 'string',
                            description: 'Name pattern to filter the entries, e.g. SAP*. Defaults to * - everything.'
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
            const rows = Array.isArray(result) ? result : result ? [result] : [];
            if (!rows.length) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found: false,
                            path: args.path,
                            reason: 'The dictionary knows nothing under this name.',
                            hint: 'This endpoint takes a name, not an address - T000, not /sap/bc/adt/ddic/tables/t000. For a table use tableFields; searchObject finds a name.'
                        })
                    }]
                };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found: true,
                            path: args.path,
                            result: rows
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
        const allowed = ['applicationcomponents', 'softwarecomponents', 'transportlayers', 'translationrelevances'];
        const type = String(args?.type ?? '').trim();
        if (!allowed.includes(type)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `type must be one of ${allowed.join(', ')} - the endpoint publishes no other value help, and anything else answers 404. ` +
                'To find a package by name use searchObject with objType DEVC/K.'
            );
        }
        try {
            const result = await this.readClient.packageSearchHelp(type as any, args.name);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            type,
                            name: args?.name ?? '*',
                            found: Array.isArray(result) ? result.length : 0,
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const status = describeAdtError(error).status;
            throw wrapAdtError(error, status === 404
                ? `This system does not serve the package value helps: /sap/bc/adt/packages/valuehelps/${type} answers 404, as it does on a classic ERP release. The attributes are then only visible in SE80`
                : 'Failed to get package search help');
        }
    }
}
