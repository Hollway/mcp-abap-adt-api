import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { SnippetHandlers } from './SnippetHandlers.js';
import { FunctionModuleHandlers } from './FunctionModuleHandlers.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import type { ADTClient } from 'abap-adt-api';
import { buildFunctionCall, buildMethodCall, interpretCall, CallGenError } from '../lib/callGen';
import type { GeneratedCall } from '../lib/callGen';
import { parseMethodSignature, MethodSignatureError } from '../lib/methodSignature';
import { decodeResultPayload, parseAsXmlValues, AsXmlError } from '../lib/asXml';
import { snippetClassName, buildSnippetClass } from '../lib/snippet';

/**
 * Calling something that already exists, with values, and reading what it
 * gave back.
 *
 * runSnippet can run any ABAP, so this was always possible - by writing the
 * snippet by hand every time: a variable per parameter with the right type,
 * the direction of the blocks the right way round, sy-subrc turned back into
 * the name of an exception, and the results printed in some shape that can be
 * read again. That is a page of ABAP to answer "what does this module return
 * for these inputs", and every line of it is derivable from the signature.
 *
 * So the signature is read (getFunctionModule for a module, the class source
 * for a method), the snippet is generated from it, and the answer comes back
 * as data: values by parameter name, the exception by name, the row counts.
 *
 * Both tools execute code on the system as the connected user, which makes
 * them writing tools whatever they are pointed at. What they do not do is
 * keep the result: the generated code ends in ROLLBACK WORK unless the caller
 * asks for a commit.
 */
export class CallHandlers extends BaseHandler {
  private readonly snippets: SnippetHandlers;
  private readonly functions: FunctionModuleHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.snippets = new SnippetHandlers(client);
    this.functions = new FunctionModuleHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'callFunction',
        description: 'Call a function module with values and get what it returned, as data. Takes the module name alone - the function group is looked up - reads its signature, generates the call and runs it through a throwaway class in $TMP. The answer carries the exporting, changing and tables parameters by name, sy-subrc turned back into the name of the classic exception it stood for, a class-based exception with its text, and the true row count of every table. Values are checked against the signature before anything is sent: an unknown parameter name and a missing mandatory one are refused with the list of what the module takes. IMPORTANT: this executes the module on the target system as the connected user. Nothing it changed is kept - the call is followed by ROLLBACK WORK - unless commit is set, and a module that commits internally cannot be taken back at all. It counts as a writing tool and is refused in read-only mode.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Function module, e.g. Z_APP_GET_INVOICE. The group is found by search.'
            },
            values: {
              type: 'object',
              description: 'Values by parameter name: {"IV_LGNUM": "101", "IT_ITEMS": [{"MATNR": "4711"}]}. A structure is an object, a table an array; a scalar can be a string, a number or a boolean. Only importing, changing and tables parameters can be supplied.'
            },
            functionGroup: {
              type: 'string',
              description: 'The group, when the search does not find the module.'
            },
            commit: {
              type: 'boolean',
              description: 'Keep what the call did: COMMIT WORK AND WAIT instead of ROLLBACK WORK. Default false. Ask before setting this on a module that posts.'
            },
            maxRows: {
              type: 'number',
              description: 'Rows of each table kept in the answer, default 20. The true count is reported either way.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Return the generated class source without touching the system - the way to see what would run.'
            },
            snippetClass: {
              type: 'string',
              description: 'Name for the throwaway class. Default ZMCP_CALL_<timestamp in base 36>.'
            },
            keepClass: {
              type: 'boolean',
              description: 'Leave the generated class on the system instead of deleting it. Default false.'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'callMethod',
        description: 'Call a static method of a class with values and get what it returned, as data. The signature is read from the class source, because classComponents lists methods without their parameters. Returns the returning parameter, the exporting and changing ones by name, and any exception with its text. Static methods only: an instance method needs a constructor call, and runSnippet is the way to do that. IMPORTANT: this executes the method on the target system as the connected user. Nothing it changed is kept - the call is followed by ROLLBACK WORK - unless commit is set. It counts as a writing tool and is refused in read-only mode.',
        inputSchema: {
          type: 'object',
          properties: {
            className: {
              type: 'string',
              description: 'Class holding the method, e.g. ZCL_APP.'
            },
            methodName: {
              type: 'string',
              description: 'Static method to call, e.g. GET_STAWN.'
            },
            values: {
              type: 'object',
              description: 'Values by parameter name, same shapes as callFunction takes. Only importing and changing parameters can be supplied.'
            },
            commit: {
              type: 'boolean',
              description: 'Keep what the call did: COMMIT WORK AND WAIT instead of ROLLBACK WORK. Default false.'
            },
            maxRows: {
              type: 'number',
              description: 'Rows of each table kept in the answer, default 20.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Return the generated class source without touching the system.'
            },
            snippetClass: {
              type: 'string',
              description: 'Name for the throwaway class. Default ZMCP_CALL_<timestamp in base 36>.'
            },
            keepClass: {
              type: 'boolean',
              description: 'Leave the generated class on the system instead of deleting it. Default false.'
            }
          },
          required: ['className', 'methodName']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'callFunction':
        return this.handleCallFunction(args);
      case 'callMethod':
        return this.handleCallMethod(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown call tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  /** The values as an object, however the client passed them. */
  private values(args: any): Record<string, unknown> {
    const raw = args?.values;
    if (raw === undefined || raw === null || raw === '') return {};
    const parsed = this.parseObjectArg<Record<string, unknown>>(raw, 'values');
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new McpError(ErrorCode.InvalidParams, 'values must be an object keyed by parameter name.');
    }
    return parsed;
  }

  /**
   * The types the interface asked for that a variable cannot have.
   *
   * Worth saying out loud rather than hiding: a CLIKE parameter was passed as
   * a string, so a module whose behaviour depends on the length of the field
   * it was given - the ALPHA conversions do - may answer differently than it
   * would from typed code.
   */
  private substitutionReport(generated: GeneratedCall): Record<string, unknown> {
    if (!generated.substitutions) return {};
    return {
      typeSubstitutions: generated.substitutions,
      substitutionHint: 'The interface types these parameters generically, and a variable cannot be declared that way, so a concrete type was used. A module whose result depends on the length of the field it was handed may answer differently than it would from typed code.'
    };
  }

  private generate(build: () => GeneratedCall): GeneratedCall {
    try {
      return build();
    } catch (error: any) {
      // A signature mismatch is the caller's mistake, and its message names
      // what to change - it must not arrive as an internal error.
      if (error instanceof CallGenError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }
  }

  /**
   * Run the generated snippet and read its payload back.
   *
   * runSnippet already carries the whole cycle - create, activate, run,
   * delete, and the dump summary when the run died - so what is left here is
   * turning its console output back into values.
   */
  private async execute(
    generated: GeneratedCall,
    args: any,
    called: Record<string, unknown>
  ): Promise<any> {
    const className = String(args?.snippetClass || '').trim().toUpperCase() || snippetClassName('ZMCP_CALL');

    if (args?.dryRun === true) {
      return this.answer({
        status: 'success',
        dryRun: true,
        ...called,
        rolledBack: generated.rolledBack,
        supplied: generated.supplied,
        returns: generated.results,
        ...this.substitutionReport(generated),
        source: buildSnippetClass({
          className,
          code: generated.code,
          declarations: generated.declarations
        })
      });
    }

    const result = await this.snippets.handleRunSnippet({
      code: generated.code,
      declarations: generated.declarations,
      className,
      keepClass: args?.keepClass === true
    });
    const run = JSON.parse(result.content[0].text);

    if (run.ran !== true) {
      // The common failure is a value that does not fit the parameter it was
      // written into, and the activation messages name the line - so the
      // generated source goes with them.
      return this.answer({
        status: 'error',
        ...called,
        ran: false,
        supplied: generated.supplied,
        steps: run.steps,
        ...(run.runError ? { runError: run.runError } : {}),
        source: run.source || buildSnippetClass({
          className,
          code: generated.code,
          declarations: generated.declarations
        }),
        hint: (run.steps || []).some((step: any) => step?.activationMessages)
          ? 'The generated call did not compile. The activation messages name the line: usually a value written into a parameter it does not fit, or a component name the structure does not have.'
          : 'The call did not run to the end. What it managed to do was rolled back only if it got that far.'
      });
    }

    const xml = decodeResultPayload(String(run.output || ''));
    if (!xml) {
      return this.answer({
        status: 'error',
        ...called,
        ran: true,
        supplied: generated.supplied,
        output: run.output,
        steps: run.steps,
        hint: 'The call ran but printed no result payload. Anything the called code wrote to the console itself is in output above.'
      });
    }

    let outcome;
    try {
      outcome = interpretCall(parseAsXmlValues(xml), generated);
    } catch (error: any) {
      if (error instanceof AsXmlError) {
        return this.answer({
          status: 'error',
          ...called,
          ran: true,
          output: run.output,
          error: error.message,
          hint: 'The result payload arrived damaged. Raise maxRows only if it was cut short; otherwise the console formatted it in a way this cannot read.'
        });
      }
      throw error;
    }

    const failed = outcome.subrc !== 0 || !!outcome.exceptionClass;
    return this.answer({
      status: failed ? 'error' : 'success',
      ...called,
      ran: true,
      rolledBack: generated.rolledBack,
      supplied: generated.supplied,
      ...this.substitutionReport(generated),
      subrc: outcome.subrc,
      ...(outcome.exceptionRaised ? { exceptionRaised: outcome.exceptionRaised } : {}),
      ...(outcome.exceptionClass ? { exceptionClass: outcome.exceptionClass } : {}),
      ...(outcome.message ? { message: outcome.message } : {}),
      values: outcome.values,
      ...(outcome.rows ? { rows: outcome.rows } : {}),
      ...(outcome.truncated
        ? {
          truncated: outcome.truncated,
          truncationHint: `Only the first ${generated.maxRows} rows of ${outcome.truncated.join(', ')} are in the answer; rows says how many there are. Raise maxRows for more.`
        }
        : {}),
      steps: run.steps,
      ...(generated.rolledBack
        ? {}
        : { commitHint: 'This call was committed: what it changed stands.' })
    });
  }

  async handleCallFunction(args: any): Promise<any> {
    const name = String(args?.name || '').trim().toUpperCase();
    if (!name) throw new McpError(ErrorCode.InvalidParams, 'Pass name - the function module to call.');
    const values = this.values(args);

    // The signature comes from the tool that already knows how to find a
    // module without being told its group.
    const read = await this.functions.handleGetFunctionModule({
      name,
      ...(args?.functionGroup ? { functionGroup: args.functionGroup } : {})
    });
    const module = JSON.parse(read.content[0].text);

    const generated = this.generate(() => buildFunctionCall(
      { ...module.signature, name },
      values,
      { rollback: args?.commit !== true, maxRows: args?.maxRows }
    ));

    return this.execute(generated, args, {
      called: name,
      functionGroup: module.functionGroup
    });
  }

  async handleCallMethod(args: any): Promise<any> {
    const className = String(args?.className || '').trim().toUpperCase();
    const methodName = String(args?.methodName || '').trim().toUpperCase();
    if (!className || !methodName) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass className and methodName - the static method to call.');
    }
    const values = this.values(args);

    const sourceUrl = `/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}/source/main`;
    let source: string;
    const startTime = performance.now();
    try {
      // On the stateful client rather than the clone: this is a writing tool,
      // and a writing tool that reads through a second session is how a lock
      // ends up in the wrong one. It is a single read before a cycle that is
      // stateful anyway.
      source = await this.adtclient.getObjectSource(sourceUrl, { version: 'active' } as any);
      this.trackRequest(startTime, true);
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, `Failed to read class ${className}`);
    }

    let signature;
    try {
      signature = parseMethodSignature(source, methodName);
    } catch (error: any) {
      if (error instanceof MethodSignatureError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }

    // A redefinition needs no case of its own: ABAP has no static
    // redefinition, so every one of them is caught as an instance method.
    if (!signature.isStatic) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${className}=>${methodName} is an instance method, and callMethod calls static ones. ` +
        'Create the object and call it with runSnippet instead.'
      );
    }

    const generated = this.generate(() => buildMethodCall(
      { className, methodName },
      signature,
      values,
      { rollback: args?.commit !== true, maxRows: args?.maxRows }
    ));

    return this.execute(generated, args, {
      called: `${className}=>${methodName}`,
      ...(signature.visibility ? { visibility: signature.visibility } : {}),
      ...(signature.raising.length ? { raising: signature.raising } : {})
    });
  }
}
