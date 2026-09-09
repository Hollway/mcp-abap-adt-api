import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { DebuggingMode, DebuggerScope, DebugBreakpoint, DebugSettings } from 'abap-adt-api';

export class DebugHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'debuggerListeners',
                description: 'Which debug listeners exist for this user and terminal - who would catch a breakpoint right now. Read this before starting one: a second listener for the same user is refused, and an old one left behind is the usual reason a debug session cannot be started.',
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
                        }
                    },
                    required: ['debuggingMode', 'terminalId', 'ideId', 'user']
                }
            },
            {
                name: 'debuggerListen',
                description: 'Start listening for a breakpoint and WAIT until something hits one - the call does not return until a process stops, or the wait times out. That is the shape of the whole debugger here: set breakpoints, start listening, then run the program from somewhere else (SAPGUI, a job, a service call), and this returns when it stops. Nothing in this server can trigger the program for you, so a listener with nothing to trigger it just waits. It occupies the session; delete the listener when you are done.',
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
                description: 'Set breakpoints on lines of a source, or on a statement, for the debug session that follows. They belong to the user and survive until deleted, so they will also stop a colleague running the same code with your user. Set them BEFORE debuggerListen; the ids that come back are what deletes them again.',
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
                description: 'Attach to the process that has stopped at a breakpoint, which is what debuggerListen reported. Only after this do the stack and the variables mean anything; the attachment holds the stopped process, so let it go (debuggerStep with terminate, or delete the listener) rather than leaving a work process frozen.',
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
                description: 'Change how the debugger behaves for this user: system debugging, update debugging, how much of a table it reads. They are user settings and stay until changed back.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        settings: {
                            type: 'string',
                            description: 'The debugger settings.'
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
                description: 'Move the debugger view to another frame of the stack, so that debuggerVariables shows what is visible THERE. It changes the view, not the position of the program - the process still stands where it stopped.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        urlOrPosition: {
                            type: 'string',
                            description: 'The URL or position of the stack entry.'
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
            const result = await this.adtclient.debuggerListeners(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.user,
                args.checkConflict
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
            throw wrapAdtError(error, 'Failed to get debugger listeners');
        }
    }

    async handleDebuggerListen(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerListen(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.user,
                args.checkConflict,
                args.isNotifiedOnConflict
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
            throw wrapAdtError(error, 'Failed to start debugger listener');
        }
    }

    async handleDebuggerDeleteListener(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerDeleteListener(
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.user
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
            throw wrapAdtError(error, 'Failed to delete debugger listener');
        }
    }

    async handleDebuggerSetBreakpoints(args: any): Promise<any> {
        const startTime = performance.now();
        try {
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
            throw wrapAdtError(error, 'Failed to set breakpoints');
        }
    }

    async handleDebuggerDeleteBreakpoints(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerDeleteBreakpoints(
                args.breakpoint,
                args.debuggingMode,
                args.terminalId,
                args.ideId,
                args.requestUser,
                args.scope
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
            throw wrapAdtError(error, 'Failed to delete breakpoints');
        }
    }

    async handleDebuggerAttach(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerAttach(
                args.debuggingMode,
                args.debuggeeId,
                args.user,
                args.dynproDebugging
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
            throw wrapAdtError(error, 'Failed to attach debugger');
        }
    }

    async handleDebuggerSaveSettings(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerSaveSettings(args.settings);
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
            throw wrapAdtError(error, 'Failed to save debugger settings');
        }
    }

    async handleDebuggerStackTrace(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerStackTrace(args.semanticURIs);
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
            throw wrapAdtError(error, 'Failed to get stack trace');
        }
    }

    async handleDebuggerVariables(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerVariables(args.parents);
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
            throw wrapAdtError(error, 'Failed to get variables');
        }
    }

    async handleDebuggerChildVariables(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerChildVariables(args.parent);
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
            throw wrapAdtError(error, 'Failed to get child variables');
        }
    }

    async handleDebuggerStep(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerStep(args.steptype, args.url);
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
            throw wrapAdtError(error, 'Failed to perform debug step');
        }
    }

    async handleDebuggerGoToStack(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerGoToStack(args.urlOrPosition);
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
            throw wrapAdtError(error, 'Failed to go to stack position');
        }
    }

    async handleDebuggerSetVariableValue(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.debuggerSetVariableValue(args.variableName, args.value);
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
            throw wrapAdtError(error, 'Failed to set variable value');
        }
    }
}
