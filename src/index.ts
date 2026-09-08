#!/usr/bin/env node

import { config } from 'dotenv';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { ADTClient, session_types } from "abap-adt-api";
import path from 'path';
import { AuthHandlers } from './handlers/AuthHandlers.js';
import { TransportHandlers } from './handlers/TransportHandlers.js';
import { ObjectHandlers } from './handlers/ObjectHandlers.js';
import { ClassHandlers } from './handlers/ClassHandlers.js';
import { CodeAnalysisHandlers } from './handlers/CodeAnalysisHandlers.js';
import { ObjectLockHandlers } from './handlers/ObjectLockHandlers.js';
import { ObjectSourceHandlers } from './handlers/ObjectSourceHandlers.js';
import { ObjectDeletionHandlers } from './handlers/ObjectDeletionHandlers.js';
import { ObjectManagementHandlers } from './handlers/ObjectManagementHandlers.js';
import { ObjectRegistrationHandlers } from './handlers/ObjectRegistrationHandlers.js';
import { NodeHandlers } from './handlers/NodeHandlers.js';
import { DiscoveryHandlers } from './handlers/DiscoveryHandlers.js';
import { UnitTestHandlers } from './handlers/UnitTestHandlers.js';
import { PrettyPrinterHandlers } from './handlers/PrettyPrinterHandlers.js';
import { GitHandlers } from './handlers/GitHandlers.js';
import { DdicHandlers } from './handlers/DdicHandlers.js';
import { ServiceBindingHandlers } from './handlers/ServiceBindingHandlers.js';
import { QueryHandlers } from './handlers/QueryHandlers.js';
import { FeedHandlers } from './handlers/FeedHandlers.js';
import { DebugHandlers } from './handlers/DebugHandlers.js';
import { RenameHandlers } from './handlers/RenameHandlers.js';
import { AtcHandlers } from './handlers/AtcHandlers.js';
import { TraceHandlers } from './handlers/TraceHandlers.js';
import { RefactorHandlers } from './handlers/RefactorHandlers.js';
import { RevisionHandlers } from './handlers/RevisionHandlers.js';
import { AdtToolError, errorPayload, isSessionFailure } from './lib/adtError';
import { isMutatingTool, isReplayable } from './lib/toolClasses';

config({ path: path.resolve(__dirname, '../.env') });

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private reloginPromise?: Promise<void>;
  private authHandlers: AuthHandlers;
  private transportHandlers: TransportHandlers;
  private objectHandlers: ObjectHandlers;
  private classHandlers: ClassHandlers;
  private codeAnalysisHandlers: CodeAnalysisHandlers;
  private objectLockHandlers: ObjectLockHandlers;
  private objectSourceHandlers: ObjectSourceHandlers;
  private objectDeletionHandlers: ObjectDeletionHandlers;
  private objectManagementHandlers: ObjectManagementHandlers;
  private objectRegistrationHandlers: ObjectRegistrationHandlers;
    private nodeHandlers: NodeHandlers;
    private discoveryHandlers: DiscoveryHandlers;
    private unitTestHandlers: UnitTestHandlers;
    private prettyPrinterHandlers: PrettyPrinterHandlers;
    private gitHandlers: GitHandlers;
    private ddicHandlers: DdicHandlers;
    private serviceBindingHandlers: ServiceBindingHandlers;
    private queryHandlers: QueryHandlers;
    private feedHandlers: FeedHandlers;
    private debugHandlers: DebugHandlers;
    private renameHandlers: RenameHandlers;
    private atcHandlers: AtcHandlers;
    private traceHandlers: TraceHandlers;
    private refactorHandlers: RefactorHandlers;
    private revisionHandlers: RevisionHandlers;

    constructor() {
    super(
      {
        name: "mcp-abap-abap-adt-api",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    const missingVars = ['SAP_URL', 'SAP_USER', 'SAP_PASSWORD'].filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    this.adtClient = new ADTClient(
      process.env.SAP_URL as string,
      process.env.SAP_USER as string,
      process.env.SAP_PASSWORD as string,
      process.env.SAP_CLIENT as string,
      process.env.SAP_LANGUAGE as string
    );
    this.adtClient.stateful = session_types.stateful
    
    // Initialize handlers
    this.authHandlers = new AuthHandlers(this.adtClient);
    this.transportHandlers = new TransportHandlers(this.adtClient);
    this.objectHandlers = new ObjectHandlers(this.adtClient);
    this.classHandlers = new ClassHandlers(this.adtClient);
    this.codeAnalysisHandlers = new CodeAnalysisHandlers(this.adtClient);
    this.objectLockHandlers = new ObjectLockHandlers(this.adtClient);
    this.objectSourceHandlers = new ObjectSourceHandlers(this.adtClient);
    this.objectDeletionHandlers = new ObjectDeletionHandlers(this.adtClient);
    this.objectManagementHandlers = new ObjectManagementHandlers(this.adtClient);
    this.objectRegistrationHandlers = new ObjectRegistrationHandlers(this.adtClient);
    this.nodeHandlers = new NodeHandlers(this.adtClient);
    this.discoveryHandlers = new DiscoveryHandlers(this.adtClient);
    this.unitTestHandlers = new UnitTestHandlers(this.adtClient);
    this.prettyPrinterHandlers = new PrettyPrinterHandlers(this.adtClient);
    this.gitHandlers = new GitHandlers(this.adtClient);
    this.ddicHandlers = new DdicHandlers(this.adtClient);
    this.serviceBindingHandlers = new ServiceBindingHandlers(this.adtClient);
    this.queryHandlers = new QueryHandlers(this.adtClient);
    this.feedHandlers = new FeedHandlers(this.adtClient);
    this.debugHandlers = new DebugHandlers(this.adtClient);
    this.renameHandlers = new RenameHandlers(this.adtClient);
    this.atcHandlers = new AtcHandlers(this.adtClient);
    this.traceHandlers = new TraceHandlers(this.adtClient);
    this.refactorHandlers = new RefactorHandlers(this.adtClient);
    this.revisionHandlers = new RevisionHandlers(this.adtClient);


        // Setup tool handlers
    this.setupToolHandlers();
  }

  private serializeResult(result: any) {
    try {
      // Handlers already return a well-formed MCP tool result
      // ({ content: [...] }). Re-wrapping it would double-serialize the payload
      // (every quote in the data gets escaped again), needlessly inflating large
      // responses such as object source (issue #4). Pass those through as-is and
      // only wrap raw values (e.g. the healthcheck object).
      if (result && Array.isArray(result.content)) {
        return result;
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          )
        }]
      };
    } catch (error) {
      return this.handleError(new McpError(
        ErrorCode.InternalError,
        'Failed to serialize result'
      ));
    }
  }

  private handleError(error: unknown, extra?: Record<string, unknown>) {
    // Keep SAP's own diagnosis: an AdtToolError carries status, exception type,
    // T100 key and localizedMessage, all of which used to be flattened into
    // 'Internal server error' or an axios message.
    if (error instanceof AdtToolError) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...errorPayload(error), code: error.code, ...extra })
        }],
        isError: true
      };
    }
    if (error instanceof McpError) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            code: error.code,
            ...extra
          })
        }],
        isError: true
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...errorPayload(error),
          code: ErrorCode.InternalError,
          ...extra
        })
      }],
      isError: true
    };
  }

  private setupToolHandlers() {
    this.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          ...this.authHandlers.getTools(),
          ...this.transportHandlers.getTools(),
          ...this.objectHandlers.getTools(),
          ...this.classHandlers.getTools(),
          ...this.codeAnalysisHandlers.getTools(),
          ...this.objectLockHandlers.getTools(),
          ...this.objectSourceHandlers.getTools(),
          ...this.objectDeletionHandlers.getTools(),
          ...this.objectManagementHandlers.getTools(),
          ...this.objectRegistrationHandlers.getTools(),
            ...this.nodeHandlers.getTools(),
            ...this.discoveryHandlers.getTools(),
            ...this.unitTestHandlers.getTools(),
            ...this.prettyPrinterHandlers.getTools(),
            ...this.gitHandlers.getTools(),
            ...this.ddicHandlers.getTools(),
            ...this.serviceBindingHandlers.getTools(),
            ...this.queryHandlers.getTools(),
            ...this.feedHandlers.getTools(),
            ...this.debugHandlers.getTools(),
            ...this.renameHandlers.getTools(),
            ...this.atcHandlers.getTools(),
            ...this.traceHandlers.getTools(),
            ...this.refactorHandlers.getTools(),
            ...this.revisionHandlers.getTools(),
            {
            name: 'healthcheck',
            description: 'Check ADT connectivity. Calls the backend and reports which SAP system this server talks to (url, client, language, user), the session state and the round-trip latency; on failure it reports whether the session is dead.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      };
    });

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;
      try {
        return this.serializeResult(await this.dispatch(toolName, args));
      } catch (error) {
        return this.recoverOrFail(toolName, args, error);
      }
    });
  }

  /** Route one tool call to its handler. */
  private async dispatch(toolName: string, args: any): Promise<any> {
    let result: any;
    switch (toolName) {
            case 'login':
            case 'logout':
            case 'dropSession':
                result = await this.authHandlers.handle(toolName, args);
                break;
            case 'transportInfo':
            case 'createTransport':
            case 'hasTransportConfig':
            case 'transportConfigurations':
            case 'getTransportConfiguration':
            case 'setTransportsConfig':
            case 'createTransportsConfig':
            case 'userTransports':
            case 'transportsByConfig':
            case 'transportDelete':
            case 'transportRelease':
            case 'transportSetOwner':
            case 'transportAddUser':
            case 'systemUsers':
            case 'transportReference':
                result = await this.transportHandlers.handle(toolName, args);
                break;
            case 'lock':
            case 'unLock':
                result = await this.objectLockHandlers.handle(toolName, args);
                break;
            case 'objectStructure':
            case 'searchObject':
            case 'findObjectPath':
            case 'objectTypes':
            case 'reentranceTicket':
                result = await this.objectHandlers.handle(toolName, args);
                break;
            case 'classIncludes':
            case 'classComponents':
                result = await this.classHandlers.handle(toolName, args);
                break;
            case 'syntaxCheckCode':
            case 'syntaxCheckCdsUrl':
            case 'codeCompletion':
            case 'findDefinition':
            case 'usageReferences':
            case 'syntaxCheckTypes':
            case 'codeCompletionFull':
            case 'runClass':
            case 'codeCompletionElement':
            case 'usageReferenceSnippets':
            case 'fixProposals':
            case 'fixEdits':
            case 'fragmentMappings':
            case 'abapDocumentation':
                result = await this.codeAnalysisHandlers.handle(toolName, args);
                break;
            case 'getObjectSource':
            case 'setObjectSource':
                result = await this.objectSourceHandlers.handle(toolName, args);
                break;
            case 'deleteObject':
                result = await this.objectDeletionHandlers.handle(toolName, args);
                break;
            case 'activateObjects':
            case 'activateByName':
            case 'inactiveObjects':
                result = await this.objectManagementHandlers.handle(toolName, args);
                break;
            case 'objectRegistrationInfo':
            case 'validateNewObject':
            case 'createObject':
                result = await this.objectRegistrationHandlers.handle(toolName, args);
                break;
            case 'nodeContents':
            case 'mainPrograms':
                result = await this.nodeHandlers.handle(toolName, args);
                break;
            case 'featureDetails':
            case 'collectionFeatureDetails':
            case 'findCollectionByUrl':
            case 'loadTypes':
            case 'adtDiscovery':
            case 'adtCoreDiscovery':
            case 'adtCompatibiliyGraph':
                result = await this.discoveryHandlers.handle(toolName, args);
                break;
            case 'unitTestRun':
            case 'unitTestEvaluation':
            case 'unitTestOccurrenceMarkers':
            case 'createTestInclude':
                result = await this.unitTestHandlers.handle(toolName, args);
                break;
            case 'prettyPrinterSetting':
            case 'setPrettyPrinterSetting':
            case 'prettyPrinter':
                result = await this.prettyPrinterHandlers.handle(toolName, args);
                break;
            case 'gitRepos':
            case 'gitExternalRepoInfo':
            case 'gitCreateRepo':
            case 'gitPullRepo':
            case 'gitUnlinkRepo':
            case 'stageRepo':
            case 'pushRepo':
            case 'checkRepo':
            case 'remoteRepoInfo':
            case 'switchRepoBranch':
                result = await this.gitHandlers.handle(toolName, args);
                break;
            case 'annotationDefinitions':
            case 'ddicElement':
            case 'ddicRepositoryAccess':
            case 'packageSearchHelp':
                result = await this.ddicHandlers.handle(toolName, args);
                break;
            case 'publishServiceBinding':
            case 'unPublishServiceBinding':
            case 'bindingDetails':
                result = await this.serviceBindingHandlers.handle(toolName, args);
                break;
            case 'tableContents':
            case 'runQuery':
                result = await this.queryHandlers.handle(toolName, args);
                break;
            case 'feeds':
            case 'dumps':
                result = await this.feedHandlers.handle(toolName, args);
                break;
            case 'debuggerListeners':
            case 'debuggerListen':
            case 'debuggerDeleteListener':
            case 'debuggerSetBreakpoints':
            case 'debuggerDeleteBreakpoints':
            case 'debuggerAttach':
            case 'debuggerSaveSettings':
            case 'debuggerStackTrace':
            case 'debuggerVariables':
            case 'debuggerChildVariables':
            case 'debuggerStep':
            case 'debuggerGoToStack':
            case 'debuggerSetVariableValue':
                result = await this.debugHandlers.handle(toolName, args);
                break;
            case 'renameEvaluate':
            case 'renamePreview':
            case 'renameExecute':
                result = await this.renameHandlers.handle(toolName, args);
                break;
            case 'atcCustomizing':
            case 'atcCheckVariant':
            case 'createAtcRun':
            case 'atcWorklists':
            case 'atcUsers':
            case 'atcExemptProposal':
            case 'atcRequestExemption':
            case 'isProposalMessage':
            case 'atcContactUri':
            case 'atcChangeContact':
                result = await this.atcHandlers.handle(toolName, args);
                break;
            case 'tracesList':
            case 'tracesListRequests':
            case 'tracesHitList':
            case 'tracesDbAccess':
            case 'tracesStatements':
            case 'tracesSetParameters':
            case 'tracesCreateConfiguration':
            case 'tracesDeleteConfiguration':
            case 'tracesDelete':
                result = await this.traceHandlers.handle(toolName, args);
                break;
            case 'extractMethodEvaluate':
            case 'extractMethodPreview':
            case 'extractMethodExecute':
                result = await this.refactorHandlers.handle(toolName, args);
                break;
            case 'revisions':
                result = await this.revisionHandlers.handle(toolName, args);
                break;
            case 'healthcheck':
                result = await this.healthcheck();
                break;
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }

    return result;
  }

  /**
   * Report what this server is actually connected to and whether ADT answers.
   *
   * The old implementation returned a constant 'healthy', so it kept claiming
   * health while every call failed on a dead session - and it never said which
   * SAP system this process talks to, which matters when several instances of
   * this server run side by side against different systems.
   */
  private async healthcheck() {
    const system = {
      url: this.adtClient.baseUrl,
      client: this.adtClient.client || undefined,
      language: this.adtClient.language || undefined,
      user: this.adtClient.username
    };
    const session = {
      loggedin: this.adtClient.loggedin,
      stateful: this.adtClient.isStateful,
      // The token and the cookies themselves stay out of the payload.
      csrfToken: this.adtClient.csrfToken ? 'present' : 'missing'
    };

    const startTime = performance.now();
    try {
      const discovery = await this.adtClient.adtCoreDiscovery();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        system,
        session: { ...session, loggedin: this.adtClient.loggedin },
        adt: {
          reachable: true,
          latencyMs: Math.round(performance.now() - startTime),
          collections: Array.isArray(discovery) ? discovery.length : undefined
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        system,
        session,
        adt: {
          reachable: false,
          latencyMs: Math.round(performance.now() - startTime)
        },
        ...errorPayload(error),
        sessionFailure: isSessionFailure(error),
        hint: isSessionFailure(error)
          ? 'The ADT session looks dead. Call login, or just retry - a read-only call recovers the session by itself.'
          : 'ADT did not answer. Check the URL, the network route and the credentials.'
      };
    }
  }

  /**
   * Re-authenticate at most once, even if several calls fail at the same time.
   */
  private async relogin(): Promise<void> {
    if (!this.reloginPromise) {
      const done = () => { this.reloginPromise = undefined; };
      this.reloginPromise = this.adtClient.login().then(done, (e: unknown) => { done(); throw e; });
    }
    return this.reloginPromise;
  }

  /**
   * The ADT session dies periodically, and abap-adt-api deliberately does not
   * recover it while the client is stateful (AdtHTTP.request guards its retry
   * with !this.isStateful). Every later call then fails with an undiagnosed
   * 400 until someone calls login by hand. Detect that shape and recover.
   *
   * A read-only call is replayed once; a writing call is not, because its lock
   * handle died with the old session and the write may already have landed.
   * Those get the recovered session plus an explicit warning.
   */
  private async recoverOrFail(toolName: string, args: any, error: unknown) {
    if (!isSessionFailure(error)) {
      return this.handleError(error);
    }
    console.error(`[session] ${toolName} failed with a dead ADT session, re-authenticating`);
    try {
      await this.relogin();
    } catch (loginError) {
      return this.handleError(error, {
        sessionRecovered: false,
        hint: 'Re-authentication failed. Check connectivity and credentials, then call login.'
      });
    }
    if (!isReplayable(toolName)) {
      return this.handleError(error, {
        sessionRecovered: true,
        locksLost: isMutatingTool(toolName),
        hint: isMutatingTool(toolName)
          ? 'The session was re-established but this call was NOT repeated - it may have taken effect and its lock handle is void. Re-lock the object and retry.'
          : 'The session was re-established; retry the call.'
      });
    }
    try {
      const retried = this.serializeResult(await this.dispatch(toolName, args));
      return this.annotate(retried, { sessionRecovered: true });
    } catch (retryError) {
      return this.handleError(retryError, { sessionRecovered: true });
    }
  }

  /**
   * Merge extra fields into a handler result so a recovered session is visible
   * to the caller instead of being silently papered over.
   */
  private annotate(result: any, extra: Record<string, unknown>) {
    const item = result?.content?.[0];
    if (item?.type !== 'text' || typeof item.text !== 'string') return result;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
      item.text = JSON.stringify({ ...parsed, ...extra });
    } catch {
      // not a JSON payload - leave it untouched
    }
    return result;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    console.error('MCP ABAP ADT API server running on stdio');
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      await this.close();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      await this.close();
      process.exit(0);
    });
    
    // Handle errors
    this.onerror = (error) => {
      console.error('[MCP Error]', error);
    };
  }
}

// Create and run server instance
const server = new AbapAdtServer();
server.run().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
