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
import { SourceSearchHandlers } from './handlers/SourceSearchHandlers.js';
import { ObjectDeletionHandlers } from './handlers/ObjectDeletionHandlers.js';
import { ObjectManagementHandlers } from './handlers/ObjectManagementHandlers.js';
import { ObjectRegistrationHandlers } from './handlers/ObjectRegistrationHandlers.js';
import { NodeHandlers } from './handlers/NodeHandlers.js';
import { DiscoveryHandlers } from './handlers/DiscoveryHandlers.js';
import { UnitTestHandlers } from './handlers/UnitTestHandlers.js';
import { PrettyPrinterHandlers } from './handlers/PrettyPrinterHandlers.js';
import { GitHandlers } from './handlers/GitHandlers.js';
import { DdicHandlers } from './handlers/DdicHandlers.js';
import { DdicPropertyHandlers } from './handlers/DdicPropertyHandlers.js';
import { EnhancementHandlers } from './handlers/EnhancementHandlers.js';
import { TextElementHandlers } from './handlers/TextElementHandlers.js';
import { MessageClassHandlers } from './handlers/MessageClassHandlers.js';
import { DdicStructureHandlers } from './handlers/DdicStructureHandlers.js';
import { PackageHandlers } from './handlers/PackageHandlers.js';
import { RapHandlers } from './handlers/RapHandlers.js';
import { ServiceBindingHandlers } from './handlers/ServiceBindingHandlers.js';
import { QueryHandlers } from './handlers/QueryHandlers.js';
import { FeedHandlers } from './handlers/FeedHandlers.js';
import { DebugHandlers } from './handlers/DebugHandlers.js';
import { RenameHandlers } from './handlers/RenameHandlers.js';
import { AtcHandlers } from './handlers/AtcHandlers.js';
import { TraceHandlers } from './handlers/TraceHandlers.js';
import { RefactorHandlers } from './handlers/RefactorHandlers.js';
import { RevisionHandlers } from './handlers/RevisionHandlers.js';
import { ClassMemberHandlers } from './handlers/ClassMemberHandlers.js';
import { ImpactHandlers } from './handlers/ImpactHandlers.js';
import { FunctionModuleHandlers } from './handlers/FunctionModuleHandlers.js';
import { SnippetHandlers } from './handlers/SnippetHandlers.js';
import { CallHandlers } from './handlers/CallHandlers.js';
import { TableHandlers } from './handlers/TableHandlers.js';
import { AdtToolError, errorPayload, describeAdtError, isSessionFailure } from './lib/adtError';
import { isMutatingTool, isReplayable } from './lib/toolClasses';
import { isReadOnly, excludedTokens, readOnlyAllowances, maxResponseChars } from './lib/serverConfig';
import { refusalFor, annotationsFor } from './lib/toolFilter';
import type { ToolProfile } from './lib/toolFilter';
import { metrics } from './lib/metrics';
import { lockRegistry } from './lib/lockRegistry';
import type { ToolDefinition } from './types/tools.js';

/**
 * Which connection variables the client actually passed, captured before
 * dotenv fills the rest in from the .env file next to the server.
 *
 * That fallback is a trap when several instances of this server run against
 * different systems: a typo in one client entry would silently connect to
 * whatever system .env points at, so the server says out loud where its
 * settings came from.
 */
const CLIENT_PROVIDED = new Set(
  ['SAP_URL', 'SAP_USER', 'SAP_PASSWORD', 'SAP_CLIENT', 'SAP_LANGUAGE']
    .filter(name => process.env[name] !== undefined)
);

config({ path: path.resolve(__dirname, '../.env') });

const HEALTHCHECK_TOOL: ToolDefinition = {
  name: 'healthcheck',
  description: 'Check ADT connectivity. Calls the backend and reports which SAP system this server talks to (url, client, language, user), the session state, the active tool profile and the round-trip latency; on failure it reports whether the session is dead.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private reloginPromise?: Promise<void>;
  private toolGroupIndex?: Map<string, string>;
  private authHandlers: AuthHandlers;
  private transportHandlers: TransportHandlers;
  private objectHandlers: ObjectHandlers;
  private classHandlers: ClassHandlers;
  private codeAnalysisHandlers: CodeAnalysisHandlers;
  private objectLockHandlers: ObjectLockHandlers;
  private objectSourceHandlers: ObjectSourceHandlers;
  private sourceSearchHandlers: SourceSearchHandlers;
  private objectDeletionHandlers: ObjectDeletionHandlers;
  private objectManagementHandlers: ObjectManagementHandlers;
  private objectRegistrationHandlers: ObjectRegistrationHandlers;
    private nodeHandlers: NodeHandlers;
    private discoveryHandlers: DiscoveryHandlers;
    private unitTestHandlers: UnitTestHandlers;
    private prettyPrinterHandlers: PrettyPrinterHandlers;
    private gitHandlers: GitHandlers;
    private ddicHandlers: DdicHandlers;
    private ddicPropertyHandlers: DdicPropertyHandlers;
    private enhancementHandlers: EnhancementHandlers;
    private textElementHandlers: TextElementHandlers;
    private messageClassHandlers: MessageClassHandlers;
    private ddicStructureHandlers: DdicStructureHandlers;
    private packageHandlers: PackageHandlers;
    private rapHandlers: RapHandlers;
    private serviceBindingHandlers: ServiceBindingHandlers;
    private queryHandlers: QueryHandlers;
    private feedHandlers: FeedHandlers;
    private debugHandlers: DebugHandlers;
    private renameHandlers: RenameHandlers;
    private atcHandlers: AtcHandlers;
    private traceHandlers: TraceHandlers;
    private refactorHandlers: RefactorHandlers;
    private revisionHandlers: RevisionHandlers;
    private classMemberHandlers: ClassMemberHandlers;
    private impactHandlers: ImpactHandlers;
    private functionModuleHandlers: FunctionModuleHandlers;
    private snippetHandlers: SnippetHandlers;
    private callHandlers: CallHandlers;
    private tableHandlers: TableHandlers;

    constructor() {
    super(
      {
        name: "mcp-abap-adt-api",
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
      throw new Error(
        `Missing required environment variables: ${missingVars.join(', ')}. ` +
        'Note the user variable is SAP_USER, not SAP_USERNAME.'
      );
    }

    this.adtClient = new ADTClient(
      process.env.SAP_URL as string,
      process.env.SAP_USER as string,
      process.env.SAP_PASSWORD as string,
      process.env.SAP_CLIENT as string,
      process.env.SAP_LANGUAGE as string
    );
    this.adtClient.stateful = session_types.stateful

    this.announceTarget();

    // Initialize handlers
    this.authHandlers = new AuthHandlers(this.adtClient);
    this.transportHandlers = new TransportHandlers(this.adtClient);
    this.objectHandlers = new ObjectHandlers(this.adtClient);
    this.classHandlers = new ClassHandlers(this.adtClient);
    this.codeAnalysisHandlers = new CodeAnalysisHandlers(this.adtClient);
    this.objectLockHandlers = new ObjectLockHandlers(this.adtClient);
    this.objectSourceHandlers = new ObjectSourceHandlers(this.adtClient);
    this.sourceSearchHandlers = new SourceSearchHandlers(this.adtClient);
    this.objectDeletionHandlers = new ObjectDeletionHandlers(this.adtClient);
    this.objectManagementHandlers = new ObjectManagementHandlers(this.adtClient);
    this.objectRegistrationHandlers = new ObjectRegistrationHandlers(this.adtClient);
    this.nodeHandlers = new NodeHandlers(this.adtClient);
    this.discoveryHandlers = new DiscoveryHandlers(this.adtClient);
    this.unitTestHandlers = new UnitTestHandlers(this.adtClient);
    this.prettyPrinterHandlers = new PrettyPrinterHandlers(this.adtClient);
    this.gitHandlers = new GitHandlers(this.adtClient);
    this.ddicHandlers = new DdicHandlers(this.adtClient);
    this.ddicPropertyHandlers = new DdicPropertyHandlers(this.adtClient);
    this.enhancementHandlers = new EnhancementHandlers(this.adtClient);
    this.textElementHandlers = new TextElementHandlers(this.adtClient);
    this.messageClassHandlers = new MessageClassHandlers(this.adtClient);
    this.ddicStructureHandlers = new DdicStructureHandlers(this.adtClient);
    this.packageHandlers = new PackageHandlers(this.adtClient);
    this.rapHandlers = new RapHandlers(this.adtClient);
    this.serviceBindingHandlers = new ServiceBindingHandlers(this.adtClient);
    this.queryHandlers = new QueryHandlers(this.adtClient);
    this.feedHandlers = new FeedHandlers(this.adtClient);
    this.debugHandlers = new DebugHandlers(this.adtClient);
    this.renameHandlers = new RenameHandlers(this.adtClient);
    this.atcHandlers = new AtcHandlers(this.adtClient);
    this.traceHandlers = new TraceHandlers(this.adtClient);
    this.refactorHandlers = new RefactorHandlers(this.adtClient);
    this.revisionHandlers = new RevisionHandlers(this.adtClient);
    this.classMemberHandlers = new ClassMemberHandlers(this.adtClient);
    this.impactHandlers = new ImpactHandlers(this.adtClient);
    this.functionModuleHandlers = new FunctionModuleHandlers(this.adtClient);
    this.snippetHandlers = new SnippetHandlers(this.adtClient);
    this.callHandlers = new CallHandlers(this.adtClient);
    this.tableHandlers = new TableHandlers(this.adtClient);


        // Setup tool handlers
    this.setupToolHandlers();
  }

  /** Where the settings came from, so a misdirected instance is obvious. */
  private configSource(): 'client environment' | '.env file' {
    return CLIENT_PROVIDED.has('SAP_URL') ? 'client environment' : '.env file';
  }

  /**
   * Say on startup which system this process talks to. With several instances
   * of this server connected to different systems, "which one am I" is the
   * question worth answering before anything else happens.
   */
  private announceTarget(): void {
    console.error(
      `[config] ${process.env.SAP_URL} client=${process.env.SAP_CLIENT || '-'} ` +
      `language=${process.env.SAP_LANGUAGE || '-'} user=${process.env.SAP_USER} ` +
      `(settings from ${this.configSource()})`
    );
    if (this.configSource() === '.env file') {
      console.error(
        '[config] WARNING: SAP_URL was not passed by the client, so it came from the .env ' +
        'file next to the server. Check that this is the system you meant.'
      );
    }
    if (isReadOnly()) {
      const allowed = [...readOnlyAllowances()];
      console.error(
        '[config] SAP_READONLY is set: tools that change the system are refused' +
        (allowed.length ? `, except: ${allowed.join(', ')}` : '')
      );
    }
    const excluded = [...excludedTokens()];
    if (excluded.length) {
      console.error(`[config] SAP_TOOLS_EXCLUDE hides: ${excluded.join(', ')}`);
    }
  }

  private serializeResult(result: any) {
    try {
      // Handlers already return a well-formed MCP tool result
      // ({ content: [...] }). Re-wrapping it would double-serialize the payload
      // (every quote in the data gets escaped again), needlessly inflating large
      // responses such as object source (issue #4). Pass those through as-is and
      // only wrap raw values (e.g. the healthcheck object).
      if (result && Array.isArray(result.content)) {
        return this.capSize(result);
      }
      return this.capSize({
        content: [{
          type: 'text',
          text: JSON.stringify(result, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          )
        }]
      });
    } catch (error) {
      return this.handleError(new McpError(
        ErrorCode.InternalError,
        'Failed to serialize result'
      ));
    }
  }

  /**
   * Refuse to hand back an answer that would swamp the caller.
   *
   * Some ADT answers are enormous - userTransports with targets has run
   * past 400k characters - and an oversized payload costs the caller its
   * context before it can even look at what came back. The reply is
   * replaced by a still-parseable envelope carrying the size, the limit and
   * a truncated preview, so it is obvious what happened and how to narrow
   * the request. Raise the ceiling with SAP_MAX_RESPONSE_CHARS.
   */
  private capSize(result: any) {
    const item = result?.content?.[0];
    if (item?.type !== 'text' || typeof item.text !== 'string') return result;
    const max = maxResponseChars();
    if (item.text.length <= max) return result;

    const chars = item.text.length;
    item.text = JSON.stringify({
      status: 'truncated',
      chars,
      maxChars: max,
      hint: 'The answer was too large to return. Narrow it: startLine/maxLines for source, rowNumber for queries, the filters on userTransports, or raise SAP_MAX_RESPONSE_CHARS.',
      preview: item.text.slice(0, Math.floor(max * 0.9))
    });
    return result;
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
      return { tools: this.exposedTools() };
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
    this.assertAllowed(toolName);
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
            case 'transportDetails':
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
            case 'listLocks':
            case 'unlockAll':
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
            case 'whereUsedMethod':
            case 'typeHierarchy':
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
            case 'patchObjectSource':
            case 'editObject':
                result = await this.objectSourceHandlers.handle(toolName, args);
                break;
            case 'findInSource':
            case 'sourceOutline':
                result = await this.sourceSearchHandlers.handle(toolName, args);
                break;
            case 'deleteObject':
                result = await this.objectDeletionHandlers.handle(toolName, args);
                break;
            case 'activateObjects':
            case 'activateByName':
            case 'inactiveObjects':
            case 'activateSafe':
                result = await this.objectManagementHandlers.handle(toolName, args);
                break;
            case 'createAndWrite':
            case 'objectRegistrationInfo':
            case 'validateNewObject':
            case 'createObject':
            case 'createInclude':
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
            case 'runTests':
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
            case 'objectEnhancements':
                result = await this.enhancementHandlers.handle(toolName, args);
                break;
            case 'getTextElements':
            case 'setTextElements':
                result = await this.textElementHandlers.handle(toolName, args);
                break;
            case 'getMessages':
            case 'getMessageLongtext':
            case 'setMessages':
            case 'createMessageClass':
                result = await this.messageClassHandlers.handle(toolName, args);
                break;
            case 'getStructureSource':
            case 'createStructure':
                result = await this.ddicStructureHandlers.handle(toolName, args);
                break;
            case 'packageTree':
            case 'readSources':
            case 'searchInPackage':
                result = await this.packageHandlers.handle(toolName, args);
                break;
            case 'rapGenIsAvailable':
                result = await this.rapHandlers.handle(toolName, args);
                break;
            case 'createDomain':
            case 'createDataElement':
            case 'getDomainProperties':
            case 'setDomainProperties':
            case 'getDataElementProperties':
            case 'setDataElementProperties':
                result = await this.ddicPropertyHandlers.handle(toolName, args);
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
            case 'atcCheck':
            case 'atcCustomizing':
            case 'atcCheckVariant':
            case 'createAtcRun':
            case 'atcWorklists':
            case 'atcUsers':
            case 'atcDocumentation':
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
            case 'changePackagePreview':
            case 'extractMethodEvaluate':
            case 'extractMethodPreview':
            case 'extractMethodExecute':
                result = await this.refactorHandlers.handle(toolName, args);
                break;
            case 'revisions':
            case 'compareRevisions':
                result = await this.revisionHandlers.handle(toolName, args);
                break;
            case 'runSnippet':
                result = await this.snippetHandlers.handle(toolName, args);
                break;
            case 'callFunction':
            case 'callMethod':
                result = await this.callHandlers.handle(toolName, args);
                break;
            case 'tableFields':
            case 'tableIndexes':
            case 'tableKeys':
                result = await this.tableHandlers.handle(toolName, args);
                break;
            case 'getFunctionModule':
            case 'listFunctionGroup':
            case 'createFunctionModule':
                result = await this.functionModuleHandlers.handle(toolName, args);
                break;
            case 'impactOf':
            case 'abapPath':
                result = await this.impactHandlers.handle(toolName, args);
                break;
            case 'addMethod':
            case 'deleteMethod':
            case 'addAttribute':
                result = await this.classMemberHandlers.handle(toolName, args);
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
   * Every tool this server can serve, tagged with the group that owns it.
   * The group names are what SAP_TOOLS_EXCLUDE accepts.
   */
  private toolGroups(): { group: string; tools: ToolDefinition[] }[] {
    return [
      { group: 'auth', tools: this.authHandlers.getTools() },
      { group: 'transport', tools: this.transportHandlers.getTools() },
      { group: 'object', tools: this.objectHandlers.getTools() },
      { group: 'class', tools: this.classHandlers.getTools() },
      { group: 'codeAnalysis', tools: this.codeAnalysisHandlers.getTools() },
      { group: 'lock', tools: this.objectLockHandlers.getTools() },
      { group: 'source', tools: this.objectSourceHandlers.getTools() },
      { group: 'source', tools: this.sourceSearchHandlers.getTools() },
      { group: 'deletion', tools: this.objectDeletionHandlers.getTools() },
      { group: 'activation', tools: this.objectManagementHandlers.getTools() },
      { group: 'registration', tools: this.objectRegistrationHandlers.getTools() },
      { group: 'node', tools: this.nodeHandlers.getTools() },
      { group: 'discovery', tools: this.discoveryHandlers.getTools() },
      { group: 'unitTest', tools: this.unitTestHandlers.getTools() },
      { group: 'prettyPrinter', tools: this.prettyPrinterHandlers.getTools() },
      { group: 'git', tools: this.gitHandlers.getTools() },
      { group: 'ddic', tools: this.ddicHandlers.getTools() },
      { group: 'ddic', tools: this.ddicPropertyHandlers.getTools() },
      { group: 'enhancement', tools: this.enhancementHandlers.getTools() },
      { group: 'textElement', tools: this.textElementHandlers.getTools() },
      { group: 'messageClass', tools: this.messageClassHandlers.getTools() },
      { group: 'ddic', tools: this.ddicStructureHandlers.getTools() },
      { group: 'package', tools: this.packageHandlers.getTools() },
      { group: 'rap', tools: this.rapHandlers.getTools() },
      { group: 'serviceBinding', tools: this.serviceBindingHandlers.getTools() },
      { group: 'query', tools: this.queryHandlers.getTools() },
      { group: 'feed', tools: this.feedHandlers.getTools() },
      { group: 'debugger', tools: this.debugHandlers.getTools() },
      { group: 'rename', tools: this.renameHandlers.getTools() },
      { group: 'atc', tools: this.atcHandlers.getTools() },
      { group: 'traces', tools: this.traceHandlers.getTools() },
      { group: 'refactor', tools: this.refactorHandlers.getTools() },
      { group: 'revision', tools: this.revisionHandlers.getTools() },
      { group: 'source', tools: this.classMemberHandlers.getTools() },
      { group: 'codeAnalysis', tools: this.impactHandlers.getTools() },
      { group: 'registration', tools: this.functionModuleHandlers.getTools() },
      { group: 'codeAnalysis', tools: this.snippetHandlers.getTools() },
      { group: 'codeAnalysis', tools: this.callHandlers.getTools() },
      { group: 'ddic', tools: this.tableHandlers.getTools() },
      { group: 'health', tools: [HEALTHCHECK_TOOL] }
    ];
  }

  /**
   * The tools actually offered to the client: everything minus what a
   * read-only system forbids and what SAP_TOOLS_EXCLUDE hides, each carrying
   * the annotations a client needs to judge how risky a call is.
   */
  private exposedTools(): ToolDefinition[] {
    const profile = this.profile();
    return this.toolGroups()
      .reduce<{ tool: ToolDefinition; group: string }[]>(
        (acc, g) => acc.concat(g.tools.map(tool => ({ tool, group: g.group }))),
        []
      )
      .filter(({ tool, group }) => !refusalFor(tool.name, group, profile, this.adtClient.baseUrl))
      .map(({ tool }) => ({
        ...tool,
        annotations: { ...tool.annotations, ...annotationsFor(tool.name) }
      }));
  }

  /** The active read-only / exclusion / allowance profile. */
  private profile(): ToolProfile {
    return {
      readOnly: isReadOnly(),
      excluded: excludedTokens(),
      allowed: readOnlyAllowances()
    };
  }

  /**
   * Second line of defence: a hidden tool must also be refused when called
   * directly, because a client may still hold an older tool list.
   */
  private assertAllowed(toolName: string): void {
    const refusal = refusalFor(
      toolName,
      this.groupOf(toolName),
      this.profile(),
      this.adtClient.baseUrl
    );
    if (refusal) {
      throw new McpError(ErrorCode.InvalidRequest, refusal.message);
    }
  }

  /** Which group serves a tool; built once from the registry. */
  private groupOf(toolName: string): string | undefined {
    if (!this.toolGroupIndex) {
      this.toolGroupIndex = new Map();
      for (const g of this.toolGroups()) {
        for (const t of g.tools) this.toolGroupIndex.set(t.name, g.group);
      }
    }
    return this.toolGroupIndex.get(toolName);
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
      user: this.adtClient.username,
      configuredBy: this.configSource()
    };
    const excluded = [...excludedTokens()];
    const allowed = [...readOnlyAllowances()];
    const profile = {
      readOnly: isReadOnly(),
      excluded: excluded.length ? excluded : undefined,
      readOnlyAllow: allowed.length ? allowed : undefined,
      toolsExposed: this.exposedTools().length
    };
    const session = {
      loggedin: this.adtClient.loggedin,
      stateful: this.adtClient.isStateful,
      // The token and the cookies themselves stay out of the payload.
      csrfToken: this.adtClient.csrfToken ? 'present' : 'missing',
      locksHeld: lockRegistry.count()
    };

    const startTime = performance.now();
    try {
      const discovery = await this.adtClient.adtCoreDiscovery();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        system,
        profile,
        metrics: metrics.snapshot(),
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
        profile,
        metrics: metrics.snapshot(),
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
      this.reloginPromise = this.adtClient.login().then(() => {
        // Handles from the previous session are void - drop them rather than
        // keeping entries that can only fail.
        if (lockRegistry.count() > 0) {
          console.error(`[session] dropping ${lockRegistry.count()} lock handle(s) invalidated by the re-login`);
          lockRegistry.clear();
        }
        done();
      }, (e: unknown) => { done(); throw e; });
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

  /**
   * Release whatever this process still holds before it goes away. A lock left
   * behind blocks the object for everyone else until the SAP session times out,
   * and nothing in the old shutdown path did anything about it.
   */
  private async releaseLocksOnShutdown(): Promise<void> {
    if (lockRegistry.count() === 0) return;
    console.error(`[locks] releasing ${lockRegistry.count()} lock(s) before shutdown`);
    try {
      await this.objectLockHandlers.handle('unlockAll', {});
    } catch (error) {
      console.error('[locks] releasing locks failed:', describeAdtError(error).error);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    console.error('MCP ABAP ADT API server running on stdio');
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      await this.releaseLocksOnShutdown();
      await this.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.releaseLocksOnShutdown();
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
