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
        const startTime = performance.now();
        try {
            const structure = await this.readClient.objectStructure(args.objectUrl, args.version);
            this.trackRequest(startTime, true);
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
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get object structure');
        }
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
            throw wrapAdtError(error, 'Failed to find object path');
        }
    }

    async handleSearchObject(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const results = await this.readClient.searchObject(
                args.query,
                args.objType,
                args.max
            );
            this.trackRequest(startTime, true);
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
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to search objects');
        }
    }

    async handleObjectTypes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const types = await this.readClient.objectTypes();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
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
        const startTime = performance.now();
        try {
            const ticket = await this.readClient.reentranceTicket();
            this.trackRequest(startTime, true);
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
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get reentrance ticket');
        }
    }
}
