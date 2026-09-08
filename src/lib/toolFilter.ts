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
}

export interface RefusalReason {
  reason: 'readOnly' | 'excluded';
  message: string;
}

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
