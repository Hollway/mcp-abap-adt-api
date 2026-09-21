import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";

export class ObjectHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'objectStructure',
                description: 'The metadata of one object: its name, type, package, who changed it when, its master language, and the links ADT offers for it - among them the source URL, which is how the address of an unfamiliar type is found. It does NOT return content: a class answers with its includes, a table with its properties (getStructureSource has the fields), and a message class with the metadata after the messages have been discarded (getMessages has those).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object'
                        },
                        version: {
                            type: 'string',
                            description: 'Version of the object'
                        }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'searchObject',
                description: 'Find objects by name in the repository, with * as a wildcard - the quickest way from a name to a URI, a type and a package. The objType filter is the quick-search filter of the backend and does not take every sub-type: FUGR/FF answers with an empty list while the unfiltered search returns the module. So when a filter comes back empty, search without it and pick the type from the rows.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query string'
                        },
                        objType: {
                            type: 'string',
                            description: 'Object type filter'
                        },
                        max: {
                            type: 'number',
                            description: 'Maximum number of results'
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'findObjectPath',
                description: 'The workbench path of an object, from the package down to the object itself. That is where the package of an object comes from - its own metadata does not carry it - which is why activation uses this to fill in the parent URI the inactive list leaves empty.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object to find path for'
                        }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'objectTypes',
                description: 'The object types this system knows, as ADT names them. Diagnostic: useful when a type code is in doubt, since a wrong one is refused with a 404 that says nothing.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'reentranceTicket',
                description: 'A single-use ticket for opening SAPGUI on this system without logging on again - what ADT uses when it hands an object to the GUI. It is a credential: it stands for your session, so treat it like one.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'objectStructure':
                return this.handleObjectStructure(args);
            case 'findObjectPath':
                return this.handleFindObjectPath(args);
            case 'searchObject':
                return this.handleSearchObject(args);
            case 'objectTypes':
                return this.handleObjectTypes(args);
            case 'reentranceTicket':
                return this.handleReentranceTicket(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown object tool: ${toolName}`);
        }
    }

    async handleObjectStructure(args: any): Promise<any> {
        return this.tracked('Failed to get object structure', async () => {
            const structure = await this.readClient.objectStructure(args.objectUrl, args.version);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            structure,
                            message: 'Object structure retrieved successfully'
                        }, null, 2)
                    }
                ]
            };
        });
    }

    async handleFindObjectPath(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const path = await this.readClient.findObjectPath(args.objectUrl);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            path,
                            message: 'Object path found successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            // A package address is the common wrong input here, and the
            // backend answers it with "No URI-Mapping defined for URI" - true,
            // but it never says which addresses are mapped.
            throw wrapAdtError(error, /uri-?mapping/i.test(String(error?.message || ''))
                ? 'Failed to find object path: this endpoint maps the address of a repository object - a class, a program, a function group - not a package or a source page. Pass the object URL itself, e.g. /sap/bc/adt/oo/classes/cl_salv_table, and use packageTree for what a package contains'
                : 'Failed to find object path');
        }
    }

    async handleSearchObject(args: any): Promise<any> {
        return this.tracked('Failed to search objects', async () => {
            const results = await this.readClient.searchObject(
                args.query,
                args.objType,
                args.max
            );
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            results,
                            message: 'Object search completed successfully'
                        }, null, 2)
                    }
                ]
            };
        });
    }

    async handleObjectTypes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const types = await this.readClient.objectTypes();
            this.trackRequest(startTime, true);
            const rows = Array.isArray(types) ? types : [];
            // The endpoint behind this answers with named items, and only the
            // ones carrying both a type and a usedBy field survive the parse.
            // A classic ERP release sends neither, so the list comes back
            // empty - which used to be reported as a successful retrieval.
            if (!rows.length) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found: false,
                            count: 0,
                            reason: 'This system publishes no object types through the information-system endpoint: the named items it answers with carry no type/usedBy pair, so nothing survives the parse.',
                            hint: 'loadTypes answers the same question from the creation endpoints, and searchObject finds an object whose type is not known in advance.'
                        }, null, 2)
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
                            count: rows.length,
                            types,
                            message: 'Object types retrieved successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get object types');
        }
    }

    async handleReentranceTicket(args: any): Promise<any> {
        return this.tracked('Failed to get reentrance ticket', async () => {
            const ticket = await this.readClient.reentranceTicket();
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ticket,
                            message: 'Reentrance ticket retrieved successfully'
                        }, null, 2)
                    }
                ]
            };
        });
    }
}
