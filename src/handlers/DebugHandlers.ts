import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { describeAdtError, wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { DebuggingMode, DebuggerScope, DebugBreakpoint, DebugSettings } from 'abap-adt-api';
import {
    attachedDebuggee,
    clearAttached,
    clearListen,
    closeDebugSession,
    debugClient,
    debugFailure,
    hasDebugClient,
    listenKey,
    pendingListen,
    rememberListen,
    setAttached,
    waitForListen
} from '../lib/debugSession';

export class DebugHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'debuggerListeners',
                description: 'Which debug listeners exist for this user and terminal - who would catch a breakpoint right now. Read this before starting one: a second listener for the same user is refused, and an old one left behind is the usual reason a debug session cannot be started. checkConflict is off by default because the backend raises a short dump for it when no listener exists at all - turn it on only once you know one is there.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        debuggingMode: {
                            type: 'string',
                            description: 'The debugging mode.'
                        },
                        terminalId: {
                            type: 'string',
                            description: 'The terminal ID.'
                        },
                        ideId: {
                            type: 'string',
                            description: 'The IDE ID.'
                        },
                        user: {
                            type: 'string',
                            description: 'The user.'
                        },
                        checkConflict: {
                            type: 'boolean',
                            description: 'Ask the backend whether this listener would conflict with another. Default false: on a system with no listener at all, the check itself answers 500 AdiFailed.'
                        }
                    },
                    required: ['debuggingMode', 'terminalId', 'ideId', 'user']
                }
            },
            {
                name: 'debuggerListen',
                description: 'Start listening for a breakpoint and wait for one, for waitSeconds at a time. That is the shape of the whole debugger here: set breakpoints, start listening, then run the program from somewhere else (SAPGUI, a background job, a service call), and this answers when it stops. Nothing in this server can trigger the program for you - a listener with nothing to trigger it waits out its time and says so, and the listener stays registered, so calling again rejoins the same wait rather than starting a second one (the backend refuses a second listener for the same user anyway). The waiting happens on a debug session of its own, so locks, writes and reads carry on meanwhile. Delete the listener when you are done.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        debuggingMode: {
                            type: 'string',
                            description: 'The debugging mode.'
                        },
                        terminalId: {
                            type: 'string',
                            description: 'The terminal ID.'
                        },
                        ideId: {
                            type: 'string',
                            description: 'The IDE ID.'
                        },
                        user: {
                            type: 'string',
                            description: 'The user.'
                        },
                        checkConflict: {
                            type: 'boolean',
                            description: 'Whether to check for conflicts.'
                        },
                        isNotifiedOnConflict: {
                            type: 'boolean',
                            description: 'Whether to be notified on conflict.'
                        },
                        waitSeconds: {
                            type: 'number',
                            description: 'How long to wait for a breakpoint before answering, in seconds. Default 60, maximum 900. Waiting longer does not make the listener last longer, and what is in front of the system may cut the connection first: measured on one landscape, a reverse proxy answered 504 after about three and a half minutes and the listener died with it.'
                        }
                    },
                    required: ['debuggingMode', 'terminalId', 'ideId', 'user']
                }
            },
            {
                name: 'debuggerDeleteListener',
                description: 'Stop listening for breakpoints and free the session. Do it when a debug session is over or abandoned - a listener left behind blocks the next one for the same user.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        debuggingMode: {
                            type: 'string',
                            description: 'The debugging mode.'
                        },
                        terminalId: {
                            type: 'string',
                            description: 'The terminal ID.'
                        },
                        ideId: {
                            type: 'string',
                            description: 'The IDE ID.'
                        },
                        user: {
                            type: 'string',
                            description: 'The user.'
                        }
                    },
                    required: ['debuggingMode', 'terminalId', 'ideId', 'user']
                }
            },
            {
                name: 'debuggerSetBreakpoints',
                description: 'Set breakpoints on lines of a source, or on a statement, for the debug session that follows. They belong to the user and survive until deleted, so they will also stop a colleague running the same code with your user. Set them BEFORE debuggerListen; the ids that come back are what deletes them again. A breakpoint the backend accepts is not a breakpoint that stops anything: whether a process actually halts depends on external debugging being available to your user on that system, and it is worth proving once with something harmless - measured on a classic ERP system, an accepted breakpoint stopped neither a background job, nor a task started with STARTING NEW TASK, nor a class run through runClass, with and without systemDebugging. A class run through runClass can go further without going all the way: the call returns its console output as if nothing happened, yet the next debuggerListen reports caughtWhileNotWaiting for that exact line - the backend logged the hit without ever holding the work process for it, and debuggerAttach against that debuggeeId then fails with a bare 500 because there is nothing left to attach to.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        debuggingMode: {
                            type: 'string',
                            description: 'The debugging mode.'
                        },
                        terminalId: {
                            type: 'string',
                            description: 'The terminal ID.'
                        },
                        ideId: {
                            type: 'string',
                            description: 'The IDE ID.'
                        },
                        clientId: {
                            type: 'string',
                            description: 'The client ID.'
                        },
                        breakpoints: {
                            type: 'array',
                            description: 'An array of breakpoints.'
                        },
                        user: {
                            type: 'string',
                            description: 'The user.'
                        },
                        scope: {
                            type: 'string',
                            description: 'The debugger scope.'
                        },
                        systemDebugging: {
                            type: 'boolean',
                            description: 'Whether to enable system debugging.'
                        },
                        deactivated: {
                            type: 'boolean',
                            description: 'Whether to deactivate the breakpoints.'
                        },
                        syncScupeUrl: {
                            type: 'string',
                            description: 'The URL for scope synchronization.'
                        }
                    },
                    required: ['debuggingMode', 'terminalId', 'ideId', 'clientId', 'breakpoints', 'user']
                }
            },
            {
                name: 'debuggerDeleteBreakpoints',
                description: 'Remove breakpoints that were set earlier - the ids come from debuggerSetBreakpoints. Worth doing even after a failed session: a forgotten breakpoint stops a productive program the next time it runs.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        breakpoint: {
                            type: 'object',
                            description: 'The breakpoint to delete.'
                        },
                        debuggingMode: {
                            type: 'string',
                            description: 'The debugging mode.'
                        },
                        terminalId: {
                            type: 'string',
                            description: 'The terminal ID.'
                        },
                        ideId: {
                            type: 'string',
                            description: 'The IDE ID.'
                        },
                        requestUser: {
                            type: 'string',
                            description: 'The requesting user.'
                        },
                        scope: {
                            type: 'string',
                            description: 'The debugger scope.'
                        }
                    },
                    required: ['breakpoint', 'debuggingMode', 'terminalId', 'ideId', 'requestUser']
                }
            },
            {
                name: 'debuggerAttach',
                description: 'Attach to the process that has stopped at a breakpoint, which is what debuggerListen reported. Only after this do the stack and the variables mean anything; the attachment holds the stopped process, so let it go (debuggerStep with terminate, or delete the listener) rather than leaving a work process frozen. A debuggeeId from a caughtWhileNotWaiting answer is not a guarantee that anything is still there to attach to: measured on a classic ERP system, a class run through runClass returned its full console output before this was ever called, and debuggerAttach against the debuggeeId it was caught under answered a bare 500 AdiFailed both times it was tried - the backend had logged the hit but had not actually held the work process open for it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        debuggingMode: {
                            type: 'string',
                            description: 'The debugging mode.'
                        },
                        debuggeeId: {
                            type: 'string',
                            description: 'The ID of the debuggee.'
                        },
                        user: {
                            type: 'string',
                            description: 'The user.'
                        },
                        dynproDebugging: {
                            type: 'boolean',
                            description: 'Whether to enable Dynpro debugging.'
                        }
                    },
                    required: ['debuggingMode', 'debuggeeId', 'user']
                }
            },
            {
                name: 'debuggerSaveSettings',
                description: 'Change how the debugger behaves for this user: system debugging, update debugging, whether an exception raises an exception object. They are user settings and stay until changed back. Every flag left out keeps the backend default, which is off for all of them except showDataAging - the answer reports what was actually sent. The backend takes them for a debug session; without one it answers a bare 500.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        settings: {
                            type: 'object',
                            description: 'The debugger settings: systemDebugging, createExceptionObject, backgroundRFC, sharedObjectDebugging, showDataAging, updateDebugging - all booleans. A JSON string of the same object is accepted.',
                            properties: {
                                systemDebugging: { type: 'boolean', description: 'Stop in SAP system code as well.' },
                                createExceptionObject: { type: 'boolean', description: 'Create an exception object when one is raised.' },
                                backgroundRFC: { type: 'boolean', description: 'Debug background RFC calls.' },
                                sharedObjectDebugging: { type: 'boolean', description: 'Debug shared objects.' },
                                showDataAging: { type: 'boolean', description: 'Show the data aging column. The backend default is on.' },
                                updateDebugging: { type: 'boolean', description: 'Debug the update task.' }
                            }
                        }
                    },
                    required: ['settings']
                }
            },
            {
                name: 'debuggerStackTrace',
                description: 'The call stack of the process stopped at a breakpoint: which programs and methods it came through, with the line each is on. Needs an attached session (debuggerAttach); use debuggerGoToStack to look at variables from a frame further up.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        semanticURIs: {
                            type: 'boolean',
                            description: 'Whether to use semantic URIs.'
                        }
                    }
                }
            },
            {
                name: 'debuggerVariables',
                description: 'The variables visible in the current stack frame, with their values. Needs an attached session. A structure or a table comes back as a node to open with debuggerChildVariables rather than as its contents.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        parents: {
                            type: 'array',
                            description: 'An array of parent variable names.'
                        }
                    },
                    required: ['parents']
                }
            },
            {
                name: 'debuggerChildVariables',
                description: 'Open one variable that has parts: the fields of a structure, the rows of an internal table, what a reference points at. Takes the variable id from debuggerVariables.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        parent: {
                            type: 'array',
                            description: 'The parent variable name.'
                        }
                    }
                }
            },
            {
                name: 'debuggerStep',
                description: 'Step the stopped process: into, over, out, to a line, or terminate it. Each step answers with where it now stands, so the stack and the variables have to be read again. Terminating ends the debugged program - which is how a stopped work process is let go when the session is over.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        steptype: {
                            type: 'string',
                            description: 'The type of step to perform.'
                        },
                        url: {
                            type: 'string',
                            description: 'The URL for step types "stepRunToLine" or "stepJumpToLine".'
                        }
                    },
                    required: ['steptype']
                }
            },
            {
                name: 'debuggerGoToStack',
                description: 'Move the debugger view to another frame of the stack, so that debuggerVariables shows what is visible THERE. It changes the view, not the position of the program - the process still stands where it stopped. Two forms, because the backend has two: the frame number (1, 2, 3 ... - what a stack from an older system gives you, and the only form such a system takes) or the full stackUri of the frame that a newer one reports.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        urlOrPosition: {
                            type: 'string',
                            description: 'The frame number as it stands in the stack ("2"), or the full stack URI /sap/bc/adt/debugger/stack/type/<type>/position/<n>.'
                        }
                    },
                    required: ['urlOrPosition']
                }
            },
            {
                name: 'debuggerSetVariableValue',
                description: 'Change a variable in the stopped process, as the debugger lets you. The program then carries on with the new value, which is a way to reach a branch that the data would not otherwise reach - and a way to make a productive program do something it never would. Only for a session you are deliberately steering.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        variableName: {
                            type: 'string',
                            description: 'The name of the variable.'
                        },
                        value: {
                            type: 'string',
                            description: 'The new value of the variable.'
                        }
                    },
                    required: ['variableName', 'value']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'debuggerListeners':
                return this.handleDebuggerListeners(args);
            case 'debuggerListen':
                return this.handleDebuggerListen(args);
            case 'debuggerDeleteListener':
                return this.handleDebuggerDeleteListener(args);
            case 'debuggerSetBreakpoints':
                return this.handleDebuggerSetBreakpoints(args);
            case 'debuggerDeleteBreakpoints':
                return this.handleDebuggerDeleteBreakpoints(args);
            case 'debuggerAttach':
                return this.handleDebuggerAttach(args);
            case 'debuggerSaveSettings':
                return this.handleDebuggerSaveSettings(args);
            case 'debuggerStackTrace':
                return this.handleDebuggerStackTrace(args);
            case 'debuggerVariables':
                return this.handleDebuggerVariables(args);
            case 'debuggerChildVariables':
                return this.handleDebuggerChildVariables(args);
            case 'debuggerStep':
                return this.handleDebuggerStep(args);
            case 'debuggerGoToStack':
                return this.handleDebuggerGoToStack(args);
            case 'debuggerSetVariableValue':
                return this.handleDebuggerSetVariableValue(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown debug tool: ${toolName}`);
        }
    }

    async handleDebuggerListeners(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            // The library defaults this to true, and the backend raises a short
            // dump for the conflict check when there is no listener to conflict
            // with - which is every system where nobody is debugging. Ask for
            // the check only when the caller says so.
            const checkConflict = args.checkConflict === true;
            const result = await this.adtclient.debuggerListeners(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.user,
                checkConflict
            );
            this.trackRequest(startTime, true);
            // An empty answer means nobody is listening. Saying so beats a bare
            // success that reads the same as a listener that was found.
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            debuggingMode: args.debuggingMode,
                            user: args.user,
                            checkConflict,
                            listener: result ? 'conflict' : 'none',
                            // What the backend reports is what it sees from
                            // outside; this is what this server is holding.
                            debugSession: hasDebugClient() ? 'open here' : 'none here',
                            ...this.listenerHere(args),
                            ...(result
                                ? { result }
                                : { note: 'No debug listener for this user and terminal. A breakpoint would not be caught: start one with debuggerListen.' })
                        })
                    }
                ]
            };
        } catch (error: any) {
            // 404 here is an answer, not a failure: with no listener registered
            // for this user at all, the backend refuses the resource itself -
            // and names it as a blank ("Resource   does not exist."). Measured
            // both ways on one system within the hour: it answered 200 while a
            // listener was registered, and 404 from the moment the last one was
            // deleted.
            const info = describeAdtError(error);
            if (info.status === 404) {
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                debuggingMode: args.debuggingMode,
                                user: args.user,
                                listener: 'none',
                                registration: 'none',
                                debugSession: hasDebugClient() ? 'open here' : 'none here',
                                ...this.listenerHere(args),
                                note: 'The backend has no debug listener registration for this user at all - it refuses the listeners resource with 404 rather than answering an empty list. Start one with debuggerListen.'
                            })
                        }
                    ]
                };
            }
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get debugger listeners');
        }
    }

    /** What this server is holding for the listener the caller is asking about. */
    private listenerHere(args: any): Record<string, unknown> {
        const listen = pendingListen(listenKey(args));
        if (!listen) return {};
        if (!listen.settled) {
            return { waitingHere: true, note2: 'A listener started here is still waiting. Call debuggerListen to rejoin that wait.' };
        }
        if (listen.error) {
            return { listenerEndedHere: true, note2: 'The listener started here ended with an error. Call debuggerListen to see it and start again.' };
        }
        return {
            caughtWhileNotWaiting: true,
            note2: 'A listener started here caught a process while nothing was waiting for it. Call debuggerListen to collect it - it is stopped until somebody attaches or terminates it.'
        };
    }

    async handleDebuggerListen(args: any): Promise<any> {
        const startTime = performance.now();
        const seconds = this.waitSeconds(args.waitSeconds);
        const key = listenKey(args);
        // A listener already waiting is rejoined rather than started again:
        // the backend refuses a second one for the same user, and the first
        // is the one that will answer.
        const existing = pendingListen(key);
        // It may have answered while nothing was waiting for it: a process is
        // then standing stopped, and this call is what comes to collect it.
        const answeredEarlier = existing?.settled === true;
        const pending = existing ?? rememberListen(
            key,
            debugClient(this.adtclient).debuggerListen(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.user,
                args.checkConflict,
                args.isNotifiedOnConflict
            )
        );
        try {
            const outcome = await waitForListen<any>(pending, seconds);
            this.trackRequest(startTime, true);
            if (!outcome.stopped) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'waiting',
                                listener: 'registered',
                                waitedSeconds: seconds,
                                listeningSince: new Date(pending.startedAt).toISOString(),
                                rejoined: existing !== undefined,
                                note: 'Nothing stopped at a breakpoint yet. The listener is still registered and still waiting on its own session: call debuggerListen again to keep waiting, run the program that should stop, or call debuggerDeleteListener to give up. Nothing in this server can trigger the program for you.'
                            })
                        }
                    ]
                };
            }
            clearListen();
            const debuggeeId = outcome.value?.DEBUGGEE_ID || outcome.value?.debuggeeId;
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            stopped: true,
                            stoppedAt: new Date().toISOString(),
                            ...(answeredEarlier
                                ? { caughtWhileNotWaiting: true, note: 'It stopped while no call was waiting for it, so it has been standing there since. Attach or terminate it rather than leaving the work process held.' }
                                : {}),
                            ...(debuggeeId
                                ? { debuggeeId, next: 'debuggerAttach with this debuggeeId, then debuggerStackTrace and debuggerVariables.' }
                                : {}),
                            result: outcome.value
                        })
                    }
                ]
            };
        } catch (error: any) {
            clearListen();
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, this.listenFailure(error, pending.startedAt));
        }
    }

    /**
     * Why a listener ended without catching anything.
     *
     * Measured on a classic ERP system behind a reverse proxy: the listening
     * POST is cut with 504 after about three and a half minutes, whatever the
     * library's own timeout says (it sends 360000000 ms - one hundred hours).
     * The listener goes with the connection, so the next call starts a new
     * one rather than rejoining a listener that no longer exists.
     */
    private listenFailure(error: unknown, startedAt: number): string {
        const status = describeAdtError(error).status;
        if (status === 504 || status === 502 || status === 408) {
            const waited = Math.round((Date.now() - startedAt) / 1000);
            return `The listener's connection was cut after ${waited}s (HTTP ${status} from whatever sits in front of the system, not from SAP) - the listener is gone with it, start another one if the program has still to run`;
        }
        return 'Failed to start debugger listener';
    }

    /** The bound on one wait: a minute by default, a quarter of an hour at most. */
    private waitSeconds(requested: unknown): number {
        const asked = Number(requested);
        if (!Number.isFinite(asked) || asked <= 0) return 60;
        return Math.max(1, Math.min(Math.round(asked), 900));
    }

    async handleDebuggerDeleteListener(args: any): Promise<any> {
        return this.tracked('Failed to delete debugger listener', async () => {
            // Deliberately the main client: this request has to overtake the
            // listener's own pending POST, and on the debug session it would
            // queue behind the very call it is ending.
            const result = await this.adtclient.debuggerDeleteListener(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.user
            );
            clearListen();
            // A debuggee still stopped needs the session that holds it, so it
            // is kept: closing it here would leave a frozen work process with
            // nothing able to let it go.
            const attached = attachedDebuggee();
            if (!attached) await closeDebugSession();
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            listener: 'deleted',
                            debugSession: attached ? 'kept' : 'closed',
                            ...(attached
                                ? {
                                    attachedDebuggee: attached,
                                    note: 'A debuggee is still attached and still stopped. Let it go with debuggerStep steptype "terminateDebuggee", which also closes the debug session.'
                                }
                                : {}),
                            result
                        })
                    }
                ]
            };
        });
    }

    async handleDebuggerSetBreakpoints(args: any): Promise<any> {
        return this.tracked('Failed to set breakpoints', async () => {
            const result = await this.adtclient.debuggerSetBreakpoints(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.clientId,
                this.parseObjectArg(args.breakpoints, 'breakpoints'),
                args.user,
                args.scope,
                args.systemDebugging,
                args.deactivated,
                args.syncScupeUrl
            );
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
        });
    }

    async handleDebuggerDeleteBreakpoints(args: any): Promise<any> {
        return this.tracked('Failed to delete breakpoints', async () => {
            const result = await this.adtclient.debuggerDeleteBreakpoints(
                this.parseObjectArg<DebugBreakpoint>(args.breakpoint, 'breakpoint'),
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.requestUser,
                args.scope
            );
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
        });
    }

    async handleDebuggerAttach(args: any): Promise<any> {
        return this.tracked('Failed to attach debugger', async () => {
            const result = await debugClient(this.adtclient).debuggerAttach(
                args.debuggingMode,
                args.debuggeeId,
                args.user,
                args.dynproDebugging
            );
            setAttached(String(args.debuggeeId));
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
        });
    }

    async handleDebuggerSaveSettings(args: any): Promise<any> {
        const startTime = performance.now();
        // The library destructures the six flags out of whatever it is given.
        // A string has none of them, so every setting fell back to its default
        // and two calls with different JSON sent the same body.
        const settings = this.parseObjectArg<Partial<DebugSettings>>(args.settings, 'settings');
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            throw new McpError(ErrorCode.InvalidParams, "Parameter 'settings' must be an object of debugger flags, e.g. {\"systemDebugging\":true}");
        }
        try {
            const result = await debugClient(this.adtclient).debuggerSaveSettings(settings);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            sent: settings,
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, debugFailure('Failed to save debugger settings'));
        }
    }

    async handleDebuggerStackTrace(args: any): Promise<any> {
        return this.tracked(debugFailure('Failed to get stack trace'), async () => {
            const result = await debugClient(this.adtclient).debuggerStackTrace(args.semanticURIs);
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
        });
    }

    async handleDebuggerVariables(args: any): Promise<any> {
        return this.tracked(debugFailure('Failed to get variables'), async () => {
            const result = await debugClient(this.adtclient).debuggerVariables(
                this.parseObjectArg<string[]>(args.parents, 'parents')
            );
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
        });
    }

    async handleDebuggerChildVariables(args: any): Promise<any> {
        return this.tracked(debugFailure('Failed to get child variables'), async () => {
            const result = await debugClient(this.adtclient).debuggerChildVariables(
                args.parent === undefined ? undefined : this.parseObjectArg<string[]>(args.parent, 'parent')
            );
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
        });
    }

    async handleDebuggerStep(args: any): Promise<any> {
        const startTime = performance.now();
        const steptype = String(args.steptype || '');
        // Two of the step types are a destination, not a direction, and the
        // backend answers a bare 500 when the destination is missing.
        if ((steptype === 'stepRunToLine' || steptype === 'stepJumpToLine') && !args.url) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Step type '${steptype}' needs url - the line to go to, as the stack trace reports it (.../source/main#start=<line>).`
            );
        }
        try {
            const result = await debugClient(this.adtclient).debuggerStep(steptype as any, args.url);
            // Terminating ends the debugged program, so nothing is attached
            // any more and the session that held it has nothing left to hold.
            if (steptype === 'terminateDebuggee') {
                clearAttached();
                await closeDebugSession();
            }
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...(steptype === 'terminateDebuggee'
                                ? { debuggee: 'terminated', debugSession: 'closed' }
                                : {}),
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, debugFailure('Failed to perform debug step'));
        }
    }

    async handleDebuggerGoToStack(args: any): Promise<any> {
        const startTime = performance.now();
        // The library picks the endpoint by the type it is handed: a string is
        // a stack URI and is checked against a pattern, a number goes to the
        // older setStackPosition. The schema only had a string, so a caller
        // naming frame 2 was refused with "Invalid stack URL: 2" and the
        // older systems - which report no stackUri at all - had no way in.
        const frame = this.stackTarget(args.urlOrPosition);
        try {
            const result = await debugClient(this.adtclient).debuggerGoToStack(frame);
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
            throw wrapAdtError(error, debugFailure('Failed to go to stack position'));
        }
    }

    /** A frame number, or the stack URI of a frame - and nothing else. */
    private stackTarget(value: unknown): string | number {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const text = String(value ?? '').trim();
        if (/^\d+$/.test(text)) return Number(text);
        if (/^\/sap\/bc\/adt\/debugger\/stack\/type\/\w+\/position\/\d+$/.test(text)) return text;
        throw new McpError(
            ErrorCode.InvalidParams,
            `urlOrPosition '${text}' is neither a frame number nor a stack URI. Pass the frame's number as the stack trace lists it ("2"), or its full stackUri /sap/bc/adt/debugger/stack/type/<type>/position/<n>.`
        );
    }

    async handleDebuggerSetVariableValue(args: any): Promise<any> {
        return this.tracked(debugFailure('Failed to set variable value'), async () => {
            const result = await debugClient(this.adtclient).debuggerSetVariableValue(args.variableName, args.value);
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
        });
    }
}
