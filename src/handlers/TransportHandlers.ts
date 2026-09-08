import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";
import type { TransportsOfUser, TransportTarget, TransportRequest } from "abap-adt-api";

export class TransportHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'transportInfo',
                description: 'Get transport information for an object source',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objSourceUrl: {
                            type: 'string',
                            description: 'URL of the object source'
                        },
                        devClass: {
                            type: 'string',
                            description: 'Development class'
                        },
                        operation: {
                            type: 'string',
                            description: 'Transport operation'
                        }
                    },
                    required: ['objSourceUrl']
                }
            },
            {
                name: 'createTransport',
                description: 'Create a new transport request',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objSourceUrl: {
                            type: 'string',
                            description: 'URL of the object source'
                        },
                        REQUEST_TEXT: {
                            type: 'string',
                            description: 'Description of the transport request'
                        },
                        DEVCLASS: {
                            type: 'string',
                            description: 'Development class'
                        },
                        transportLayer: {
                            type: 'string',
                            description: 'Transport layer'
                        }
                    },
                    required: ['objSourceUrl', 'REQUEST_TEXT', 'DEVCLASS']
                }
            },
            {
                name: 'hasTransportConfig',
                description: 'Check if transport configuration exists',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'transportConfigurations',
                description: 'Retrieves transport configurations.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'getTransportConfiguration',
                description: 'Retrieves a specific transport configuration.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the transport configuration.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'setTransportsConfig',
                description: 'Sets transport configurations.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uri: {
                            type: 'string',
                            description: 'The URI for the transport configuration.'
                        },
                        etag: {
                            type: 'string',
                            description: 'The ETag for the transport configuration.'
                        },
                        config: {
                            type: 'object',
                            description: 'The transport configuration (object, or a JSON string).'
                        }
                    },
                    required: ['uri', 'etag', 'config']
                }
            },
            {
                name: 'createTransportsConfig',
                description: 'Creates transport configurations.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'userTransports',
                description: 'List a user\'s transport requests. Returns a flat, filterable list of requests (number, description, owner, status D=modifiable/R=released, target); pass raw=true for the full ADT payload, which with targets=true can exceed 400k characters. Note that targets=false makes the backend answer with empty lists on some systems, so leave it on unless you know otherwise.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        user: {
                            type: 'string',
                            description: 'The user.'
                        },
                        targets: {
                            type: 'boolean',
                            description: 'Whether to include target systems. Defaults to true, because false has been seen to return empty lists for users whose requests demonstrably exist.'
                        },
                        status: {
                            type: 'string',
                            description: 'Keep only requests with this status: "D" (modifiable), "R" (released) or "all" (default).',
                            enum: ['D', 'R', 'all']
                        },
                        owner: {
                            type: 'string',
                            description: 'Keep only requests owned by this user (case-insensitive).'
                        },
                        numberLike: {
                            type: 'string',
                            description: 'Keep only requests whose number contains this text, e.g. "EUDK9A3".'
                        },
                        descriptionLike: {
                            type: 'string',
                            description: 'Keep only requests whose description contains this text (case-insensitive).'
                        },
                        includeTasks: {
                            type: 'boolean',
                            description: 'Include the tasks inside each request (Development/Correction entries). Off by default - they triple the output and are rarely what you are looking for.'
                        },
                        raw: {
                            type: 'boolean',
                            description: 'Return the unfiltered ADT structure instead of the flat list.'
                        }
                    },
                    required: ['user']
                }
            },
            {
                name: 'transportsByConfig',
                description: 'Retrieves transports by configuration.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        configUri: {
                            type: 'string',
                            description: 'The configuration URI.'
                        },
                        targets: {
                            type: 'boolean',
                            description: 'Whether to include target systems.'
                        }
                    },
                    required: ['configUri']
                }
            },
            {
                name: 'transportDelete',
                description: 'Deletes a transport.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transportNumber: {
                            type: 'string',
                            description: 'The transport number.'
                        }
                    },
                    required: ['transportNumber']
                }
            },
            {
                name: 'transportRelease',
                description: 'Releases a transport.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transportNumber: {
                            type: 'string',
                            description: 'The transport number.'
                        },
                        ignoreLocks: {
                            type: 'boolean',
                            description: 'Whether to ignore locks.'
                        },
                        IgnoreATC: {
                            type: 'boolean',
                            description: 'Whether to ignore ATC checks.'
                        }
                    },
                    required: ['transportNumber']
                }
            },
            {
                name: 'transportSetOwner',
                description: 'Sets the owner of a transport.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transportNumber: {
                            type: 'string',
                            description: 'The transport number.'
                        },
                        targetuser: {
                            type: 'string',
                            description: 'The target user.'
                        }
                    },
                    required: ['transportNumber', 'targetuser']
                }
            },
            {
                name: 'transportAddUser',
                description: 'Adds a user to a transport.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transportNumber: {
                            type: 'string',
                            description: 'The transport number.'
                        },
                        user: {
                            type: 'string',
                            description: 'The user to add.'
                        }
                    },
                    required: ['transportNumber', 'user']
                }
            },
            {
                name: 'systemUsers',
                description: 'Retrieves a list of system users.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'transportReference',
                description: 'Retrieves a transport reference.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        pgmid: {
                            type: 'string',
                            description: 'The program ID.'
                        },
                        obj_wbtype: {
                            type: 'string',
                            description: 'The object type.'
                        },
                        obj_name: {
                            type: 'string',
                            description: 'The object name.'
                        },
                        tr_number: {
                            type: 'string',
                            description: 'The transport number.'
                        }
                    },
                    required: ['pgmid', 'obj_wbtype', 'obj_name']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'transportInfo':
                return this.handleTransportInfo(args);
            case 'createTransport':
                return this.handleCreateTransport(args);
            case 'hasTransportConfig':
                return this.handleHasTransportConfig(args);
            case 'transportConfigurations':
                return this.handleTransportConfigurations(args);
            case 'getTransportConfiguration':
                return this.handleGetTransportConfiguration(args);
            case 'setTransportsConfig':
                return this.handleSetTransportsConfig(args);
            case 'createTransportsConfig':
                return this.handleCreateTransportsConfig(args);
            case 'userTransports':
                return this.handleUserTransports(args);
            case 'transportsByConfig':
                return this.handleTransportsByConfig(args);
            case 'transportDelete':
                return this.handleTransportDelete(args);
            case 'transportRelease':
                return this.handleTransportRelease(args);
            case 'transportSetOwner':
                return this.handleTransportSetOwner(args);
            case 'transportAddUser':
                return this.handleTransportAddUser(args);
            case 'systemUsers':
                return this.handleSystemUsers(args);
            case 'transportReference':
                return this.handleTransportReference(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown transport tool: ${toolName}`);
        }
    }

    async handleTransportInfo(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const transportInfo = await this.adtclient.transportInfo(
                args.objSourceUrl,
                args.devClass,
                args.operation
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            transportInfo
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get transport info');
        }
    }

    async handleCreateTransport(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const transportResult = await this.adtclient.createTransport(
                args.objSourceUrl,
                args.REQUEST_TEXT,
                args.DEVCLASS,
                args.transportLayer
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            transportNumber: transportResult,
                            message: 'Transport created successfully'
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to create transport');
        }
    }

    async handleHasTransportConfig(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const hasConfig = await this.adtclient.hasTransportConfig();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            hasConfig
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to check transport config');
        }
    }

    async handleTransportConfigurations(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const configurations = await this.adtclient.transportConfigurations();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            configurations
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get transport configurations');
        }
    }

    async handleGetTransportConfiguration(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const configuration = await this.adtclient.getTransportConfiguration(args.url);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            configuration
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get transport configuration');
        }
    }

    async handleSetTransportsConfig(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.setTransportsConfig(args.uri, args.etag, this.parseObjectArg(args.config, 'config'));
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
            throw wrapAdtError(error, 'Failed to set transports config');
        }
    }

    async handleCreateTransportsConfig(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.createTransportsConfig();
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
            throw wrapAdtError(error, 'Failed to create transports config');
        }
    }

    /**
     * Flatten the nested target/modifiable/released structure into one list of
     * requests, applying the filters.
     *
     * The raw answer is unusable in a conversation: with targets=true it has
     * run past 400k characters, most of it task entries nobody asked for.
     */
    private flattenTransports(transports: TransportsOfUser, args: any) {
        const status = (args?.status || 'all').toUpperCase();
        const owner = args?.owner ? String(args.owner).toUpperCase() : undefined;
        const numberLike = args?.numberLike ? String(args.numberLike).toUpperCase() : undefined;
        const descLike = args?.descriptionLike ? String(args.descriptionLike).toLowerCase() : undefined;
        const includeTasks = args?.includeTasks === true;

        const rows: Record<string, unknown>[] = [];
        const categories: [string, TransportTarget[]][] = [
            ['workbench', transports?.workbench || []],
            ['customizing', transports?.customizing || []]
        ];

        for (const [category, targets] of categories) {
            for (const target of targets) {
                const buckets: [string, TransportRequest[]][] = [
                    ['modifiable', target.modifiable || []],
                    ['released', target.released || []]
                ];
                for (const [bucket, requests] of buckets) {
                    for (const request of requests) {
                        const number = request['tm:number'] || '';
                        const requestOwner = (request['tm:owner'] || '').toUpperCase();
                        const desc = request['tm:desc'] || '';
                        const requestStatus = (request['tm:status'] || '').toUpperCase();

                        if (status !== 'ALL' && requestStatus !== status) continue;
                        if (owner && requestOwner !== owner) continue;
                        if (numberLike && !number.toUpperCase().includes(numberLike)) continue;
                        if (descLike && !desc.toLowerCase().includes(descLike)) continue;

                        rows.push({
                            number,
                            description: desc,
                            owner: request['tm:owner'],
                            status: requestStatus,
                            state: bucket,
                            category,
                            target: target['tm:name'],
                            ...(includeTasks
                                ? {
                                    tasks: (request.tasks || []).map(t => ({
                                        number: t['tm:number'],
                                        owner: t['tm:owner'],
                                        description: t['tm:desc'],
                                        status: (t['tm:status'] || '').toUpperCase()
                                    }))
                                }
                                : {})
                        });
                    }
                }
            }
        }
        return rows;
    }

    async handleUserTransports(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            // targets defaults to true: with false, some systems answer with
            // empty workbench/customizing lists even for users whose requests
            // demonstrably exist, which reads as "no transports".
            const targets = args?.targets === undefined ? true : args.targets;
            const transports = await this.adtclient.userTransports(args.user, targets);
            this.trackRequest(startTime, true);

            if (args?.raw === true) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ status: 'success', transports }) }]
                };
            }

            const requests = this.flattenTransports(transports, args);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            user: args.user,
                            count: requests.length,
                            requests
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get user transports');
        }
    }

    async handleTransportsByConfig(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const transports = await this.adtclient.transportsByConfig(args.configUri, args.targets);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            transports
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get transports by config');
        }
    }

    async handleTransportDelete(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.transportDelete(args.transportNumber);
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
            throw wrapAdtError(error, 'Failed to delete transport');
        }
    }

    async handleTransportRelease(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.transportRelease(args.transportNumber, args.ignoreLocks, args.IgnoreATC);
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
            throw wrapAdtError(error, 'Failed to release transport');
        }
    }

    async handleTransportSetOwner(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.transportSetOwner(args.transportNumber, args.targetuser);
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
            throw wrapAdtError(error, 'Failed to set transport owner');
        }
    }

    async handleTransportAddUser(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.transportAddUser(args.transportNumber, args.user);
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
            throw wrapAdtError(error, 'Failed to add user to transport');
        }
    }

    async handleSystemUsers(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const users = await this.adtclient.systemUsers();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            users
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get system users');
        }
    }

    async handleTransportReference(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const reference = await this.adtclient.transportReference(args.pgmid, args.obj_wbtype, args.obj_name, args.tr_number);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            reference
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get transport reference');
        }
    }
}
