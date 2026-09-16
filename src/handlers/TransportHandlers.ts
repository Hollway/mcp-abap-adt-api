import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import { lockRegistry } from '../lib/lockRegistry';
import {
    normalizeRequest,
    requestArgument,
    isObjectNameSafe,
    headerQuery,
    headerQueries,
    textQueries,
    objectQueries,
    entriesByObjectQueries,
    inactiveSourceQueries,
    inactiveDdicQueries,
    rowsOf,
    describeRequest,
    textMap,
    objectParts,
    historyOf,
    conflictsOf,
    sourceNames,
    ddicNames,
    inactiveSources,
    inactiveDdic,
    readinessVerdict
} from '../lib/transportHygiene';
import type { TransportRow } from '../lib/transportHygiene';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";
import type { TransportsOfUser, TransportTarget, TransportRequest } from "abap-adt-api";
import { filterUsers } from '../lib/userList';
import { CallHandlers } from './CallHandlers.js';
import { QueryHandlers } from './QueryHandlers.js';
import {
    TransportRegistrationError,
    buildE071Row,
    chooseTask,
    diagnose,
    headerSql,
    holdersSql,
    isLocalPackage,
    packageSql,
    registeredSql,
    tasksSql,
    transportNumber,
    type E071Row,
    type TransportHeaderRow
} from '../lib/transportRegistration';

export class TransportHandlers extends BaseHandler {
    private readonly calls: CallHandlers;
    private readonly queries: QueryHandlers;

    constructor(client: ADTClient) {
        super(client);
        // Calling a function module and reading a table are jobs this server
        // already does properly - signature, generated call, exceptions by name
        // on one side, and SELECT on the other. Borrowed rather than repeated.
        this.calls = new CallHandlers(client);
        this.queries = new QueryHandlers(client);
    }

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
                name: 'objectTransports',
                description: 'Every transport request one object has ever travelled in, newest first, with who owned it, its status and its description. Reads the organizer tables, so it finds the entries recorded under the parts of an object - REPS and REPT for a report, METH and CLSD for a class - which a search by the object name alone never shows. Open requests are counted separately from released ones: an object sitting in an open request of somebody else is the case that overwrites work.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectName: {
                            type: 'string',
                            description: 'The object name as the repository spells it, e.g. ZCL_SOMETHING. Not a URL.'
                        },
                        includeReleased: {
                            type: 'boolean',
                            description: 'Include requests that are already released. On by default; turn it off to see only what is still open.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Requests to return, default 50. The counts always cover everything found.'
                        }
                    },
                    required: ['objectName']
                }
            },
            {
                name: 'transportConflicts',
                description: 'Which objects of a transport request are also recorded in somebody else open request - the case where two people change the same object and the later release wins. Takes a request or one of its tasks; the tasks of the request itself are never counted as conflicts with it. Reading only: it looks at the organizer tables and changes nothing.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transport: {
                            type: 'string',
                            description: 'Request or task number, e.g. DEVK900123.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Conflict rows to return, default 100. The summary always counts everything examined.'
                        },
                        maxObjects: {
                            type: 'number',
                            description: 'Objects of the request to look up elsewhere, default 50. Each one is a read of the organizer tables, and a request holding a widely shared customizing table can take half a minute at 79 of them - the answer says how many were left out.'
                        }
                    },
                    required: ['transport']
                }
            },
            {
                name: 'transportReadiness',
                description: 'What stands between a transport request and its release, in one read: its status and owner, tasks still open under it, whether it is empty, objects that also sit in other open requests, objects with an inactive version saved and never activated, and locks this server still holds on them. Answers ready true or false with the reason for every check. The activation check is a read of REPOSRC and the dictionary tables, because ADT cannot answer it - objectStructure reports version active for an object whose inactive version was saved years ago.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        transport: {
                            type: 'string',
                            description: 'Request number, e.g. DEVK900123. A task number is accepted and the request above it is checked.'
                        },
                        checkActivation: {
                            type: 'boolean',
                            description: 'Look for inactive versions of the objects. On by default; one extra read per kind of object.'
                        },
                        maxObjects: {
                            type: 'number',
                            description: 'Objects to take into the activation and conflict reads, default 100. The answer says how many were left out.'
                        }
                    },
                    required: ['transport']
                }
            },
            {
                name: 'transportsByConfig',
                description: 'Transport requests of one organizer configuration, filtered as that configuration defines. For your own open requests use userTransports, which filters and shortens. The configuration address is checked against transportConfigurations first: the backend ignores one it does not know and answers with every request in the system instead - 327,499 characters, measured, and nothing in it says the filter was dropped.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        configUri: {
                            type: 'string',
                            description: 'The link of a configuration transportConfigurations answered with.'
                        },
                        targets: {
                            type: 'boolean',
                            description: 'Whether to include target systems.'
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
                            description: 'Keep only requests whose number contains this text.'
                        },
                        descriptionLike: {
                            type: 'string',
                            description: 'Keep only requests whose description contains this text (case-insensitive).'
                        },
                        includeTasks: {
                            type: 'boolean',
                            description: 'Include the tasks inside each request. Off by default.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Requests to return, default 100. The count always covers the whole answer.'
                        },
                        raw: {
                            type: 'boolean',
                            description: 'Return the unfiltered ADT structure instead of the flat list.'
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
            },
            {
                name: 'registerInTransport',
                description: 'Put an object into a transport request by hand, for the writes that do not register themselves - INSERT TEXTPOOL being the one this server hits. Without it the change works here and never reaches the next system. Pass the request: your own open task in it is found and used, because the function module behind this (TR_APPEND_TO_COMM_OBJS_KEYS) wants the task, not the request. The registration is verified by reading the row back out of E071 rather than trusting sy-subrc, and the 67 exceptions of that module come back as a sentence. Pass simulate to see whether it would be accepted without writing anything.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objName: {
                            type: 'string',
                            description: 'Object name, e.g. ZR_APP_FOO.'
                        },
                        object: {
                            type: 'string',
                            description: 'Object type as the transport system spells it: PROG, CLAS, TABL, REPT (a text pool), ...'
                        },
                        pgmid: {
                            type: 'string',
                            description: 'R3TR for a whole object (default), LIMU for a part of one - R3TR PROG moves a program with its text pool, LIMU REPT the pool alone.',
                            enum: ['R3TR', 'LIMU']
                        },
                        transport: {
                            type: 'string',
                            description: 'Request or task number. A request is resolved to your own open task in it; somebody else\'s task is refused rather than written to.'
                        },
                        simulate: {
                            type: 'boolean',
                            description: 'Ask the module whether it would accept the entry, without writing it (default false).'
                        }
                    },
                    required: ['objName', 'object', 'transport']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'registerInTransport':
                return this.handleRegisterInTransport(args);
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
            case 'objectTransports':
                return this.handleObjectTransports(args);
            case 'transportConflicts':
                return this.handleTransportConflicts(args);
            case 'transportReadiness':
                return this.handleTransportReadiness(args);
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
        const number = String(requestArgument(args) || '').toUpperCase();
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
            throw wrapAdtError(error, `Failed to read transport ${requestArgument(args)}`);
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
            throw wrapAdtError(error, describeAdtError(error).status === 404
                ? `No transport organizer configuration at ${args?.url}: this takes the link of one transportConfigurations answered with, and a system with no configurations has none to take`
                : 'Failed to get transport configuration');
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

    /**
     * An organizer configuration the system does not know is not refused: the
     * backend drops the filter and answers with every request it holds, which
     * measured 327,499 characters and reads exactly like the answer for the
     * configuration that was asked about. The address is checked first.
     */
    /** One data-preview read, with the rows unwrapped. */
    private async rows(sql: string, limit = 500): Promise<Record<string, any>[]> {
        if (!sql) return [];
        return rowsOf(await this.readClient.runQuery(sql, limit));
    }

    /**
     * The same read in as many statements as the 255-character limit of the
     * data preview forces - see MAX_QUERY_CHARS. The rows come back as one list.
     */
    private async allRows(queries: string[], limit = 500): Promise<Record<string, any>[]> {
        const rows: Record<string, any>[] = [];
        for (const query of queries) rows.push(...await this.rows(query, limit));
        return rows;
    }

    /** The request, its tasks and their descriptions. */
    private async requestAndTasks(number: string): Promise<{
        request: TransportRow;
        tasks: TransportRow[];
        texts: Map<string, string>;
        numbers: string[];
    }> {
        const headers = await this.rows(headerQuery(number));
        if (!headers.length) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `No transport request or task ${number} exists on this system. userTransports lists the ones you own.`
            );
        }
        const numbers = [...new Set(headers.map(row => String(row.TRKORR ?? '')).filter(Boolean))];
        const texts = textMap(await this.allRows(textQueries(numbers)));
        const rows = headers.map(row => describeRequest(row, texts));
        const self = rows.find(row => row.number === number);
        // A task was passed: the request above it is what gets released.
        if (self && self.parent) {
            return this.requestAndTasks(self.parent);
        }
        return {
            request: self || rows[0],
            tasks: rows.filter(row => row.number !== (self || rows[0]).number),
            texts,
            numbers
        };
    }

    /**
     * Where else these objects are recorded, with the header and description
     * of every request that carries them. Own requests are read too - the
     * caller decides what counts as a conflict.
     */
    private async entriesElsewhere(names: string[], own: Set<string>) {
        if (!names.length) return { rows: [] as Record<string, any>[], texts: new Map<string, string>() };
        const entries = await this.allRows(entriesByObjectQueries(names), 2000);
        const numbers = [...new Set(entries.map(row => String(row.TRKORR ?? '')).filter(Boolean))]
            .filter(number => !own.has(number));
        if (!numbers.length) return { rows: [] as Record<string, any>[], texts: new Map<string, string>() };
        const headers = await this.allRows(headerQueries(numbers), 2000);
        const byNumber = new Map(headers.map(row => [String(row.TRKORR ?? ''), row]));
        const open = headers
            .filter(row => row.TRSTATUS === 'D' || row.TRSTATUS === 'L')
            .map(row => String(row.TRKORR ?? ''));
        const texts = textMap(open.length ? await this.allRows(textQueries(open), 1000) : []);
        const rows = entries
            .filter(row => byNumber.has(String(row.TRKORR ?? '')))
            .map(row => ({ ...byNumber.get(String(row.TRKORR ?? '')), ...row }));
        return { rows, texts };
    }

    async handleObjectTransports(args: any): Promise<any> {
        const startTime = performance.now();
        const objectName = String(args?.objectName ?? '').trim().toUpperCase();
        if (!isObjectNameSafe(objectName)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `"${args?.objectName}" is not a repository object name. Pass the name, e.g. ZCL_SOMETHING, not a URL.`
            );
        }
        try {
            const entries = await this.allRows(entriesByObjectQueries([objectName]), 1000);
            const numbers = [...new Set(entries.map(row => String(row.TRKORR ?? '')).filter(Boolean))];
            const headers = numbers.length ? await this.allRows(headerQueries(numbers), 1000) : [];
            const byNumber = new Map(headers.map(row => [String(row.TRKORR ?? ''), row]));
            const texts = numbers.length ? textMap(await this.allRows(textQueries(numbers))) : new Map<string, string>();
            const history = historyOf(
                objectName,
                entries.map(row => ({ ...(byNumber.get(String(row.TRKORR ?? '')) || {}), ...row })),
                texts
            );
            this.trackRequest(startTime, true);

            const wanted = args?.includeReleased === false
                ? history.requests.filter(request => request.open)
                : history.requests;
            const max = Number.isFinite(args?.maxResults) ? Math.max(1, Math.trunc(args.maxResults)) : 50;
            const page = wanted.slice(0, max);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        object: objectName,
                        found: history.requests.length > 0,
                        summary: history.summary,
                        returned: page.length,
                        more: page.length < wanted.length,
                        requests: page,
                        hint: history.requests.length
                            ? undefined
                            : 'No transport carries this object: it is local ($TMP), or the name is spelled differently in the repository.'
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            if (error instanceof McpError) throw error;
            throw wrapAdtError(error, `Failed to read the transport history of ${objectName}`);
        }
    }

    async handleTransportConflicts(args: any): Promise<any> {
        const startTime = performance.now();
        let number: string;
        try {
            number = normalizeRequest(requestArgument(args));
        } catch (error: any) {
            throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        try {
            const { request, tasks, texts, numbers } = await this.requestAndTasks(number);
            const own = new Set([request.number, ...tasks.map(task => task.number), ...numbers]);
            const all = objectParts(await this.allRows(objectQueries([...own]), 1000));
            const maxObjects = Number.isFinite(args?.maxObjects) ? Math.max(1, Math.trunc(args.maxObjects)) : 50;
            const names = [...new Set(all.map(part => part.name).filter(isObjectNameSafe))].slice(0, maxObjects);
            const mine = all.filter(part => names.includes(part.name));
            const others = await this.entriesElsewhere(names, own);
            const found = conflictsOf(mine, others.rows, own, others.texts);
            this.trackRequest(startTime, true);

            const max = Number.isFinite(args?.maxResults) ? Math.max(1, Math.trunc(args.maxResults)) : 100;
            const page = found.conflicts.slice(0, max);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        request: request.number,
                        requestStatus: request.statusText,
                        owner: request.owner,
                        summary: found.summary,
                        objects: {
                            total: all.length,
                            examined: mine.length,
                            skipped: all.length - mine.length
                        },
                        returned: page.length,
                        more: page.length < found.conflicts.length,
                        conflicts: page,
                        hint: found.conflicts.length
                            ? 'Whoever releases last overwrites the other. Agree on the order, or move the object out of one of the requests.'
                            : undefined
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            if (error instanceof McpError) throw error;
            throw wrapAdtError(error, `Failed to look for conflicts on ${number}`);
        }
    }

    async handleTransportReadiness(args: any): Promise<any> {
        const startTime = performance.now();
        let number: string;
        try {
            number = normalizeRequest(requestArgument(args));
        } catch (error: any) {
            throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        try {
            const { request, tasks, numbers } = await this.requestAndTasks(number);
            const own = new Set([request.number, ...tasks.map(task => task.number), ...numbers]);
            const maxObjects = Number.isFinite(args?.maxObjects) ? Math.max(1, Math.trunc(args.maxObjects)) : 100;
            const allParts = objectParts(await this.allRows(objectQueries([...own]), 2000));
            const parts = allParts.slice(0, maxObjects);
            const names = [...new Set(parts.map(part => part.name).filter(isObjectNameSafe))];

            const elsewhere = await this.entriesElsewhere(names, own);
            const conflicts = conflictsOf(parts, elsewhere.rows, own, elsewhere.texts);

            const checkActivation = args?.checkActivation !== false;
            const inactive: ReturnType<typeof inactiveSources> = [];
            if (checkActivation) {
                const { names: sources, prefixes } = sourceNames(parts);
                inactive.push(...inactiveSources(await this.allRows(inactiveSourceQueries(sources, prefixes), 500)));
                const ddic = ddicNames(parts);
                const dictionary: [string, 'dd02l' | 'dd04l' | 'dd01l', string, string[]][] = [
                    ['TABNAME', 'dd02l', 'DD02L', ddic.tables],
                    ['ROLLNAME', 'dd04l', 'DD04L', ddic.dataElements],
                    ['DOMNAME', 'dd01l', 'DD01L', ddic.domains]
                ];
                for (const [field, table, label, names] of dictionary) {
                    const rows = await this.allRows(inactiveDdicQueries(table, field.toLowerCase(), names), 500);
                    inactive.push(...inactiveDdic(rows, field, label));
                }
            }

            const objectUrls = lockRegistry.all().map(lock => lock.objectUrl);
            const locks = objectUrls.filter(url => names.some(name => url.toLowerCase().includes(name.toLowerCase())));

            const verdict = readinessVerdict({
                request,
                tasks,
                objects: parts,
                conflicts: conflicts.conflicts,
                inactive,
                locks,
                activationChecked: checkActivation
            });
            this.trackRequest(startTime, true);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        request: request.number,
                        description: request.description,
                        owner: request.owner,
                        type: request.typeText,
                        requestStatus: request.statusText,
                        ready: verdict.ready,
                        checks: verdict.checks,
                        objects: {
                            total: allParts.length,
                            examined: parts.length,
                            skipped: allParts.length - parts.length
                        },
                        conflicts: conflicts.conflicts.slice(0, 20),
                        inactive: inactive.slice(0, 20),
                        tasks: tasks.map(task => ({ number: task.number, owner: task.owner, status: task.statusText }))
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            if (error instanceof McpError) throw error;
            throw wrapAdtError(error, `Failed to check whether ${number} is ready for release`);
        }
    }

    async handleTransportsByConfig(args: any): Promise<any> {
        const startTime = performance.now();
        const configUri = String(args?.configUri ?? '');
        let known: string[] = [];
        try {
            const configurations = await this.readClient.transportConfigurations();
            known = (Array.isArray(configurations) ? configurations : [])
                .map((c: any) => String(c?.link ?? ''))
                .filter(Boolean);
        } catch {
            // The check is a courtesy; a system that will not list its
            // configurations should not stop the call that was asked for.
            known = [];
        }
        if (known.length && !known.some(link => link === configUri || link.endsWith(configUri) || configUri.endsWith(link))) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `No organizer configuration is published at ${configUri}. The backend would answer that with every transport request in the system, not with none. ` +
                `The configurations this system has are: ${known.slice(0, 10).join(', ')}.`
            );
        }
        if (!known.length) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'This system publishes no transport organizer configurations, so there is nothing this tool can be pointed at - and the backend would answer any address with every request it holds. Use userTransports for your own requests, or transportDetails for one by number.'
            );
        }
        try {
            const transports = await this.readClient.transportsByConfig(configUri, args.targets);
            this.trackRequest(startTime, true);
            if (args?.raw === true) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ status: 'success', configUri, transports }) }]
                };
            }
            const requests = this.flattenTransports(transports, args);
            const max = Number.isFinite(args?.maxResults) ? Math.max(1, Math.trunc(args.maxResults)) : 100;
            const page = requests.slice(0, max);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            configUri,
                            count: requests.length,
                            returned: page.length,
                            more: page.length < requests.length,
                            requests: page
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
            const result = await this.adtclient.transportDelete(requestArgument(args) as string);
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
            const result = await this.adtclient.transportRelease(requestArgument(args) as string, args.ignoreLocks, args.IgnoreATC);
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
            const result = await this.adtclient.transportSetOwner(requestArgument(args) as string, args.targetuser);
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

    /**
     * Add somebody to a request - which, in the transport system, means giving
     * them a task of their own inside it.
     *
     * The raw answer is three tm: fields, and the number in them is the NEW
     * task, not the request that was passed. Measured live: adding a user to
     * DEVK9A3P84 answered with DEVK9A3P86, and the next call - which took the
     * request number - then had two open tasks to choose between without
     * anything having said a second one appeared.
     */
    async handleTransportAddUser(args: any): Promise<any> {
        const request = String(requestArgument(args) || '');
        const user = String(args?.user || '').toUpperCase();
        if (!request || !user) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Pass the request (transportNumber) and the user to add. The user gets a task of their own inside the request.'
            );
        }
        const startTime = performance.now();
        try {
            const result: any = await this.adtclient.transportAddUser(request, user);
            this.trackRequest(startTime, true);
            const task = result?.['tm:number'];
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            request,
                            user,
                            ...(task && task !== request ? { taskCreated: task } : {}),
                            note: task && task !== request
                                ? `${user} now has task ${task} in request ${request}. Write to the task, not to the request.`
                                : `${user} was added to request ${request}.`,
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to add ${user} to transport ${request}`);
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

    /** Rows of a SELECT, through the tool that already runs them. */
    private async queryRows(sqlQuery: string, rowNumber = 50): Promise<Record<string, string>[]> {
        const result = await this.queries.handleRunQuery({ sqlQuery, rowNumber });
        const payload = JSON.parse(result.content[0].text);
        const values = payload?.result?.values;
        return Array.isArray(values) ? values : [];
    }

    /**
     * Where the object already sits.
     *
     * OB_LOCKED_BY_OTHER is the common refusal and the least self-explanatory:
     * an object lives in one open request at a time, and the answer the caller
     * needs is which one - not that there is one.
     */
    private async holders(row: E071Row): Promise<Record<string, string>[]> {
        try {
            return await this.queryRows(holdersSql(row), 10);
        } catch {
            // A courtesy lookup must not replace the original diagnosis with an
            // error about the lookup.
            return [];
        }
    }

    /**
     * Whether an object would travel: its package, and the open requests that
     * already carry it.
     *
     * Written for the tools that change something a transport does not pick up
     * by itself. The trap it exists to name was measured: a program's selection
     * texts were changed, the request held only its includes, and the texts
     * would have stayed behind in the development system without a word.
     */
    async registrationState(spec: { pgmid?: string; object: string; objName: string }): Promise<{
        row: E071Row;
        local: boolean;
        devclass?: string;
        openRequests: Record<string, string>[];
    }> {
        const row = buildE071Row(spec);
        const tadir = await this.queryRows(packageSql(row), 1);
        const devclass = tadir[0]?.DEVCLASS;
        if (isLocalPackage(devclass)) {
            return { row, local: true, devclass, openRequests: [] };
        }
        return { row, local: false, devclass, openRequests: await this.holders(row) };
    }

    async handleRegisterInTransport(args: any): Promise<any> {
        let row: E071Row;
        let given: string;
        try {
            row = buildE071Row({ pgmid: args?.pgmid, object: args?.object, objName: args?.objName });
            given = transportNumber(requestArgument(args));
        } catch (error: any) {
            if (error instanceof TransportRegistrationError) {
                throw new McpError(ErrorCode.InvalidParams, error.message);
            }
            throw error;
        }

        const user = String(this.adtclient.username || '').toUpperCase();
        const simulate = args?.simulate === true;
        const steps: Record<string, unknown>[] = [];

        // Which task to write to. A request is resolved here rather than in the
        // module, which takes a request number and quietly does nothing useful
        // with it.
        const header = (await this.queryRows(headerSql(given), 1))[0] as TransportHeaderRow | undefined;
        const tasks = header && !String(header.STRKORR || '').trim()
            ? await this.queryRows(tasksSql(given)) as TransportHeaderRow[]
            : [];
        let choice;
        try {
            choice = chooseTask(given, header, tasks, user);
        } catch (error: any) {
            if (error instanceof TransportRegistrationError) {
                throw new McpError(ErrorCode.InvalidParams, error.message);
            }
            throw error;
        }
        steps.push({ step: 'resolveTask', task: choice.task, resolvedFrom: choice.resolvedFrom, ...(choice.request ? { request: choice.request } : {}) });

        const called = await this.calls.handleCallFunction({
            name: 'TR_APPEND_TO_COMM_OBJS_KEYS',
            values: {
                WI_TRKORR: choice.task,
                WI_SIMULATION: simulate ? 'X' : ' ',
                WT_E071: [row],
                WT_E071K: []
            },
            // The module writes E071 and the call is rolled back by default,
            // which would undo exactly the thing this tool is for.
            commit: !simulate
        });
        const call = JSON.parse(called.content[0].text);
        const exception = String(call?.exceptionRaised || '').toUpperCase();
        steps.push({
            step: 'call',
            ran: call?.ran === true,
            subrc: call?.subrc,
            ...(exception ? { exception, diagnosis: diagnose(exception) } : {}),
            ...(call?.ran === true ? {} : { error: call?.runError?.error })
        });

        const failed = call?.ran !== true || call?.subrc !== 0 || !!exception;
        if (failed) {
            const holders = exception === 'OB_LOCKED_BY_OTHER' ? await this.holders(row) : [];
            return {
                content: [{
                    type: 'text', text: JSON.stringify({
                        status: 'error',
                        registered: false,
                        ...(simulate ? { simulated: true } : {}),
                        transport: choice.request || choice.task,
                        task: choice.task,
                        row,
                        steps,
                        ...(holders.length ? { heldBy: holders } : {}),
                        hint: exception
                            ? diagnose(exception)
                            : 'The module did not run; nothing was registered.'
                    })
                }]
            };
        }

        if (simulate) {
            return {
                content: [{
                    type: 'text', text: JSON.stringify({
                        status: 'success',
                        registered: false,
                        simulated: true,
                        transport: choice.request || choice.task,
                        task: choice.task,
                        row,
                        steps,
                        hint: `${row.PGMID} ${row.OBJECT} ${row.OBJ_NAME} would be accepted into ${choice.task}. Nothing was written.`
                    })
                }]
            };
        }

        // sy-subrc = 0 is not proof: RS_CORR_INSERT answers plausibly and
        // registers nothing, and the message SCTS_CTO_CUST_SYNC/003 sits in
        // sy-msg* after a call that worked. The row in E071 is the proof.
        const written = await this.queryRows(registeredSql(choice.task, row), 5);
        steps.push({ step: 'verify', foundInE071: written.length });

        return {
            content: [{
                type: 'text', text: JSON.stringify({
                    status: written.length ? 'success' : 'error',
                    registered: written.length > 0,
                    transport: choice.request || choice.task,
                    task: choice.task,
                    row,
                    steps,
                    hint: written.length
                        ? `${row.PGMID} ${row.OBJECT} ${row.OBJ_NAME} is in task ${choice.task}` +
                          (choice.request ? ` of request ${choice.request}.` : '.')
                        : 'The module reported success but E071 has no such row, so nothing travels. ' +
                          'Check the request in SE09 before relying on this.'
                })
            }]
        };
    }
}
