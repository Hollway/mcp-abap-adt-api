/**
 * Which tools a given profile exposes, and why one is refused.
 *
 * Kept out of index.ts so it can be tested: index.ts constructs and starts the
 * server as a side effect of being imported.
 */
import { isMutatingTool, isDestructiveTool } from './toolClasses';

export interface ToolProfile {
  readOnly: boolean;
  /** Groups or tool names hidden outright (SAP_TOOLS_EXCLUDE). */
  excluded: ReadonlySet<string>;
  /** Groups or tool names allowed through the read-only fence. */
  allowed: ReadonlySet<string>;
  /** Groups or tool names served to the exclusion of everything else; empty means everything. */
  included?: ReadonlySet<string>;
}

export interface RefusalReason {
  reason: 'readOnly' | 'excluded' | 'notIncluded';
  message: string;
}

/**
 * Ready-made sets of groups, for the common shapes of session.
 *
 * The whole tool list costs some 160,000 characters of context before any
 * work starts, and a session that reads code never calls the debugger, the
 * traces, ATC or git. These are the sets worth naming; anything else is a
 * SAP_TOOLS_INCLUDE list of groups, which is what these are made of.
 */
export const TOOL_PRESETS: Readonly<Record<string, readonly string[]>> = {
  /** Find an object, read it, walk its package. */
  min: ['health', 'auth', 'object', 'source', 'package'],
  /** Everything that only reads: the above plus the dictionary, history and analysis. */
  read: [
    'health', 'auth', 'object', 'source', 'package', 'node', 'discovery',
    'ddic', 'codeAnalysis', 'class', 'revision', 'query', 'feed', 'enhancement', 'textElement',
    'operations'
  ],
  /** Reading plus writing, activation, transports and tests - no debugger, traces, ATC, git or RAP. */
  dev: [
    'health', 'auth', 'object', 'source', 'package', 'node', 'discovery',
    'ddic', 'codeAnalysis', 'class', 'revision', 'query', 'feed', 'enhancement', 'textElement',
    'operations',
    'lock', 'activation', 'registration', 'deletion', 'transport', 'unitTest',
    'prettyPrinter', 'refactor', 'rename', 'messageClass'
  ],
  /** Dictionary work: tables, structures, data elements, domains, and the sources around them. */
  ddic: ['health', 'auth', 'ddic', 'object', 'source', 'package', 'node', 'revision'],
  /**
   * Understanding a system nobody documented: what calls what, what a change
   * would break, the shape of a package. Named tool by tool rather than by
   * group, because the analysis tools sit in codeAnalysis next to completion,
   * fixes and syntax checks, and the reading tools sit in source next to the
   * ones that write.
   */
  graph: [
    'health', 'auth',
    'searchObject', 'objectStructure', 'findObjectPath', 'objectTypes',
    'getObjectSource', 'findInSource', 'sourceOutline', 'readSources',
    'packageTree', 'searchInPackage', 'nodeContents', 'mainPrograms',
    'classComponents', 'classIncludes', 'listFunctionGroup',
    'usageReferences', 'whereUsedMethod', 'typeHierarchy', 'findDefinition',
    'impactOf', 'abapPath', 'callsFrom', 'abapGraph'
  ],
  /** Quality checks and what it takes to read one: the ATC group, plus enough navigation to reach the object. */
  atc: [
    'health', 'auth', 'atc',
    'searchObject', 'objectStructure', 'findObjectPath',
    'getObjectSource', 'findInSource', 'packageTree', 'searchInPackage'
  ]
};

/** The groups a preset name stands for; unknown names stand for nothing. */
export const presetGroups = (name: string): readonly string[] =>
  TOOL_PRESETS[String(name || '').trim().toLowerCase()] || [];

/** healthcheck is served whatever the include list says: it reads nothing but this server's own state. */
const ALWAYS_SERVED = new Set(['healthcheck']);

const named = (tool: string, group: string | undefined, tokens: ReadonlySet<string>): boolean =>
  tokens.has(tool) || (!!group && tokens.has(group));

/**
 * True when a mutating tool is let through anyway. Exclusion wins over an
 * allowance: hiding a group and allowing it at the same time is a
 * contradiction, and hiding is the safer reading.
 */
export const isAllowedDespiteReadOnly = (
  tool: string,
  group: string | undefined,
  profile: ToolProfile
): boolean => named(tool, group, profile.allowed) && !named(tool, group, profile.excluded);

/** Whether this tool is served at all, and why not when it is refused. */
export function refusalFor(
  tool: string,
  group: string | undefined,
  profile: ToolProfile,
  system: string
): RefusalReason | undefined {
  if (named(tool, group, profile.excluded)) {
    return {
      reason: 'excluded',
      message: `${tool}${group ? ` (group ${group})` : ''} is disabled by SAP_TOOLS_EXCLUDE on this server.`
    };
  }
  if (
    profile.included && profile.included.size > 0
    && !ALWAYS_SERVED.has(tool)
    && !named(tool, group, profile.included)
  ) {
    return {
      reason: 'notIncluded',
      message: `${tool}${group ? ` (group ${group})` : ''} is not in SAP_TOOLS_INCLUDE/SAP_TOOLS_PROFILE on this server, which serves: ${[...profile.included].sort().join(', ')}.`
    };
  }
  if (profile.readOnly && isMutatingTool(tool) && !isAllowedDespiteReadOnly(tool, group, profile)) {
    return {
      reason: 'readOnly',
      message: `${tool} changes the system, and this server runs with SAP_READONLY set for ${system}. ` +
        'Nothing was sent to SAP.'
    };
  }
  return undefined;
}

/** Annotations describing what a call to this tool does. */
export const annotationsFor = (tool: string) => ({
  readOnlyHint: !isMutatingTool(tool),
  destructiveHint: isDestructiveTool(tool)
});
