/**
 * Classification of the tools this server exposes.
 *
 * Two consumers:
 *  - session recovery: a call that changed (or could change) the system must
 *    never be silently repeated after a re-login, because the lock handle it
 *    used died with the old session;
 *  - a future read-only mode, which refuses anything that writes.
 */

/** Tools that change the target system (or execute ABAP on it). */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  // locks and source
  'lock',
  'unLock',
  'unlockAll',
  'setObjectSource',
  'patchObjectSource',
  'editObject',
  'deleteObject',
  'createObject',
  'createInclude',
  'createAndWrite',
  'createTestInclude',
  // class members - one lock/write/activate cycle each
  'addMethod',
  'deleteMethod',
  'addAttribute',
  'createFunctionModule',
  // activation
  'activateObjects',
  'activateByName',
  'activateSafe',
  // transports
  'createTransport',
  'transportDelete',
  'transportRelease',
  'transportSetOwner',
  'transportAddUser',
  'setTransportsConfig',
  'createTransportsConfig',
  // code execution
  'runClass',
  'runSnippet',
  'callFunction',
  'callMethod',
  'unitTestRun',
  'runTests',
  // refactorings that write
  'renameExecute',
  'extractMethodExecute',
  // DDIC contents
  'createDomain',
  'createDataElement',
  'createStructure',
  'setDomainProperties',
  'setDataElementProperties',
  // text elements
  'setTextElements',
  // message classes
  'setMessages',
  'createMessageClass',
  // settings
  'setPrettyPrinterSetting',
  // abapGit
  'gitCreateRepo',
  'gitPullRepo',
  'gitUnlinkRepo',
  'stageRepo',
  'pushRepo',
  'switchRepoBranch',
  // service bindings
  'publishServiceBinding',
  'unPublishServiceBinding',
  // ATC
  'createAtcRun',
  'atcRequestExemption',
  'atcChangeContact',
  // traces
  'tracesSetParameters',
  'tracesCreateConfiguration',
  'tracesDeleteConfiguration',
  'tracesDelete',
  // debugger - attaches to and steps through live sessions
  'debuggerListen',
  'debuggerDeleteListener',
  'debuggerSetBreakpoints',
  'debuggerDeleteBreakpoints',
  'debuggerAttach',
  'debuggerSaveSettings',
  'debuggerStep',
  'debuggerGoToStack',
  'debuggerSetVariableValue'
]);

/**
 * Tools whose effect cannot be taken back from inside the system: they remove
 * objects, requests, repositories or breakpoints rather than changing them.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'deleteObject',
  'deleteMethod',
  'transportDelete',
  'transportRelease',
  'gitUnlinkRepo',
  'unPublishServiceBinding',
  'tracesDelete',
  'tracesDeleteConfiguration',
  'debuggerDeleteBreakpoints',
  'debuggerDeleteListener'
]);

/** Tools that manage the connection itself rather than repository content. */
export const SESSION_TOOLS: ReadonlySet<string> = new Set([
  'login',
  'logout',
  'dropSession'
]);

export const isMutatingTool = (name: string): boolean => MUTATING_TOOLS.has(name);

export const isDestructiveTool = (name: string): boolean => DESTRUCTIVE_TOOLS.has(name);

/**
 * A failed call that must not be replayed automatically: either it may have
 * already taken effect, or its lock handle is void after a re-login.
 */
export const isReplayable = (name: string): boolean =>
  !MUTATING_TOOLS.has(name) && !SESSION_TOOLS.has(name);
