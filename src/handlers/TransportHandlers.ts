import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";
import type { TransportsOfUser, TransportTarget, TransportRequest } from "abap-adt-api";
import { filterUsers } from '../lib/userList';

export class TransportHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'transportInfo',
                description: 'Which transport request a change to this object would go into, and which ones are available for it - what ADT asks before it opens the transport dialog. Worth calling before a write outside $TMP, because a write with no request fails at the last step. Mind the difference the backend does not spell out: a REQUEST is what a write takes, a task inside it is refused with "not a change request".',
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
                description: 'Create a workbench request. It becomes yours and stays open until it is released, so create one per piece of work rather than per object, and reuse the number for every write that belongs together. Ask first if the user has a request in mind - an unwanted request is visible to the whole team and has to be deleted by hand.',
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
                description: 'Whether this system has transport configurations at all - the check before offering the organizer tools.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'transportConfigurations',
                description: 'The transport configurations available in the organizer, with their ids - what transportsByConfig takes.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'getTransportConfiguration',
                description: 'One transport configuration by URI, with everything it defines.',
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
                description: 'Change a transport configuration - which requests a user sees in the transport organizer. It is shared setup, not a per-call filter.',
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
                description: 'Create a transport configuration for the organizer. Shared setup; most work needs only createTransport.',
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
                            description: 'Keep only requests whose number contains this text, e.g. "DEVK9A3".'
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
                name: 'transportDetails',
                description: 'What is inside one transport request: its own header (owner, description, status), its tasks and the objects recorded in it. This is the answer to "what does this request change" - the alternative was a SELECT on E071 through runQuery. Objects are returned as a flat list; pass raw=true for the ADT structure.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transportNumber: {
                            type: 'string',
                            description: 'Request number, e.g. DEVK9A3OK4. A task number works too - it is looked up the same way.'
                        },
                        owner: {
                            type: 'string',
                            description: 'Owner of the request, when it is not the logon user. Some systems only answer the per-request endpoint with the caller own transport list, and this says whose list to look in.'
                        },
                        includeObjects: {
                            type: 'boolean',
                            description: 'List the objects of the request and of its tasks (default true).'
                        },
                        includeTasks: {
                            type: 'boolean',
                            description: 'List the tasks of the request (default true).'
                        },
                        raw: {
                            type: 'boolean',
                            description: 'Return the unfiltered ADT structure instead of the flat summary.'
                        }
                    },
                    required: ['transportNumber']
                }
            },
            {
                name: 'transportsByConfig',
                description: 'Transport requests of one organizer configuration, filtered as that configuration defines. For your own open requests use userTransports, which filters and shortens.',
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
                description: 'Delete a transport request or a task inside it. Only works while it is still open and empty of anything you want to keep: the objects in it stay as they are, only the request goes. Released requests cannot be deleted at all. Not undoable - ask before doing it to a request you did not create.',
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
                description: 'Release a request, which sends its objects on to the next system. Not undoable: a released request cannot be reopened, and the only way back is another request. It fails while any task inside it is still open, and while the objects have syntax errors. Ask before releasing anything - this is the step that changes another system.',
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
                description: 'Hand a request over to another user. The new owner sees it in their list and yours loses it; the objects and tasks inside stay as they are. Only an open request can change hands.',
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
                description: 'Add a developer task for another user inside a request, so their changes can travel in it. Their objects then sit in their own task under the same request number.',
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
                description: 'The users of this system, as the transport tools offer them - who a request can be handed to or shared with. Search with filter rather than reading the whole address book of the system.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filter: {
                            type: 'string',
                            description: 'Case-insensitive substring, matched against both the user id and the name. Without it the whole list comes back, which on a real system is several hundred entries.'
                        },
                        limit: {
                            type: 'number',
                            description: 'Cap on the users reported, default 50. The counts are always for everything found.'
                        }
                    }
                }
            },
            {
                name: 'transportReference',
                description: 'What a transport reference points at: the object behind one entry of a request.',
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
            case 'transportDetails':
                return this.handleTransportDetails(args);
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
            const transportInfo = await this.readClient.transportInfo(
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

    /**
     * Find one request in a transport list payload, by number, request or task.
     *
     * The per-request endpoint on this system answers with the caller's whole
     * transport list rather than the one request asked for - so the request
     * has to be picked out of it, and a task number has to match a task as
     * well as a request.
     */
    private findRequest(transports: any, number: string): { request: any; via: 'request' | 'task' } | undefined {
        const wanted = number.toUpperCase();
        const targets = [
            ...((transports?.workbench || []) as any[]),
            ...((transports?.customizing || []) as any[])
        ];
        for (const target of targets) {
            for (const request of [...(target?.modifiable || []), ...(target?.released || [])]) {
                if (`${request?.['tm:number'] || ''}`.toUpperCase() === wanted) {
                    return { request, via: 'request' };
                }
                for (const task of request?.tasks || []) {
                    if (`${task?.['tm:number'] || ''}`.toUpperCase() === wanted) {
                        return { request, via: 'task' };
                    }
                }
            }
        }
        return undefined;
    }

    /**
     * The contents of one request.
     *
     * ADT nests the objects under the request and under each of its tasks, and
     * the field names carry their XML prefixes ("tm:name"), which makes the
     * raw answer awkward to read and easy to mistake for empty. Flattened
     * here: one list of objects, each saying which task recorded it.
     *
     * The library's own call asks /cts/transportrequests/<number> and reads a
     * single request out of the answer. On this system that endpoint ignores
     * the number and returns the caller's whole transport list, so the parse
     * finds nothing and the request looks empty - which it is not. When that
     * happens the request is looked up in the transport list instead, which
     * carries the same objects and tasks.
     */
    async handleTransportDetails(args: any): Promise<any> {
        const startTime = performance.now();
        const number = String(args?.transportNumber || '').toUpperCase();
        try {
            let details: any = await this.readClient.transportDetails(number);
            let via = 'transportDetails';

            const parsedNumber = `${details?.['tm:number'] || ''}`.toUpperCase();
            if (parsedNumber !== number) {
                const owner = String(args?.owner || this.adtclient.username || '').toUpperCase();
                const transports = await this.readClient.userTransports(owner, true);
                const found = this.findRequest(transports, number);
                if (!found) {
                    this.trackRequest(startTime, true);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                number,
                                found: false,
                                searchedOwner: owner,
                                hint: `This system answers the per-request endpoint with the caller's own transport list, and ${number} is not in ${owner}'s. Pass owner with the user who owns it, or read its objects with runQuery on E071.`
                            })
                        }]
                    };
                }
                details = found.request;
                via = found.via === 'task'
                    ? `transport list of ${owner} (${number} is a task of ${details?.['tm:number']})`
                    : `transport list of ${owner}`;
            }
            this.trackRequest(startTime, true);

            if (args?.raw === true) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ status: 'success', details }) }]
                };
            }

            const tasks = (details?.tasks || []).map((t: any) => ({
                number: t?.['tm:number'],
                owner: t?.['tm:owner'],
                description: t?.['tm:desc'],
                status: t?.['tm:status'],
                objects: (t?.objects || []).length
            }));

            const objectsOf = (holder: any, task?: string) =>
                (holder?.objects || []).map((o: any) => ({
                    pgmid: o?.['tm:pgmid'],
                    type: o?.['tm:type'],
                    name: o?.['tm:name'],
                    description: o?.['tm:obj_info'],
                    ...(task ? { task } : {})
                }));

            const objects = [
                ...objectsOf(details),
                ...(details?.tasks || []).reduce(
                    (acc: any[], t: any) => acc.concat(objectsOf(t, t?.['tm:number'])),
                    []
                )
            ];

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        found: true,
                        via,
                        number: details?.['tm:number'] || number,
                        owner: details?.['tm:owner'],
                        description: details?.['tm:desc'],
                        transportStatus: details?.['tm:status'],
                        statusMeaning: details?.['tm:status'] === 'R' ? 'released'
                            : details?.['tm:status'] === 'D' ? 'modifiable'
                            : undefined,
                        taskCount: tasks.length,
                        objectCount: objects.length,
                        ...(args?.includeTasks === false ? {} : { tasks }),
                        ...(args?.includeObjects === false ? {} : { objects })
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to read transport ${args?.transportNumber}`);
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
            const hasConfig = await this.readClient.hasTransportConfig();
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
            const configurations = await this.readClient.transportConfigurations();
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
            const configuration = await this.readClient.getTransportConfiguration(args.url);
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
            const transports = await this.readClient.userTransports(args.user, targets);
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
            const transports = await this.readClient.transportsByConfig(args.configUri, args.targets);
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
            const result = filterUsers(await this.readClient.systemUsers(), args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...result
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
            const reference = await this.readClient.transportReference(args.pgmid, args.obj_wbtype, args.obj_name, args.tr_number);
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
